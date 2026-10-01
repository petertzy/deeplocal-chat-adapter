import * as vscode from 'vscode';
import { getAgentTools, invokeAgentTool, toolResultsToMessages } from './agent-tools';
import { getConfig } from './config';
import { DeepLocalClient } from './deeplocal-client';
import { Logger } from './logger';
import { ChatMessage, ToolCall } from './protocol';

interface WebviewMessage {
  type: 'ready' | 'send' | 'stop' | 'approval' | 'preview' | 'refreshModels' | 'newSession' | 'switchSession' | 'deleteSession' | 'setBackend' | 'setRemoteApiKey' | 'clearRemoteApiKey';
  approvalId?: string;
  approved?: boolean;
  text?: string;
  model?: string;
  sessionId?: string;
  useAgent?: boolean;
}

interface PersistedChatItem {
  role: 'You' | 'DeepLocal' | 'Tool';
  text: string;
}

interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  history: ChatMessage[];
  transcript: PersistedChatItem[];
}

export class ChatPanel implements vscode.WebviewViewProvider {
  private static readonly historyKey = 'deeplocal.chat.history';
  private static readonly transcriptKey = 'deeplocal.chat.transcript';
  private static readonly sessionsKey = 'deeplocal.sessions';
  private static readonly activeSessionKey = 'deeplocal.activeSessionId';
  private static readonly migrationKey = 'deeplocal.sessions.migrated.v1';

