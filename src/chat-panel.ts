import * as vscode from 'vscode';
import { getAgentTools, invokeAgentTool, toolResultsToMessages } from './agent-tools';
import { getConfig } from './config';
import { DeepLocalClient } from './deeplocal-client';
import { Logger } from './logger';
import { ChatMessage, ToolCall } from './protocol';

interface WebviewMessage {
  type: 'ready' | 'send' | 'refreshModels' | 'newSession' | 'switchSession';
  text?: string;
  model?: string;
  sessionId?: string;
  useAgent?: boolean;
  editActiveFile?: boolean;
}

interface PersistedChatItem {
  role: 'You' | 'DeepLocal';
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

  private sessions: ChatSession[] = [];
  private activeSessionId: string;
  private activeRequestId: string | undefined;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly client: DeepLocalClient,
    private readonly logger: Logger,
  ) {
    this.sessions = this.loadSessions().map(repairTranscript);
    this.activeSessionId = this.context.globalState.get<string>(ChatPanel.activeSessionKey, this.sessions[0].id);
    if (!this.sessions.some((session) => session.id === this.activeSessionId)) {
      this.activeSessionId = this.sessions[0].id;
    }
  }

  async newSession(): Promise<void> {
    if (this.activeRequestId) {
      this.client.cancel(this.activeRequestId);
      this.activeRequestId = undefined;
    }

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
      if (this.activeRequestId) {
        this.client.cancel(this.activeRequestId);
      }
      this.view = undefined;
    });

    view.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === 'ready' || message.type === 'refreshModels') {
      await this.sendModels();
      this.postSessions();
      this.restoreTranscript();
      return;
    }

    if (message.type === 'switchSession' && message.sessionId) {
      this.activeSessionId = message.sessionId;
      await this.context.globalState.update(ChatPanel.activeSessionKey, this.activeSessionId);
      this.postSessions();
      this.restoreTranscript();
      return;
    }

    if (message.type === 'newSession') {
      await this.newSession();
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

    await this.sendPrompt(model, text, Boolean(message.useAgent), Boolean(message.editActiveFile));
  }

  private async sendModels(): Promise<void> {
    try {
      const models = await this.client.listModels();
      this.post({
        type: 'models',
        models: models.map((model) => model.id),
      });
    } catch (error) {
      this.postError(`Failed to load DeepLocal models: ${messageOf(error)}`);
    }
  }

  private async sendPrompt(model: string, text: string, useAgent: boolean, editActiveFile: boolean): Promise<void> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.activeRequestId = requestId;
    const activeFile = editActiveFile ? getActiveTextFile() : undefined;
    const userMessage = activeFile ? buildEditPrompt(text, activeFile) : text;
    const session = this.activeSession();
    session.history.push({ role: 'user', content: userMessage });
    session.transcript.push({ role: 'You', text });
    if (session.transcript.length === 1) {
      session.title = makeTitle(text);
    }
    session.updatedAt = Date.now();
    await this.persist();
    this.postSessions();

    const assistantItem: PersistedChatItem = { role: 'DeepLocal', text: '' };
    session.transcript.push(assistantItem);
    await this.persist();

    this.post({ type: 'assistantStart' });

    const messages = [...session.history];
    if (getConfig().injectSystemPrompt && messages[0]?.role !== 'system') {
      messages.unshift({
        role: 'system',
        content: activeFile
          ? 'You are a careful coding assistant. Return only the complete updated file in one fenced code block. Do not add explanations.'
          : [
              'You are DeepLocal, a coding assistant inside VS Code.',
              'Use tools when you need to inspect or modify workspace files.',
              'Use get_active_file and get_selection before editing the active editor when relevant.',
              'Use get_diagnostics after edits when the user asks you to fix errors.',
              'Prefer small targeted edits. Explain what changed after tools finish.',
              'Ask before destructive work; file write and command tools already require user confirmation.',
            ].join('\n'),
      });
    }

    let answer = '';
    try {
      const onDelta = (delta: string) => {
        assistantItem.text += delta;
        session.updatedAt = Date.now();
        this.schedulePersist();
      };
      answer = activeFile
        ? await this.runSimpleEditRequest(requestId, model, messages, onDelta)
        : useAgent
          ? await this.runAgentRequest(requestId, model, messages, onDelta)
          : await this.runSimpleEditRequest(requestId, model, messages, onDelta);

      session.history.push({ role: 'assistant', content: answer });
      assistantItem.text = answer;
      session.updatedAt = Date.now();
      await this.persist();
      this.postSessions();
      this.post({ type: 'assistantDone' });
      if (activeFile) {
        await this.applyGeneratedFile(activeFile, answer);
      }
    } catch (error) {
      this.logger.error(`DeepLocal chat failed: ${messageOf(error)}`);
      this.postError(`DeepLocal chat failed: ${messageOf(error)}`);
      if (!assistantItem.text.trim()) {
        session.transcript = session.transcript.filter((item) => item !== assistantItem);
      }
      await this.persist();
    } finally {
      this.activeRequestId = undefined;
    }
  }

  private async runSimpleEditRequest(
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
  ): Promise<string> {
    const workingMessages = [...messages];
    let finalAnswer = '';

    for (let turn = 0; turn < getConfig().agentMaxTurns; turn += 1) {
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
        break;
      }

      workingMessages.push({
        role: 'assistant',
        content: answer || null,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        this.post({ type: 'notice', message: `Running ${call.function.name}...` });
      }

      const results = [];
      for (const call of toolCalls) {
        results.push(await invokeAgentTool(call.id, call.function.name, call.function.arguments));
      }
      workingMessages.push(...toolResultsToMessages(results));

      this.post({ type: 'assistantStart' });
    }

    return finalAnswer || 'Done.';
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
    this.sessions = this.sessions
      .map(repairTranscript)
      .map((session) => ({
        ...session,
        history: session.history.slice(-40),
        transcript: session.transcript.slice(-80),
      }))
      .sort((left, right) => right.updatedAt - left.updatedAt)
      .slice(0, 20);
    await this.context.globalState.update(ChatPanel.sessionsKey, this.sessions);
    await this.context.globalState.update(ChatPanel.activeSessionKey, this.activeSessionId);
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
    const sessions = this.context.globalState.get<ChatSession[]>(ChatPanel.sessionsKey, []);
    if (sessions.length) {
      return sessions;
    }

    const oldHistory = this.context.globalState.get<ChatMessage[]>(ChatPanel.historyKey, []);
    const oldTranscript = this.context.globalState.get<PersistedChatItem[]>(ChatPanel.transcriptKey, []);
    if (oldHistory.length || oldTranscript.length) {
      return [{
        id: createId(),
        title: oldTranscript[0]?.text ? makeTitle(oldTranscript[0].text) : 'Previous session',
        updatedAt: Date.now(),
        history: oldHistory,
        transcript: oldTranscript,
      }];
    }

    return [createSession()];
  }

  private async applyGeneratedFile(activeFile: ActiveTextFile, answer: string): Promise<void> {
    const nextContent = extractUpdatedFile(answer);
    if (!nextContent) {
      this.postError('DeepLocal did not return a complete file block to apply.');
      return;
    }

    const choice = await vscode.window.showWarningMessage(
      `Apply DeepLocal changes to ${activeFile.document.fileName}?`,
      { modal: true },
      'Apply',
    );

    if (choice !== 'Apply') {
      this.post({ type: 'notice', message: 'File update skipped.' });
      return;
    }

    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      activeFile.document.positionAt(0),
      activeFile.document.positionAt(activeFile.document.getText().length),
    );
    edit.replace(activeFile.document.uri, fullRange, nextContent);

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.postError('VS Code could not apply the generated file update.');
      return;
    }

    await activeFile.document.save();
    this.post({ type: 'notice', message: 'Applied changes to the active file.' });
  }
}

