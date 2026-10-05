import { randomBytes } from 'node:crypto';

/** Self-contained webview: no remote assets, HTML from models, or inline handlers. */
export function renderChatHtml(webview: { cspSource: string }): string {
  const nonce = randomBytes(18).toString('base64');
  return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>DeepLocal Agent</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  body { margin: 0; color: var(--vscode-foreground, #ccc); background: var(--vscode-sideBar-background, #181818); font: 13px/1.5 var(--vscode-font-family, system-ui); }
  button, select, textarea { font: inherit; color: inherit; }
  button { cursor: pointer; border: 1px solid transparent; border-radius: 5px; background: transparent; padding: 5px 9px; }
  button:hover { background: var(--vscode-toolbar-hoverBackground, #ffffff14); }
  button:disabled { opacity: .45; cursor: default; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder, #007fd4); outline-offset: 2px; }
  .primary { background: var(--vscode-button-background, #0078d4); color: var(--vscode-button-foreground, white); }
  .primary:hover { background: var(--vscode-button-hoverBackground, #026ec1); }
  .secondary { border-color: var(--vscode-panel-border, #ffffff20); }
  .muted, small { color: var(--vscode-descriptionForeground, #999); }
  .shell { height: 100vh; height: 100dvh; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; position: relative; overflow: hidden; }
  header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid var(--vscode-panel-border, #ffffff18); }
  .brand { font-size: 13px; font-weight: 650; letter-spacing: .2px; }
  .header-actions { display: flex; margin-left: auto; gap: 2px; }
  .icon { width: 28px; height: 28px; padding: 5px; display: inline-flex; align-items: center; justify-content: center; }
  svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  main { min-width: 0; overflow-y: auto; overflow-x: hidden; padding: 16px 12px; scroll-padding: 12px; }
  .welcome { margin: 12vh auto 0; max-width: 330px; }
  .eyebrow { font-size: 10px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: var(--vscode-descriptionForeground, #999); }
  h1 { font-size: 21px; font-weight: 550; line-height: 1.3; margin: 10px 0; }
  p { margin: 8px 0; }
  .suggestion { text-align: left; width: 100%; border: 1px solid var(--vscode-panel-border, #ffffff20); margin-top: 9px; padding: 11px; }
  .message { overflow-wrap: anywhere; margin: 0 0 18px; }
  .message.user { padding: 10px 12px; border: 1px solid var(--vscode-panel-border, #ffffff20); border-radius: 8px; background: var(--vscode-editor-background, #1f1f1f); }
  .role { font-size: 10px; font-weight: 650; letter-spacing: .7px; text-transform: uppercase; margin-bottom: 5px; color: var(--vscode-descriptionForeground, #999); }
  .prose { white-space: pre-wrap; }
  .message.error { border-left: 2px solid var(--vscode-errorForeground, #f48771); padding-left: 10px; }
  .error { color: var(--vscode-errorForeground, #f48771); }
  .action { border: 1px solid var(--vscode-panel-border, #ffffff20); border-radius: 7px; margin-bottom: 9px; overflow: hidden; }
  .action summary { list-style: none; display: flex; align-items: center; gap: 8px; cursor: pointer; padding: 10px; }
  .action summary::-webkit-details-marker { display: none; }
  .action summary::after { content: '›'; margin-left: auto; color: var(--vscode-descriptionForeground, #999); }
  .action[open] summary::after { transform: rotate(90deg); }
  .action-heading { min-width: 0; flex: 1; }
  .action-title { font-size: 12px; font-weight: 550; }
  .action-path { font: 11px var(--vscode-editor-font-family, monospace); color: var(--vscode-descriptionForeground, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
  .action-state { font-size: 10px; padding: 2px 5px; border-radius: 4px; background: var(--vscode-badge-background, #333); color: var(--vscode-badge-foreground, #ddd); }
  .action[data-state="error"] .action-state { color: var(--vscode-errorForeground, #f48771); }
  .action[data-state="success"] .action-state { color: var(--vscode-testing-iconPassed, #73c991); }
  .reasoning { border-left: 2px solid var(--vscode-progressBar-background, #0078d4); margin: 0 0 9px; padding-left: 9px; }
  .reasoning summary { cursor: pointer; list-style: none; color: var(--vscode-descriptionForeground, #999); font-size: 11px; }
  .reasoning summary::-webkit-details-marker { display: none; }
  .reasoning summary::before { content: '✦'; margin-right: 6px; color: var(--vscode-progressBar-background, #0078d4); }
  .reasoning .prose { padding: 6px 0 2px; color: var(--vscode-foreground, #ccc); }
  pre { font: 11px/1.55 var(--vscode-editor-font-family, monospace); white-space: pre-wrap; overflow-wrap: anywhere; overflow: auto; max-height: 220px; margin: 0; padding: 10px; background: var(--vscode-textCodeBlock-background, #222); }
  .code { border: 1px solid var(--vscode-panel-border, #ffffff20); border-radius: 5px; margin: 8px 0; }
  .code summary { padding: 7px 9px; font-size: 11px; cursor: pointer; color: var(--vscode-descriptionForeground, #999); }
  footer { padding: 0 10px 10px; min-width: 0; }
  .status { min-height: 30px; display: flex; align-items: center; gap: 7px; font-size: 11px; color: var(--vscode-descriptionForeground, #999); padding: 6px 2px; }
  .status-dot { height: 6px; width: 6px; border-radius: 50%; background: currentColor; flex-shrink: 0; }
  .shell[data-busy="true"] .status-dot { background: var(--vscode-progressBar-background, #0078d4); animation: pulse 1.2s infinite alternate; }
  @keyframes pulse { to { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .status-dot { animation: none !important; } }
  .composer { border: 1px solid var(--vscode-input-border, #ffffff30); border-radius: 9px; background: var(--vscode-input-background, #242424); padding: 9px; }
  .composer:focus-within { border-color: var(--vscode-focusBorder, #007fd4); }
  textarea { display: block; width: 100%; min-height: 68px; max-height: 160px; resize: none; background: transparent; border: none; outline: none !important; padding: 1px; color: var(--vscode-input-foreground, #eee); }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
  .composer-toolbar { display: flex; align-items: center; gap: 7px; margin-top: 8px; min-width: 0; }
  .modes { display: flex; border: 1px solid var(--vscode-panel-border, #ffffff20); border-radius: 5px; padding: 2px; gap: 1px; }
  .modes button { font-size: 11px; padding: 2px 6px; }
  .modes button[aria-pressed="true"] { background: var(--vscode-button-secondaryBackground, #3a3a3a); color: var(--vscode-button-secondaryForeground, #eee); }
  select { min-width: 0; border: 1px solid var(--vscode-input-border, #ffffff20); background: var(--vscode-dropdown-background, #242424); border-radius: 4px; padding: 5px; }
  #model { flex: 1; width: 0; font-size: 11px; border: 0; padding-left: 0; }
  #send, #stop { flex-shrink: 0; }
  .hint { font-size: 10px; margin: 7px 2px 0; color: var(--vscode-descriptionForeground, #999); }
  #review { border: 1px solid var(--vscode-focusBorder, #007fd4); border-radius: 7px; padding: 11px; margin: 0 0 8px; background: var(--vscode-editor-background, #1f1f1f); max-height: 30vh; overflow: auto; }
  #reviewTitle { font-weight: 550; margin: 5px 0 10px; overflow-wrap: anywhere; }
  .review-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .sheet { position: absolute; top: 49px; left: 8px; right: 8px; z-index: 2; max-height: calc(100% - 65px); overflow: auto; border: 1px solid var(--vscode-widget-border, #555); border-radius: 8px; background: var(--vscode-editorWidget-background, #252526); padding: 14px; box-shadow: 0 8px 24px #0004; }
  .sheet-title { display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; font-weight: 600; }
  .setting { display: grid; gap: 7px; margin-bottom: 16px; }
  .setting label { font-size: 11px; color: var(--vscode-descriptionForeground, #999); }
  .setting-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .setting-row span { flex: 1; min-width: 100px; overflow-wrap: anywhere; }
  .setting-row button { font-size: 11px; }
  #session { width: 100%; }
  #taskTitle { font-size: 10px; color: var(--vscode-descriptionForeground, #999); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100px; }
  @media (max-width: 300px) { #taskTitle { display: none; } .composer-toolbar { flex-wrap: wrap; } #model { min-width: 70px; } .welcome { margin-top: 5vh; } }
</style>
</head>
<body>
<div class="shell" id="shell" data-busy="false">
  <header>
    <span class="brand">DeepLocal</span><span id="taskTitle">New task</span>
    <div class="header-actions">
      <button id="newSession" class="icon" title="New task" aria-label="New task"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></button>
      <button id="historyButton" class="icon" title="Task history" aria-label="Task history" aria-expanded="false" aria-controls="historyPanel"><svg viewBox="0 0 16 16"><path d="M2 7a6 6 0 1 1 1 5M2 3v4h4M8 4v4l3 2"/></svg></button>
      <button id="settingsButton" class="icon" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="settingsPanel"><svg viewBox="0 0 16 16"><path d="M3 2v12M8 2v12M13 2v12M1 5h4M6 11h4M11 6h4"/></svg></button>
    </div>
  </header>
  <main id="messages" aria-label="Conversation">
    <section id="welcome" class="welcome">
      <div class="eyebrow">Your workspace, in action</div>
      <h1>What would you like to build?</h1>
      <p class="muted">Describe a task. Review changes. Let the agent handle the steps.</p>
      <button class="suggestion" data-prompt="Create snake.html with a playable Snake game. Keep existing files unchanged.">Create a Snake game <span class="muted">↗</span></button>
      <button class="suggestion" data-prompt="Inspect this workspace and explain how the project is organized.">Explore this project <span class="muted">↗</span></button>
    </section>
  </main>
  <footer>
    <div class="status" role="status" aria-live="polite"><span class="status-dot"></span><span id="status">Ready</span></div>
    <section id="review" aria-label="Action approval" hidden>
      <div class="eyebrow">Your approval is needed</div>
      <div id="reviewTitle"></div>
      <div class="review-actions"><button id="preview" class="secondary">Preview diff</button><button id="approve" class="primary">Approve</button><button id="reject" class="secondary">Reject</button></div>
    </section>
    <div class="composer">
      <textarea id="prompt" aria-label="Task" placeholder="Ask the agent to build, fix, or explore…" rows="3"></textarea>
      <div class="composer-toolbar">
        <div class="modes" role="group" aria-label="Mode"><button id="agentMode" aria-pressed="true" title="Agent can inspect files and propose changes">Agent</button><button id="chatMode" aria-pressed="false" title="Discuss without file changes">Chat</button></div>
        <select id="model" aria-label="Model"><option value="">Loading models…</option></select>
        <button id="send" class="primary icon" aria-label="Send task" title="Send task" disabled><svg viewBox="0 0 16 16"><path d="M8 13V3M3 8l5-5 5 5"/></svg></button>
        <button id="stop" class="secondary" hidden>Stop</button>
      </div>
    </div>
    <div class="hint" id="modeHint">Agent · Changes require approval · Shift+Enter for newline</div>
  </footer>
  <section id="historyPanel" class="sheet" aria-label="Task history" hidden>
    <div class="sheet-title">Task history<button class="icon" data-close="historyPanel" aria-label="Close task history">×</button></div>
    <div class="setting"><label for="session">Recent tasks in this workspace</label><select id="session"></select></div>
    <button id="deleteSession" class="secondary">Delete selected task</button>
  </section>
  <section id="settingsPanel" class="sheet" aria-label="Settings" hidden>
    <div class="sheet-title">Connection settings<button class="icon" data-close="settingsPanel" aria-label="Close settings">×</button></div>
    <div class="setting"><label>Provider</label><div class="setting-row"><span id="backendLabel">Local DeepLocal</span><button id="backendButton" class="secondary">Change</button></div><small id="endpoint"></small></div>
    <div class="setting" id="remoteKeyRow" hidden><label>API key · Secure storage</label><small id="remoteKeyStatus"></small><div class="setting-row"><button id="setRemoteKeyButton" class="secondary">Set API key</button><button id="clearRemoteKeyButton" class="secondary">Clear key</button></div></div>
    <div class="setting"><label>Available models</label><button id="refresh" class="secondary">Refresh models</button></div>
    <small>Agent mode requires a model with tool calling. File changes and commands need approval. Deletions move individual files to the trash. Chat mode never edits files.</small>
  </section>
</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const byId = id => document.getElementById(id);
  const messages = byId('messages'), prompt = byId('prompt'), model = byId('model');
  const status = byId('status'), send = byId('send'), stop = byId('stop');
  const saved = vscode.getState() || {};
  const drafts = new Map(Object.entries(saved.drafts || {}));
  const actions = new Map();
  let busy = false, useAgent = saved.useAgent !== false, activeSessionId;
  let currentAssistant, currentReasoning, assistantText = '', reasoningText = '', pendingPrompt, approvalId, failed = false;
  let selectedModel = saved.model || '', selectedBackend = saved.backend;
  let scheduledRender;
  const welcome = byId('welcome');
  function remember() { vscode.setState({ drafts: Object.fromEntries(drafts), model: model.value, backend: selectedBackend, useAgent }); }
  function nearBottom() { return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90; }
  function follow(wasNear) { if (wasNear) messages.scrollTop = messages.scrollHeight; }
  function syncSend() { send.disabled = busy || !model.value || !prompt.value.trim(); }
  function resizePrompt() { prompt.style.height = 'auto'; prompt.style.height = Math.min(prompt.scrollHeight, 160) + 'px'; syncSend(); }
  function setBusy(value) {
    busy = value;
    byId('shell').dataset.busy = String(value);
    for (const id of ['session', 'newSession', 'deleteSession', 'historyButton', 'backendButton', 'refresh', 'model', 'agentMode', 'chatMode', 'setRemoteKeyButton', 'clearRemoteKeyButton']) byId(id).disabled = value;
    send.hidden = value; stop.hidden = !value; stop.disabled = false; syncSend();
  }
  function setMode(agent) {
    useAgent = agent;
    byId('agentMode').setAttribute('aria-pressed', String(agent));
    byId('chatMode').setAttribute('aria-pressed', String(!agent));
    byId('modeHint').textContent = agent ? 'Agent · Changes require approval · Shift+Enter for newline' : 'Chat · No file changes · Shift+Enter for newline';
    prompt.placeholder = agent ? 'Ask the agent to build, fix, or explore…' : 'Ask a question about your project…';
  }
  function toggleSheet(id, open) {
    for (const [panel, trigger] of [['historyPanel', 'historyButton'], ['settingsPanel', 'settingsButton']]) {
      const show = panel === id && open;
      byId(panel).hidden = !show;
      byId(trigger).setAttribute('aria-expanded', String(show));
      if (show) byId(panel).querySelector('button').focus();
    }
  }
  function renderBody(body, text) {
    // Treat model text as data. Never render model-provided HTML.
    const expanded = [...body.querySelectorAll('details')].map(node => node.open);
    body.replaceChildren();
    const fence = String.fromCharCode(96).repeat(3);
    const parts = text.split(fence);
    let detailIndex = 0;
    parts.forEach((part, index) => {
      if (!part) return;
      const code = index % 2 === 1;
      if (code || part.length > 1600) {
        const detail = document.createElement('details'); detail.className = 'code';
        const summary = document.createElement('summary');
        const lineBreak = part.indexOf('\n');
        const language = code && lineBreak >= 0 ? part.slice(0, lineBreak).trim() : '';
        const content = code && lineBreak >= 0 ? part.slice(lineBreak + 1) : part;
        summary.textContent = (code ? 'Code' + (language ? ' · ' + language.slice(0, 32) : '') : 'Long response') + ' · ' + content.split('\n').length + ' lines · expand';
        const pre = document.createElement('pre'); pre.textContent = content;
        detail.open = expanded[detailIndex++] || false;
        detail.append(summary, pre); body.append(detail);
      } else {
        const prose = document.createElement('div'); prose.className = 'prose'; prose.textContent = part; body.append(prose);
      }
    });
  }
  function addMessage(role, text, className) {
    const followTail = nearBottom(); welcome.hidden = true;
    const item = document.createElement('section'); item.className = 'message ' + (className || (role === 'You' ? 'user' : 'assistant'));
    const label = document.createElement('div'); label.className = 'role'; label.textContent = role;
    const body = document.createElement('div'); renderBody(body, text);
    item.append(label, body); messages.append(item); follow(followTail); return body;
  }
  function addTool(text, activity) {
    const followTail = nearBottom(); welcome.hidden = true;
    const lines = (text || '').split('\n');
    const data = activity || { title: lines[0], detail: lines[1] || '', state: 'complete' };
    let item = data.id && actions.get(data.id);
    if (!item) {
      item = document.createElement('details'); item.className = 'action';
      const summary = document.createElement('summary');
      const heading = document.createElement('div'); heading.className = 'action-heading';
      const title = document.createElement('div'); title.className = 'action-title';
      const detail = document.createElement('div'); detail.className = 'action-path';
      heading.append(title, detail);
      const badge = document.createElement('span'); badge.className = 'action-state';
      summary.append(heading, badge); item.append(summary, document.createElement('pre')); messages.append(item);
      if (data.id) actions.set(data.id, item);
    }
    item.dataset.state = data.state;
    item.querySelector('.action-title').textContent = data.title;
    item.querySelector('.action-path').textContent = data.detail || '';
    item.querySelector('.action-path').title = data.detail || '';
    const labels = { running: 'Working', success: 'Done', error: 'Failed', declined: 'Declined', cancelled: 'Stopped', complete: 'Result' };
    item.querySelector('.action-state').textContent = labels[data.state] || 'Result';
    item.querySelector('pre').textContent = text ? lines.slice(1).join('\n') : 'Waiting for the tool result…';
    follow(followTail);
  }
  function addReasoning(text) {
    const followTail = nearBottom(); welcome.hidden = true;
    if (!currentReasoning) {
      currentReasoning = document.createElement('details'); currentReasoning.className = 'reasoning';
      const summary = document.createElement('summary'); summary.textContent = 'Progress update';
      const body = document.createElement('div'); body.className = 'prose';
      currentReasoning.open = busy;
      currentReasoning.append(summary, body); messages.append(currentReasoning);
    }
    currentReasoning.querySelector('.prose').textContent = text;
    follow(followTail);
  }
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'models') {
      const remote = msg.backend === 'remote';
      if (selectedBackend && selectedBackend !== msg.backend) selectedModel = '';
      selectedBackend = msg.backend;
      byId('backendLabel').textContent = remote ? 'Remote OpenAI-compatible API' : 'Local DeepLocal';
      byId('endpoint').textContent = msg.baseUrl || '';
      byId('remoteKeyRow').hidden = !remote;
      byId('remoteKeyStatus').textContent = msg.hasApiKey ? 'API key configured' : 'No API key configured';
      byId('setRemoteKeyButton').textContent = msg.hasApiKey ? 'Update key' : 'Set API key';
      const ids = msg.models.length ? msg.models : [''];
      model.replaceChildren(...ids.map(id => { const option = document.createElement('option'); option.value = id; option.textContent = id || 'No models available'; return option; }));
      if (msg.models.includes(selectedModel)) model.value = selectedModel;
      selectedModel = model.value; model.title = model.value; remember(); syncSend();
      if (!model.value) status.textContent = 'No models · Check connection settings';
    }
    if (msg.type === 'sessions') {
      if (activeSessionId && activeSessionId !== msg.activeSessionId) drafts.set(activeSessionId, prompt.value);
      const changed = activeSessionId !== msg.activeSessionId;
      activeSessionId = msg.activeSessionId;
      byId('session').replaceChildren(...msg.sessions.map(item => { const option = document.createElement('option'); option.value = item.id; option.textContent = item.title; option.selected = item.id === activeSessionId; return option; }));
      byId('taskTitle').textContent = msg.sessions.find(item => item.id === activeSessionId)?.title || 'New task';
      if (changed) prompt.value = drafts.get(activeSessionId) || '';
      resizePrompt();
    }
    if (msg.type === 'restore') {
      if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
      currentReasoning = undefined; reasoningText = ''; currentAssistant = undefined; assistantText = '';
      messages.replaceChildren(welcome); welcome.hidden = msg.items.length > 0; actions.clear();
      for (const item of msg.items) {
        if (item.role === 'Tool') addTool(item.text, item.activity);
        else if (item.role === 'Reasoning') { currentReasoning = undefined; addReasoning(item.text); currentReasoning = undefined; }
        else addMessage(item.role, item.text);
      }
    }
    if (msg.type === 'status') status.textContent = msg.message;
    if (msg.type === 'toolStart' || msg.type === 'toolResult') {
      if (msg.type === 'toolStart' && reasoningText) {
        if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
        addReasoning(reasoningText);
        currentReasoning.open = false;
      }
      addTool(msg.text, msg.activity);
    }
    if (msg.type === 'approval') {
      approvalId = msg.approvalId; status.textContent = 'Waiting for your approval';
      byId('reviewTitle').textContent = msg.message; byId('review').hidden = false; byId('preview').hidden = !msg.hasPreview;
      for (const id of ['preview', 'approve', 'reject']) byId(id).disabled = false;
    }
    if (msg.type === 'approvalDone' && msg.approvalId === approvalId) {
      approvalId = undefined; byId('review').hidden = true;
      status.textContent = msg.approved ? 'Applying approved action…' : 'Action declined';
    }
    if (msg.type === 'assistantStart') {
      failed = false; assistantText = ''; reasoningText = ''; currentReasoning = undefined;
      currentAssistant = msg.agent ? undefined : addMessage('Agent', ''); setBusy(true); status.textContent = 'Thinking…';
    }
    if (msg.type === 'assistantDelta' && currentAssistant) {
      assistantText += msg.text;
      if (!scheduledRender) scheduledRender = requestAnimationFrame(() => {
        scheduledRender = undefined;
        if (currentAssistant) { const tail = nearBottom(); renderBody(currentAssistant, assistantText); follow(tail); }
      });
    }
    if (msg.type === 'reasoningStart') {
      if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
      reasoningText = ''; currentReasoning = undefined;
    }
    if (msg.type === 'reasoningDelta') {
      reasoningText += msg.text;
      if (!scheduledRender) scheduledRender = requestAnimationFrame(() => {
        scheduledRender = undefined;
        if (reasoningText) addReasoning(reasoningText);
      });
    }
    if (msg.type === 'assistantFinal') {
      if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
      currentReasoning?.remove(); currentReasoning = undefined; reasoningText = '';
      if (!currentAssistant) currentAssistant = addMessage('Agent', '');
      if (currentAssistant) {
        const tail = nearBottom(); assistantText = msg.text; renderBody(currentAssistant, assistantText);
        messages.append(currentAssistant.parentElement); follow(tail);
      }
    }
    if (msg.type === 'assistantDone') {
      if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
      if (reasoningText) addReasoning(reasoningText);
      if (currentAssistant && assistantText) renderBody(currentAssistant, assistantText);
      if (currentAssistant && !assistantText.trim()) currentAssistant.parentElement.remove();
      if (pendingPrompt !== undefined && prompt.value.trim() === pendingPrompt && !failed) { prompt.value = ''; drafts.delete(activeSessionId); }
      pendingPrompt = undefined; setBusy(false); currentAssistant = undefined; currentReasoning = undefined;
      status.textContent = msg.outcome === 'cancelled' ? 'Stopped · Applied changes kept' : failed || msg.outcome === 'error' ? 'Needs attention' : msg.outcome === 'success' ? 'Task completed' : 'Ready';
      remember(); resizePrompt();
    }
    if (msg.type === 'error') { failed = true; pendingPrompt = undefined; addMessage('Needs attention', msg.message, 'error'); status.textContent = 'Needs attention'; }
    if (msg.type === 'notice') addMessage('Note', msg.message);
  });
  send.addEventListener('click', () => {
    const text = prompt.value.trim(); if (busy || !text || !model.value) return;
    failed = false; setBusy(true); status.textContent = 'Starting…'; toggleSheet('', false);
    addMessage('You', text); drafts.set(activeSessionId, prompt.value); pendingPrompt = text; remember();
    vscode.postMessage({ type: 'send', text, model: model.value, useAgent });
  });
  stop.addEventListener('click', () => { stop.disabled = true; status.textContent = 'Stopping…'; vscode.postMessage({ type: 'stop' }); });
  prompt.addEventListener('input', () => { if (activeSessionId) drafts.set(activeSessionId, prompt.value); remember(); resizePrompt(); });
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send.click(); } });
  for (const [id, type] of [['refresh', 'refreshModels'], ['backendButton', 'setBackend'], ['setRemoteKeyButton', 'setRemoteApiKey'], ['clearRemoteKeyButton', 'clearRemoteApiKey'], ['newSession', 'newSession']]) byId(id).addEventListener('click', () => vscode.postMessage({ type }));
  byId('deleteSession').addEventListener('click', () => vscode.postMessage({ type: 'deleteSession', sessionId: byId('session').value }));
  byId('session').addEventListener('change', () => { toggleSheet('', false); vscode.postMessage({ type: 'switchSession', sessionId: byId('session').value }); });
  model.addEventListener('change', () => { selectedModel = model.value; model.title = model.value; remember(); syncSend(); });
  byId('agentMode').addEventListener('click', () => { setMode(true); remember(); });
  byId('chatMode').addEventListener('click', () => { setMode(false); remember(); });
  for (const [id, panel] of [['historyButton', 'historyPanel'], ['settingsButton', 'settingsPanel']]) byId(id).addEventListener('click', () => toggleSheet(panel, byId(panel).hidden));
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => { const id = button.dataset.close; toggleSheet('', false); byId(id === 'historyPanel' ? 'historyButton' : 'settingsButton').focus(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { toggleSheet('', false); prompt.focus(); } });
  for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { prompt.value = button.dataset.prompt; prompt.dispatchEvent(new Event('input')); prompt.focus(); });
  for (const [id, type, approved] of [['preview', 'preview', false], ['approve', 'approval', true], ['reject', 'approval', false]]) byId(id).addEventListener('click', () => {
    if (!approvalId) return;
    vscode.postMessage({ type, approvalId, approved });
    if (type === 'approval') for (const action of ['preview', 'approve', 'reject']) byId(action).disabled = true;
  });
  setMode(useAgent); vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