  private sessions: ChatSession[] = [];
  private activeSessionId: string;
  private activeRequestId: string | undefined;
  private taskController: AbortController | undefined;
  private pendingApproval: { id: string; resolve: (approved: boolean) => void; preview?: () => Promise<void> } | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private view: vscode.WebviewView | undefined;
  private readonly scopedSessionsKey = `${ChatPanel.sessionsKey}.${workspaceIdentity()}`;
  private readonly scopedActiveSessionKey = `${ChatPanel.activeSessionKey}.${workspaceIdentity()}`;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: DeepLocalClient,
    private readonly logger: Logger,
    private readonly remoteApiKey: {
      get: () => PromiseLike<string | undefined>;
      set: (key: string) => Promise<void>;
      clear: () => Promise<void>;
    },
  ) {
    this.sessions = this.loadSessions().map(repairTranscript);
    this.activeSessionId = this.context.workspaceState.get<string>(this.scopedActiveSessionKey, this.sessions[0].id);
    if (!this.sessions.some((session) => session.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0].id;
    }
  }

  async newSession(): Promise<void> {
    if (this.activeRequestId) return;

    const session = createSession();
    this.sessions.unshift(session);
    this.activeSessionId = session.id;
    await this.persist();
    this.postSessions();
    this.restoreTranscript();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
    };
    view.webview.html = renderHtml(view.webview);
    view.onDidDispose(() => {
      this.stopTask();
      this.view = undefined;
    });

    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message).catch((error) => this.postError(messageOf(error)));
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'stop') { this.stopTask(); return; }
    if (message.type === 'approval' || message.type === 'preview') {
      const pending = this.pendingApproval;
      if (!pending || pending.id !== message.approvalId) return;
      if (message.type === 'preview') {
        try { await pending.preview?.(); } catch (error) { this.postError(messageOf(error)); }
      } else pending.resolve(message.approved === true);
      return;
    }
    if (this.activeRequestId) return;
    if (message.type === 'setBackend') {
      const selected = await vscode.window.showQuickPick([
        { label: 'Local DeepLocal', description: 'http://127.0.0.1:14567/v1', value: 'local' },
        { label: 'Remote OpenAI-compatible API', description: 'May incur provider charges', value: 'remote' },
      ], { placeHolder: 'Choose inference backend' });
      if (selected) {
        await vscode.workspace.getConfiguration('deeplocal').update('backend', selected.value, vscode.ConfigurationTarget.Global);
        await this.sendModels();
      }
      return;
    }
    if (message.type === 'setRemoteApiKey') {
      const key = await vscode.window.showInputBox({
        prompt: 'Remote API key (stored securely in VS Code SecretStorage)',
        password: true,
        ignoreFocusOut: true,
        placeHolder: 'Paste API key',
      });
      if (key !== undefined) {
        const normalizedKey = key.trim();
        if (!normalizedKey) {
          this.post({ type: 'error', message: 'API key cannot be empty.' });
          return;
        }
        await this.remoteApiKey.set(normalizedKey);
        await this.sendModels();
        this.post({ type: 'notice', message: 'Remote API key stored securely.' });
      }
      return;
    }
    if (message.type === 'clearRemoteApiKey') {
      await this.remoteApiKey.clear();
      this.post({ type: 'notice', message: 'Remote API key cleared.' });
      return;
    }
    if (message.type === 'ready' || message.type === 'refreshModels') {
      await this.sendModels();
      this.postSessions();
      this.restoreTranscript();
      return;
    }

    if (message.type === 'switchSession' && message.sessionId) {
      if (!this.sessions.some((session) => session.id === message.sessionId)) return;
      this.activeSessionId = message.sessionId;
      await this.persist();
      this.postSessions();
      this.restoreTranscript();
      return;
    }

    if (message.type === 'newSession') {
      await this.newSession();
      return;
    }

    if (message.type === 'deleteSession') {
      await this.deleteSession(message.sessionId);
      return;
    }

    if (message.type !== 'send') {
      return;
    }

    const text = message.text?.trim();
    const model = message.model?.trim();
    if (!text || !model) {
      return;
    }

    await this.sendPrompt(model, text, message.useAgent !== false);
  }

  private async sendModels(): Promise<void> {
    try {
      const models = await this.client.listModels();
      this.post({
        type: 'models',
        models: models.map((model) => model.id),
        backend: getConfig().backend,
        hasApiKey: getConfig().backend === 'remote' ? Boolean(await this.remoteApiKey.get()) : false,
        baseUrl: getConfig().baseUrl,
      });
    } catch (error) {
      this.postError(`Failed to load ${getConfig().backend === 'remote' ? 'remote' : 'DeepLocal'} models: ${messageOf(error)}`);
    }
  }

  private async sendPrompt(model: string, text: string, useAgent: boolean): Promise<void> {
    const information = this.client.modelInformation(model);
    if (useAgent && !information.toolCalling) {
      this.postError(`${information.reason} Select a tool-capable model for Agent mode, or choose Chat mode.`);
      this.post({ type: 'assistantDone' });
      return;
    }
    if (useAgent && !vscode.workspace.workspaceFolders?.length) {
      this.postError('Open a project folder in VS Code before starting an agent task.');
      this.post({ type: 'assistantDone' });
      return;
    }
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.activeRequestId = requestId;
    const controller = new AbortController();
    this.taskController = controller;
    const userMessage = text;
    const session = this.activeSession();
    const assistantItem: PersistedChatItem = { role: 'DeepLocal', text: '' };
    let answer = '';
    try {
      session.history.push({ role: 'user', content: userMessage });
      session.transcript.push({ role: 'You', text });
      if (session.transcript.length === 1) {
        session.title = makeTitle(text);
      }
      session.updatedAt = Date.now();
      await this.persist();
      this.postSessions();

      session.transcript.push(assistantItem);
      await this.persist();

      this.post({ type: 'assistantStart' });

      const messages = [...session.history];
      if ((useAgent || getConfig().injectSystemPrompt) && messages[0]?.role !== 'system') {
        messages.unshift({
          role: 'system',
          content: [
            'You are DeepLocal, a coding assistant inside VS Code.',
            useAgent ? 'You are in Agent mode. Execute requested work using tools, then report actual results. Do not print full file contents in chat when asked to implement something.' : 'You are in Chat mode. Explain and discuss; no file changes or commands are available.',
            'Inspect the workspace before changing files. Paths are relative to the workspace root.',
            'When asked to create a new file, use create_file with an appropriate new path. Never replace the active file merely because it is open.',
            'Read existing files before editing. Use replace_in_file for targeted changes; write_file for intentional full replacements.',
            'Use get_active_file and get_selection before editing the active editor when relevant.',
            'Use get_diagnostics after edits when the user asks you to fix errors.',
            'Prefer small targeted edits. Explain what changed after tools finish.',
            'Ask before destructive work; file write and command tools already require user confirmation.',
            'After creating a file, use open_file if appropriate. Check diagnostics or run relevant tests. Report whether verification actually ran.',
            'If a tool fails or is declined, respect that result and never claim that the action succeeded. Answer in the user’s language.',
          ].join('\n'),
        });
      }

      const onDelta = (delta: string) => {
        controller.signal.throwIfAborted();
        assistantItem.text += delta;
        session.updatedAt = Date.now();
        this.schedulePersist();
      };
      controller.signal.throwIfAborted();
      answer = useAgent
        ? await this.runAgentRequest(requestId, model, messages, onDelta, controller.signal, session)
        : await this.runChatRequest(requestId, model, messages, onDelta);
      controller.signal.throwIfAborted();

      session.history.push({ role: 'assistant', content: answer });
      assistantItem.text = answer;
      this.post({ type: 'assistantFinal', text: answer });
      session.updatedAt = Date.now();
      await this.persist();
      this.postSessions();
    } catch (error) {
      if (controller.signal.aborted) {
        this.post({ type: 'notice', message: 'Task stopped. Already applied changes are retained.' });
      } else {
        this.logger.error(`DeepLocal chat failed: ${messageOf(error)}`);
        this.postError(`DeepLocal chat failed: ${messageOf(error)}`);
      }
      if (!assistantItem.text.trim()) {
        session.transcript = session.transcript.filter((item) => item !== assistantItem);
      }
      await this.persist();
    } finally {
      this.activeRequestId = undefined;
      this.taskController = undefined;
      this.post({ type: 'assistantDone' });
    }
  }

  private async runChatRequest(
    requestId: string,
    model: string,
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
  ): Promise<string> {
    let answer = '';
    for await (const event of this.client.streamChat(requestId, {
      model,
      messages,
      stream: true,
      max_tokens: getConfig().maxOutputTokens,
    })) {
      if (event.kind !== 'text') {
        continue;
      }
      answer += event.value;
      onDelta(event.value);
      this.post({ type: 'assistantDelta', text: event.value });
    }
    return answer;
  }

  private async runAgentRequest(
    requestId: string,
    model: string,
    messages: ChatMessage[],
    onDelta: (delta: string) => void,
    signal: AbortSignal,
    session: ChatSession,
  ): Promise<string> {
    const workingMessages = [...messages];
    let finalAnswer = '';

    for (let turn = 0; turn < getConfig().agentMaxTurns; turn += 1) {
      signal.throwIfAborted();
      this.post({ type: 'status', message: `Working · step ${turn + 1}/${getConfig().agentMaxTurns}` });
      let answer = '';
      const toolCalls: ToolCall[] = [];

      for await (const event of this.client.streamChat(requestId, {
        model,
        messages: workingMessages,
        stream: true,
        max_tokens: getConfig().maxOutputTokens,
        tools: getAgentTools(),
        tool_choice: 'auto',
      })) {
        if (event.kind === 'text') {
          answer += event.value;
          onDelta(event.value);
          this.post({ type: 'assistantDelta', text: event.value });
        } else {
          toolCalls.push(event.value);
        }
      }

      if (!toolCalls.length) {
        finalAnswer = answer;
        if (!finalAnswer.trim()) throw new Error('The model returned no answer or tool actions. Retry or choose another model.');
        break;
      }

      workingMessages.push({
        role: 'assistant',
        content: answer || null,
        tool_calls: toolCalls,
      });

      const results = [];
      for (const call of toolCalls) {
        if (signal.aborted) {
          results.push({ callId: call.id, name: call.function.name, content: 'Task stopped; tool was not executed.' });
          continue;
        }
        this.post({ type: 'status', message: `Running ${call.function.name}…` });
        const result = await invokeAgentTool(call.id, call.function.name, call.function.arguments, {
          signal,
          approve: (message, preview) => this.requestApproval(message, signal, preview),
        });
        results.push(result);
        const text = `${call.function.name}\n${result.content}`;
        session.transcript.push({ role: 'Tool', text });
        this.post({ type: 'toolResult', text });
        await this.persist();
      }
      workingMessages.push(...toolResultsToMessages(results));
      // Preserve complete assistant/tool groups for follow-up requests.
      session.history.push(...workingMessages.slice(workingMessages.length - results.length - 1));
      signal.throwIfAborted();
    }

    if (!finalAnswer) throw new Error('Agent step limit reached. Work may be incomplete; review the tool results and ask to continue.');
    return finalAnswer;
  }

  private stopTask(): void {
    this.taskController?.abort();
    if (this.activeRequestId) this.client.cancel(this.activeRequestId);
    this.pendingApproval?.resolve(false);
  }

  private requestApproval(message: string, signal: AbortSignal, preview?: () => Promise<void>): Promise<boolean> {
    signal.throwIfAborted();
    return new Promise((resolve) => {
      const id = createId();
      const finish = (approved: boolean) => {
        signal.removeEventListener('abort', onAbort);
        this.pendingApproval = undefined;
        this.post({ type: 'approvalDone', approvalId: id });
        resolve(approved);
      };
      const onAbort = () => finish(false);
      this.pendingApproval = { id, resolve: finish, preview };
      signal.addEventListener('abort', onAbort, { once: true });
      this.post({ type: 'approval', approvalId: id, message, hasPreview: Boolean(preview) });
    });
  }

  private postError(message: string): void {
    this.post({ type: 'error', message });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }

  private restoreTranscript(): void {
    const session = repairTranscript(this.activeSession());
    this.post({ type: 'restore', items: session.transcript });
  }

  private postSessions(): void {
    this.post({
      type: 'sessions',
      activeSessionId: this.activeSessionId,
      sessions: this.sessions.map((session) => ({
        id: session.id,
        title: session.title,
        updatedAt: session.updatedAt,
      })),
    });
  }

  private async persist(): Promise<void> {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    for (const session of this.sessions) {
      repairTranscript(session);
      if (session.history.length > 40) {
        const boundary = session.history.findIndex((message, index) => index >= session.history.length - 40 && message.role === 'user');
        if (boundary > 0) session.history = session.history.slice(boundary);
      }
      session.transcript = session.transcript.slice(-80);
    }
    this.sessions.sort((left, right) => right.updatedAt - left.updatedAt);
    this.sessions = this.sessions.slice(0, 20);
    await this.context.workspaceState.update(this.scopedSessionsKey, this.sessions);
    await this.context.workspaceState.update(this.scopedActiveSessionKey, this.activeSessionId);
  }

  private async deleteSession(sessionId: string | undefined): Promise<void> {
    const target = this.sessions.find((session) => session.id === sessionId);
    if (!target) {
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Delete DeepLocal session "${target.title}"?`,
      { modal: true },
      'Delete',
    );
    if (choice !== 'Delete') {
      return;
    }

    this.sessions = this.sessions.filter((session) => session.id !== target.id);
    if (!this.sessions.length) {
      this.sessions.push(createSession());
    }

    if (this.activeSessionId === target.id) {
      this.activeSessionId = this.sessions[0].id;
    }

    await this.persist();
    this.postSessions();
    this.restoreTranscript();
  }

  private schedulePersist(): void {
    if (this.persistTimer) {
      return;
    }

    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persist();
    }, 750);
  }

  private activeSession(): ChatSession {
    let session = this.sessions.find((item) => item.id === this.activeSessionId);
    if (!session) {
      session = createSession();
      this.sessions.unshift(session);
      this.activeSessionId = session.id;
    }
    return session;
  }

  private loadSessions(): ChatSession[] {
    const sessions = this.context.workspaceState.get<ChatSession[]>(this.scopedSessionsKey, []);
    if (sessions.length) {
      return sessions;
    }

    // workspaceState is deliberately the source of truth. Migrate the old global
    // values only when this workspace has no scoped data yet. Since the old
    // format had no workspace identity, it is assigned to the first workspace
    // opened after upgrade; the original values are retained for recovery.
    const oldSessions = this.context.globalState.get<ChatSession[]>(ChatPanel.sessionsKey, []);
    const oldHistory = this.context.globalState.get<ChatMessage[]>(ChatPanel.historyKey, []);
    const oldTranscript = this.context.globalState.get<PersistedChatItem[]>(ChatPanel.transcriptKey, []);
    const migrated = this.context.globalState.get<boolean>(ChatPanel.migrationKey, false);
    if (!migrated && oldSessions.length) {
      void this.context.workspaceState.update(this.scopedSessionsKey, oldSessions);
      void this.context.globalState.update(ChatPanel.migrationKey, true);
      return oldSessions;
    }
    if (oldHistory.length || oldTranscript.length) {
      const migratedSession = {
        id: createId(),
        title: oldTranscript[0]?.text ? makeTitle(oldTranscript[0].text) : 'Previous session',
        updatedAt: Date.now(),
        history: oldHistory,
        transcript: oldTranscript,
      };
      void this.context.workspaceState.update(this.scopedSessionsKey, [migratedSession]);
      void this.context.globalState.update(ChatPanel.migrationKey, true);
      return [migratedSession];
    }

    return [createSession()];
  }

}

/** Stable scope used by persistence and diagnostics. Empty windows intentionally
 * share one scope because VS Code gives them no durable workspace identity. */
export function workspaceIdentity(workspace: Pick<typeof vscode.workspace, 'workspaceFile' | 'workspaceFolders'> = vscode.workspace): string {
  if (workspace.workspaceFile) {
    return `workspace:${workspace.workspaceFile.toString()}`;
  }
  const folders = workspace.workspaceFolders?.map((folder) => folder.uri.toString()).sort();
  return folders?.length ? `folders:${folders.join('|')}` : 'empty';
}

function createSession(): ChatSession {
  return {
    id: createId(),
    title: 'New session',
    updatedAt: Date.now(),
    history: [],
    transcript: [],
  };
}

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function makeTitle(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 42 ? `${compact.slice(0, 39)}...` : compact || 'New session';
}

function repairTranscript(session: ChatSession): ChatSession {
  const assistantTranscriptCount = session.transcript.filter((item) => item.role === 'DeepLocal').length;
  const assistantHistory = session.history
    .filter((message) => message.role === 'assistant' && !message.tool_calls?.length && typeof message.content === 'string' && message.content.trim())
    .map((message) => message.content as string);

  if (assistantTranscriptCount >= assistantHistory.length) {
    return session;
  }

  const rebuilt: PersistedChatItem[] = [];
  let visibleUserIndex = 0;
  let visibleAssistantIndex = 0;
  const visibleUsers = session.transcript.filter((item) => item.role === 'You');

  for (const message of session.history) {
    if (message.role === 'user') {
      const visible = visibleUsers[visibleUserIndex];
      visibleUserIndex += 1;
      rebuilt.push(visible ?? { role: 'You', text: summarizeUserMessage(message.content) });
    }

    if (message.role === 'assistant' && !message.tool_calls?.length && typeof message.content === 'string' && message.content.trim()) {
      rebuilt.push({ role: 'DeepLocal', text: assistantHistory[visibleAssistantIndex] });
      visibleAssistantIndex += 1;
    }
  }

  session.transcript = rebuilt.length ? rebuilt : session.transcript;
  return session;
}

function summarizeUserMessage(content: string | null | undefined): string {
  if (!content) {
    return '';
  }

  const firstLine = content.split(/\r?\n/).find((line) => line.trim());
  return firstLine?.trim() ?? '';
}

function renderHtml(webview: vscode.Webview): string {
  const nonce = Math.random().toString(36).slice(2);

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DeepLocal</title>
  <style>
    body {
      margin: 0;
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
    }
    .shell {
      display: grid;
      grid-template-rows: minmax(0, 1fr) auto;
      height: 100vh;
    }
    select, textarea, button {
      font: inherit;
    }
    select, textarea {
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border);
    }
    select {
      width: 100%;
      height: 30px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    button {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      padding: 7px 10px;
      cursor: pointer;
    }
    button:disabled {
      opacity: 0.6;
      cursor: default;
    }
    main {
      overflow: auto;
      padding: 10px;
    }
    .message {
      white-space: pre-wrap;
      line-height: 1.45;
      margin: 0 0 8px;
      padding: 8px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
    }
    .role {
      font-size: 11px;
      text-transform: uppercase;
      opacity: 0.7;
      margin-bottom: 6px;
    }
    footer {
      display: grid;
      grid-template-columns: 1fr;
      gap: 6px;
      padding: 8px;
      border-top: 1px solid var(--vscode-panel-border);
    }
    .controls {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 6px;
    }
    .session-row {
      display: grid;
      grid-template-columns: 1fr auto auto;
      gap: 6px;
    }
    .backend-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 6px;
      font-size: 12px;
      opacity: 0.9;
    }
    .actions {
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 6px;
    }
    .options {
      display: grid;
      grid-template-columns: 1fr;
      gap: 4px;
    }
    label.option {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      opacity: 0.9;
      user-select: none;
    }
    textarea {
      min-height: 64px;
      resize: vertical;
      padding: 8px;
    }
    .error {
      color: var(--vscode-errorForeground);
    }
    #status { font-size: 12px; color: var(--vscode-descriptionForeground); }
    .tool { white-space: normal; }
    .tool pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 240px; overflow: auto; }
    .approval { border-color: var(--vscode-focusBorder); }
    .approval button { margin: 8px 6px 0 0; }
    [hidden] { display: none !important; }
    summary { cursor: pointer; }
  </style>
</head>
<body>
  <div class="shell">
    <main id="messages" aria-label="Conversation"></main>
    <footer>
      <div class="session-row">
        <select id="session"></select>
        <button id="newSession">New</button>
        <button id="deleteSession">Delete</button>
      </div>
      <div class="backend-row">
        <span id="backendLabel">Backend: Local DeepLocal</span>
        <button id="backendButton">Change</button>
      </div>
      <div class="backend-row" id="remoteKeyRow" hidden>
        <span id="remoteKeyStatus">Remote API key not set</span>
        <button id="setRemoteKeyButton">Set API key</button>
        <button id="clearRemoteKeyButton">Clear</button>
      </div>
      <div id="status" role="status" aria-live="polite">Ready · Agent can inspect, create and edit workspace files.</div>
      <textarea id="prompt" aria-label="Task" placeholder="Describe a task, e.g. Create snake.html with a playable snake game…"></textarea>
      <div class="controls">
        <select id="model"></select>
        <button id="refresh">Refresh</button>
      </div>
      <div class="actions">
        <button id="restoreSession">Reload</button>
        <button id="send">Send</button>
        <button id="stop" hidden>Stop</button>
      </div>
      <div class="options">
        <label class="option">
          <input id="useAgent" type="checkbox" checked>
          <span>Agent mode · inspect → review → apply → verify</span>
        </label>
        <small>Turn off for chat only. File changes and commands require approval below.</small>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const model = document.getElementById('model');
    const session = document.getElementById('session');
    const refresh = document.getElementById('refresh');
    const messages = document.getElementById('messages');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const newSession = document.getElementById('newSession');
    const deleteSession = document.getElementById('deleteSession');
    const restoreSession = document.getElementById('restoreSession');
    const backendButton = document.getElementById('backendButton');
    const backendLabel = document.getElementById('backendLabel');
    const remoteKeyRow = document.getElementById('remoteKeyRow');
    const remoteKeyStatus = document.getElementById('remoteKeyStatus');
    const setRemoteKeyButton = document.getElementById('setRemoteKeyButton');
    const clearRemoteKeyButton = document.getElementById('clearRemoteKeyButton');
    const useAgent = document.getElementById('useAgent');
    const stop = document.getElementById('stop');
    const status = document.getElementById('status');
    const approvals = new Map();
    let busy = false;
    let currentAssistant;
    let activeSessionId;
    let pendingPrompt;
    const drafts = new Map();

    function setBusy(value) {
      busy = value;
      for (const control of [send, session, newSession, deleteSession, restoreSession, backendButton, refresh, model, useAgent, setRemoteKeyButton, clearRemoteKeyButton]) control.disabled = value;
      stop.hidden = !value;
      status.textContent = value ? 'Working…' : 'Ready';
    }

    function addTool(text) {
      const item = document.createElement('details');
      item.className = 'message tool';
      const title = document.createElement('summary');
      const lines = text.split('\\n');
      title.textContent = lines[0] + (lines[1] ? ' · ' + lines[1].slice(0, 160) : '');
      const output = document.createElement('pre');
      output.textContent = text.substring(text.indexOf('\\n') + 1);
      item.append(title, output);
      messages.append(item);
      messages.scrollTop = messages.scrollHeight;
    }

    function addMessage(role, text, className) {
      const item = document.createElement('section');
      item.className = 'message' + (className ? ' ' + className : '');
      const label = document.createElement('div');
      label.className = 'role';
      label.textContent = role;
      const body = document.createElement('div');
      body.textContent = text;
      item.append(label, body);
      messages.append(item);
      messages.scrollTop = messages.scrollHeight;
      return body;
    }

    window.addEventListener('message', (event) => {
      const msg = event.data;
      if (msg.type === 'models') {
        const remote = msg.backend === 'remote';
        document.title = remote ? 'Remote OpenAI-compatible API' : 'Local DeepLocal';
        backendLabel.textContent = remote ? 'Backend: Remote OpenAI-compatible API' : 'Backend: Local DeepLocal';
        remoteKeyRow.hidden = !remote;
        remoteKeyStatus.textContent = msg.hasApiKey ? 'Remote API key is set' : 'Remote API key not set';
        setRemoteKeyButton.textContent = msg.hasApiKey ? 'Update API key' : 'Set API key';
        model.setAttribute('aria-label', remote ? 'Remote API model' : 'DeepLocal model');
        model.replaceChildren(...msg.models.map((id) => {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = id;
          return option;
        }));
      }
      if (msg.type === 'sessions') {
        if (activeSessionId && activeSessionId !== msg.activeSessionId) {
          drafts.set(activeSessionId, prompt.value);
        }
        activeSessionId = msg.activeSessionId;
        session.replaceChildren(...msg.sessions.map((item) => {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = item.title;
          option.selected = item.id === msg.activeSessionId;
          return option;
        }));
        if (!pendingPrompt) {
          prompt.value = drafts.get(activeSessionId) || '';
        }
      }
      if (msg.type === 'restore') {
        messages.replaceChildren();
        for (const item of msg.items) {
          if (item.role === 'Tool') addTool(item.text);
          else addMessage(item.role, item.text);
        }
      }
      if (msg.type === 'status') status.textContent = msg.message;
      if (msg.type === 'toolResult') addTool(msg.text);
      if (msg.type === 'approval') {
        status.textContent = 'Waiting for your approval';
        const body = addMessage('Review action', msg.message, 'approval');
        approvals.set(msg.approvalId, body);
        const actions = msg.hasPreview ? ['Preview diff', 'Approve', 'Reject'] : ['Approve', 'Reject'];
        for (const action of actions) {
          const button = document.createElement('button');
          button.textContent = action;
          button.addEventListener('click', () => {
            const preview = action === 'Preview diff';
            vscode.postMessage({ type: preview ? 'preview' : 'approval', approvalId: msg.approvalId, approved: action === 'Approve' });
            if (!preview) for (const element of body.querySelectorAll('button')) element.disabled = true;
          });
          body.append(button);
        }
        messages.scrollTop = messages.scrollHeight;
      }
      if (msg.type === 'approvalDone') {
        const body = approvals.get(msg.approvalId);
        if (body) body.parentElement.remove();
        approvals.delete(msg.approvalId);
      }
      if (msg.type === 'assistantStart') {
        currentAssistant = addMessage('DeepLocal', '');
        setBusy(true);
      }
      if (msg.type === 'assistantFinal' && currentAssistant) currentAssistant.textContent = msg.text;
      if (msg.type === 'assistantDelta' && currentAssistant) {
        currentAssistant.textContent += msg.text;
        messages.scrollTop = messages.scrollHeight;
      }
      if (msg.type === 'assistantDone') {
        if (pendingPrompt !== undefined && prompt.value.trim() === pendingPrompt) {
          prompt.value = '';
          drafts.delete(activeSessionId);
        }
        pendingPrompt = undefined;
        setBusy(false);
        currentAssistant = undefined;
      }
      if (msg.type === 'error') {
        addMessage('Error', msg.message, 'error');
        // Keep the submitted text in the composer so it can be edited or
        // retried. The prompt is only consumed after a successful response.
        pendingPrompt = undefined;
      }
      if (msg.type === 'notice') {
        addMessage('DeepLocal', msg.message);
      }
    });

    send.addEventListener('click', () => {
      const text = prompt.value.trim();
      if (busy || !text || !model.value) {
        return;
      }
      setBusy(true);
      addMessage('You', text);
      drafts.set(activeSessionId, prompt.value);
      pendingPrompt = text;
      vscode.postMessage({
        type: 'send',
        text,
        model: model.value,
        useAgent: useAgent.checked,
      });
    });
    stop.addEventListener('click', () => {
      status.textContent = 'Stopping…';
      vscode.postMessage({ type: 'stop' });
    });

    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send.click();
      }
    });

    refresh.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
    backendButton.addEventListener('click', () => vscode.postMessage({ type: 'setBackend' }));
    setRemoteKeyButton.addEventListener('click', () => vscode.postMessage({ type: 'setRemoteApiKey' }));
    clearRemoteKeyButton.addEventListener('click', () => vscode.postMessage({ type: 'clearRemoteApiKey' }));
    newSession.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    deleteSession.addEventListener('click', () => vscode.postMessage({ type: 'deleteSession', sessionId: session.value }));
    restoreSession.addEventListener('click', () => vscode.postMessage({ type: 'switchSession', sessionId: session.value }));
    session.addEventListener('change', () => vscode.postMessage({ type: 'switchSession', sessionId: session.value }));
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
