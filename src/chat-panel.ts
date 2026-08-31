import * as vscode from 'vscode';
import { getConfig } from './config';
import { DeepLocalClient } from './deeplocal-client';
import { Logger } from './logger';
import { ChatMessage } from './protocol';

interface WebviewMessage {
  type: 'ready' | 'send' | 'refreshModels' | 'clear';
  text?: string;
  model?: string;
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

    await this.sendPrompt(model, text);
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

  private async sendPrompt(model: string, text: string): Promise<void> {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.activeRequestId = requestId;
    this.history.push({ role: 'user', content: text });

    this.post({ type: 'assistantStart' });

    const messages = [...this.history];
    if (getConfig().injectSystemPrompt && messages[0]?.role !== 'system') {
      messages.unshift({
        role: 'system',
        content: 'You are a concise assistant. Reply in the same language as the user unless asked otherwise.',
      });
    }

    let answer = '';
    try {
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

      this.history.push({ role: 'assistant', content: answer });
      this.post({ type: 'assistantDone' });
    } catch (error) {
      this.logger.error(`DeepLocal chat failed: ${messageOf(error)}`);
      this.postError(`DeepLocal chat failed: ${messageOf(error)}`);
    } finally {
      this.activeRequestId = undefined;
    }
  }

  private postError(message: string): void {
    this.post({ type: 'error', message });
  }

  private post(message: unknown): void {
    this.view?.webview.postMessage(message);
  }
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
    });

    send.addEventListener('click', () => {
      const text = prompt.value.trim();
      if (!text || !model.value) {
        return;
      }
      addMessage('You', text);
      prompt.value = '';
      vscode.postMessage({ type: 'send', text, model: model.value });
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