interface ActiveTextFile {
  document: vscode.TextDocument;
  languageId: string;
  content: string;
}

function getActiveTextFile(): ActiveTextFile | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    vscode.window.showWarningMessage('Open a file editor before using DeepLocal file editing.');
    return undefined;
  }

  return {
    document: editor.document,
    languageId: editor.document.languageId,
    content: editor.document.getText(),
  };
}

function buildEditPrompt(instruction: string, file: ActiveTextFile): string {
  return [
    'Update the active file according to this request:',
    instruction,
    '',
    `File path: ${file.document.fileName}`,
    `Language: ${file.languageId}`,
    '',
    'Current file content:',
    `\`\`\`${file.languageId}`,
    file.content,
    '```',
    '',
    'Return only the complete updated file content in a single fenced code block.',
  ].join('\n');
}

function extractUpdatedFile(answer: string): string | undefined {
  const fence = answer.match(/```[^\n\r]*\r?\n([\s\S]*?)\r?\n```/);
  const content = fence?.[1] ?? answer.trim();
  return content.trim().length > 0 ? content : undefined;
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
    .filter((message) => message.role === 'assistant' && typeof message.content === 'string' && message.content.trim())
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

    if (message.role === 'assistant' && typeof message.content === 'string' && message.content.trim()) {
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
      grid-template-rows: 1fr auto;
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
      grid-template-columns: 1fr auto;
      gap: 6px;
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
  </style>
</head>
<body>
  <div class="shell">
    <main id="messages"></main>
    <footer>
      <div class="session-row">
        <select id="session"></select>
        <button id="newSession">New</button>
      </div>
      <textarea id="prompt" placeholder="Ask DeepLocal..."></textarea>
      <div class="controls">
        <select id="model"></select>
        <button id="refresh">Refresh</button>
      </div>
      <div class="actions">
        <button id="restoreSession">Reload</button>
        <button id="send">Send</button>
      </div>
      <div class="options">
        <label class="option">
          <input id="useAgent" type="checkbox" checked>
          <span>Agent tools</span>
        </label>
        <label class="option">
          <input id="editActiveFile" type="checkbox" checked>
          <span>Edit active file</span>
        </label>
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
    const restoreSession = document.getElementById('restoreSession');
    const useAgent = document.getElementById('useAgent');
    const editActiveFile = document.getElementById('editActiveFile');
    let currentAssistant;

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
        model.replaceChildren(...msg.models.map((id) => {
          const option = document.createElement('option');
          option.value = id;
          option.textContent = id;
          return option;
        }));
      }
      if (msg.type === 'sessions') {
        session.replaceChildren(...msg.sessions.map((item) => {
          const option = document.createElement('option');
          option.value = item.id;
          option.textContent = item.title;
          option.selected = item.id === msg.activeSessionId;
          return option;
        }));
      }
      if (msg.type === 'restore') {
        messages.replaceChildren();
        for (const item of msg.items) {
          addMessage(item.role, item.text);
        }
      }
      if (msg.type === 'assistantStart') {
        currentAssistant = addMessage('DeepLocal', '');
        send.disabled = true;
      }
      if (msg.type === 'assistantDelta' && currentAssistant) {
        currentAssistant.textContent += msg.text;
        messages.scrollTop = messages.scrollHeight;
      }
      if (msg.type === 'assistantDone') {
        send.disabled = false;
        currentAssistant = undefined;
      }
      if (msg.type === 'error') {
        addMessage('Error', msg.message, 'error');
        send.disabled = false;
      }
      if (msg.type === 'notice') {
        addMessage('DeepLocal', msg.message);
      }
    });

    send.addEventListener('click', () => {
      const text = prompt.value.trim();
      if (!text || !model.value) {
        return;
      }
      addMessage('You', text);
      prompt.value = '';
      vscode.postMessage({
        type: 'send',
        text,
        model: model.value,
        useAgent: useAgent.checked,
        editActiveFile: editActiveFile.checked,
      });
    });

    prompt.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        send.click();
      }
    });

    refresh.addEventListener('click', () => vscode.postMessage({ type: 'refreshModels' }));
    newSession.addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
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
