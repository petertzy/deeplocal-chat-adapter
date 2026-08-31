import * as vscode from 'vscode';
import { getAgentTools, invokeAgentTool, toolResultsToMessages } from './agent-tools';
import { getConfig } from './config';
import { DeepLocalClient } from './deeplocal-client';
import { Logger } from './logger';
import { ChatMessage, ToolCall } from './protocol';

interface WebviewMessage {
  type: 'ready' | 'send' | 'refreshModels' | 'clear';
  text?: string;
  model?: string;
  useAgent?: boolean;
  editActiveFile?: boolean;
}

export class ChatPanel implements vscode.WebviewViewProvider {
  private readonly history: ChatMessage[] = [];
  private activeRequestId: string | undefined;
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly client: DeepLocalClient,
    private readonly logger: Logger,
  ) {}

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
      return;
    }

    if (message.type === 'clear') {
      this.history.length = 0;
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
    this.history.push({ role: 'user', content: userMessage });

    this.post({ type: 'assistantStart' });

    const messages = [...this.history];
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
      answer = activeFile
        ? await this.runSimpleEditRequest(requestId, model, messages)
        : useAgent
          ? await this.runAgentRequest(requestId, model, messages)
          : await this.runSimpleEditRequest(requestId, model, messages);

      this.history.push({ role: 'assistant', content: answer });
      this.post({ type: 'assistantDone' });
      if (activeFile) {
        await this.applyGeneratedFile(activeFile, answer);
      }
    } catch (error) {
      this.logger.error(`DeepLocal chat failed: ${messageOf(error)}`);
      this.postError(`DeepLocal chat failed: ${messageOf(error)}`);
    } finally {
      this.activeRequestId = undefined;
    }
  }

  private async runSimpleEditRequest(requestId: string, model: string, messages: ChatMessage[]): Promise<string> {
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
      this.post({ type: 'assistantDelta', text: event.value });
    }
    return answer;
  }

  private async runAgentRequest(requestId: string, model: string, messages: ChatMessage[]): Promise<string> {
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
      <textarea id="prompt" placeholder="Ask DeepLocal..."></textarea>
      <div class="controls">
        <select id="model"></select>
        <button id="refresh">Refresh</button>
      </div>
      <div class="actions">
        <button id="clear">Clear</button>
        <button id="send">Send</button>
      </div>
      <div class="options">
        <label class="option">
          <input id="useAgent" type="checkbox" checked>
          <span>Agent tools</span>
        </label>
        <label class="option">
          <input id="editActiveFile" type="checkbox">
          <span>Edit active file</span>
        </label>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const model = document.getElementById('model');
    const refresh = document.getElementById('refresh');
    const messages = document.getElementById('messages');
    const prompt = document.getElementById('prompt');
    const send = document.getElementById('send');
    const clear = document.getElementById('clear');
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
    clear.addEventListener('click', () => {
      messages.replaceChildren();
      vscode.postMessage({ type: 'clear' });
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
