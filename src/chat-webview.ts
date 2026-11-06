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
  button, select, textarea, input { font: inherit; color: inherit; }
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
  .workspace-row { padding: 4px 12px 0; min-width: 0; }
  #workspaceButton { width: 100%; text-align: left; font-size: 11px; overflow-wrap: anywhere; }
  #workspaceButton:disabled { opacity: 1; color: var(--vscode-descriptionForeground, #999); }
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
  .message-actions { display: flex; align-items: center; gap: 6px; margin-top: 5px; font-size: 11px; }
  .message-actions button { flex-shrink: 0; }
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
  #status { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  #workflow { max-width: 110px; font-size: 11px; }
  .review-options { display: grid; gap: 7px; margin-bottom: 8px; font-size: 11px; }
  .review-source-row { display: flex; align-items: center; gap: 8px; }
  .review-source-row select { flex: 1; }
  .review-commits { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px; }
  .review-commits label { display: grid; gap: 3px; min-width: 0; }
  .review-commits input { min-width: 0; width: 100%; padding: 5px; border: 1px solid var(--vscode-input-border, #ffffff30); border-radius: 4px; background: var(--vscode-input-background, #242424); }
  .review-references { display: grid; gap: 5px; margin-top: 9px; }
  .review-references button { text-align: left; overflow-wrap: anywhere; min-width: 0; font-size: 11px; }
  .review-report .message-actions { flex-wrap: wrap; }
  .review-report h2 { font-size: 14px; margin: 16px 0 7px; }
  .review-report h3 { font-size: 12px; margin: 0 0 7px; }
  .review-finding { border-left: 2px solid var(--vscode-panel-border, #ffffff30); margin: 10px 0; padding-left: 9px; }
  .review-finding p, .review-summary { white-space: pre-wrap; }
  .review-report ul { padding-left: 20px; }
  .completion-report { overflow-wrap: anywhere; }
  .completion-report ul { padding-left: 20px; }
  .completion-report summary { cursor: pointer; }
  .subagent { overflow-wrap: anywhere; }
  .subagent-body { padding: 0 10px 10px; }
  .subagent h3 { font-size: 12px; margin: 12px 0 5px; }
  .subagent ul { padding-left: 18px; }
  .subagent .action-title { overflow-wrap: anywhere; }
  .shell[data-busy="true"] .status-dot { background: var(--vscode-progressBar-background, #0078d4); animation: pulse 1.2s infinite alternate; }
  @keyframes pulse { to { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .status-dot { animation: none !important; } }
  .composer { border: 1px solid var(--vscode-input-border, #ffffff30); border-radius: 9px; background: var(--vscode-input-background, #242424); padding: 9px; }
  .composer:focus-within { border-color: var(--vscode-focusBorder, #007fd4); }
  textarea { display: block; width: 100%; min-height: 68px; max-height: 160px; resize: none; background: transparent; border: none; outline: none !important; padding: 1px; color: var(--vscode-input-foreground, #eee); }
  textarea::placeholder { color: var(--vscode-input-placeholderForeground, #888); }
  .composer-toolbar { display: flex; align-items: center; gap: 7px; margin-top: 8px; min-width: 0; }
  select { min-width: 0; border: 1px solid var(--vscode-input-border, #ffffff20); background: var(--vscode-dropdown-background, #242424); border-radius: 4px; padding: 5px; }
  #permissionMode { max-width: 116px; font-size: 11px; }
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
  <div>
  <header>
    <span class="brand">DeepLocal</span><span id="taskTitle">New task</span>
    <div class="header-actions">
      <button id="newSession" class="icon" title="New task" aria-label="New task"><svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg></button>
      <button id="historyButton" class="icon" title="Task history" aria-label="Task history" aria-expanded="false" aria-controls="historyPanel"><svg viewBox="0 0 16 16"><path d="M2 7a6 6 0 1 1 1 5M2 3v4h4M8 4v4l3 2"/></svg></button>
      <button id="settingsButton" class="icon" title="Settings" aria-label="Settings" aria-expanded="false" aria-controls="settingsPanel"><svg viewBox="0 0 16 16"><path d="M3 2v12M8 2v12M13 2v12M1 5h4M6 11h4M11 6h4"/></svg></button>
    </div>
  </header>
  <div class="workspace-row"><button id="workspaceButton" aria-label="Choose workspace folder" aria-describedby="workspaceLabel" disabled><span id="workspaceLabel">Workspace: No folder open</span></button></div>
  </div>
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
    <div class="status"><span class="status-dot"></span><span id="status" role="status" aria-live="polite">Ready</span><select id="workflow" aria-label="Workflow"><option value="normal">Build / Ask</option><option value="review">Review</option></select></div>
    <section id="review" aria-label="Action approval" hidden>
      <div class="eyebrow">Your approval is needed</div>
      <div id="reviewTitle"></div>
      <div class="review-actions"><button id="preview" class="secondary">Preview diff</button><button id="approve" class="primary">Approve</button><button id="reject" class="secondary">Reject</button></div>
    </section>
    <div class="composer">
      <div id="reviewOptions" class="review-options" hidden>
        <div class="review-source-row"><label for="reviewSource">Changes</label><select id="reviewSource"><option value="unstaged">Unstaged changes</option><option value="staged">Staged changes</option><option value="commits">Commit range</option></select></div>
        <div id="reviewCommits" class="review-commits" hidden><label for="reviewBase">Base ref<input id="reviewBase" value="HEAD~1" spellcheck="false"></label><label for="reviewTarget">Target ref<input id="reviewTarget" value="HEAD" spellcheck="false"></label></div>
      </div>
      <textarea id="prompt" aria-label="Task" placeholder="Ask the agent to build, fix, or explore…" rows="3"></textarea>
      <div class="composer-toolbar">
        <select id="permissionMode" aria-label="Agent mode" title="Agent mode"><option value="every">Approve every action</option><option value="safe">Safe auto</option><option value="full">Full access</option><option value="ask">Ask only</option></select>
        <select id="model" aria-label="Model"><option value="">Loading models…</option></select>
        <button id="send" class="primary icon" aria-label="Send task" title="Send task" disabled><svg viewBox="0 0 16 16"><path d="M8 13V3M3 8l5-5 5 5"/></svg></button>
        <button id="stop" class="secondary" hidden>Stop</button>
      </div>
    </div>
    <div class="hint" id="modeHint">Safe auto · Shift+Enter for newline</div>
  </footer>
  <section id="historyPanel" class="sheet" aria-label="Task history" hidden>
    <div class="sheet-title">Task history<button class="icon" data-close="historyPanel" aria-label="Close task history">×</button></div>
    <div class="setting"><label for="session">Recent tasks in this workspace</label><select id="session"></select></div>
    <button id="deleteSession" class="secondary">Delete selected task</button>
  </section>
  <section id="settingsPanel" class="sheet" aria-label="Settings" hidden>
    <div class="sheet-title">Connection settings<button class="icon" data-close="settingsPanel" aria-label="Close settings">×</button></div>
    <div class="setting"><label>Provider</label><div class="setting-row"><span id="backendLabel">Local DeepLocal</span><button id="backendButton" class="secondary">Change</button></div><small id="endpoint"></small></div>
    <div class="setting"><label for="apiMode">API protocol</label><select id="apiMode"><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option></select><small>Responses requires a compatible endpoint and model. Chat Completions keeps progress updates without separate summaries.</small></div>
    <div class="setting"><label for="reasoningSummary">Reasoning summaries</label><select id="reasoningSummary"><option value="auto">Request when supported</option><option value="off">Off</option></select></div>
    <div class="setting" id="remoteKeyRow" hidden><label>API key · Secure storage</label><small id="remoteKeyStatus"></small><div class="setting-row"><button id="setRemoteKeyButton" class="secondary">Set API key</button><button id="clearRemoteKeyButton" class="secondary">Clear key</button></div></div>
    <div class="setting"><label>Available models</label><button id="refresh" class="secondary">Refresh models</button></div>
    <small>Agent modes require a model with tool calling. File changes and commands follow the selected approval mode. Deletions move individual files to the trash.</small>
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
  const subagents = new Map();
  const summaries = new Map();
  const copies = new Map();
  let copyRequestId = 0;
  let busy = false, activeSessionId, canSelectWorkspace = false;
  let workflow = 'normal', workflowPending = false, activeReview = false;
  let currentAssistant, currentReasoning, currentCompletion, assistantText = '', reasoningText = '', approvalId, failed = false;
  let selectedModel = saved.model || '', selectedBackend = saved.backend, approvalMode = saved.approvalMode || 'safe';
  let scheduledRender;
  const welcome = byId('welcome');
  function remember() { vscode.setState({ drafts: Object.fromEntries(drafts), model: model.value, backend: selectedBackend, approvalMode }); }
  function nearBottom() { return messages.scrollHeight - messages.scrollTop - messages.clientHeight < 90; }
  function follow(wasNear) { if (wasNear) messages.scrollTop = messages.scrollHeight; }
  function syncSend() { send.disabled = busy || workflowPending || !model.value || (workflow !== 'review' && !prompt.value.trim()); }
  function resizePrompt() { prompt.style.height = 'auto'; prompt.style.height = Math.min(prompt.scrollHeight, 160) + 'px'; syncSend(); }
  function setBusy(value) {
    busy = value;
    byId('shell').dataset.busy = String(value);
    for (const id of ['session', 'newSession', 'deleteSession', 'historyButton', 'backendButton', 'refresh', 'model', 'permissionMode', 'setRemoteKeyButton', 'clearRemoteKeyButton', 'apiMode', 'reasoningSummary']) byId(id).disabled = value || (id === 'reasoningSummary' && byId('apiMode').value !== 'responses');
    send.hidden = value; stop.hidden = !value; stop.disabled = false; syncSend();
    byId('workspaceButton').disabled = value || !canSelectWorkspace;
    updateComposerState();
  }
  function updateComposerState() {
    const reviewing = workflow === 'review';
    byId('workflow').value = workflow; byId('workflow').disabled = busy || workflowPending;
    byId('reviewOptions').hidden = !reviewing;
    byId('reviewCommits').hidden = byId('reviewSource').value !== 'commits';
    byId('permissionMode').hidden = reviewing; byId('permissionMode').disabled = busy || reviewing || workflowPending;
    for (const id of ['reviewSource', 'reviewBase', 'reviewTarget']) byId(id).disabled = busy || workflowPending;
    send.setAttribute('aria-label', reviewing ? 'Review changes' : 'Send task'); send.title = reviewing ? 'Review changes' : 'Send task';
    prompt.setAttribute('aria-label', reviewing ? 'Review focus (optional)' : 'Task');
    const permissionHints = { every: 'Approve every action', safe: 'Safe operations run automatically', full: 'Full access · operations run automatically', ask: 'Ask only · no operations' };
    if (busy) {
      byId('modeHint').textContent = (activeReview ? 'Reviewing changes' : 'Working') + ' · Draft a follow-up below · Shift+Enter for newline';
      prompt.placeholder = 'Draft a follow-up while the task runs…';
    } else if (reviewing) {
      byId('modeHint').textContent = 'Read-only review · Tests are not run · Shift+Enter for newline';
      prompt.placeholder = 'Optional: focus the review on a concern…';
    } else {
      byId('modeHint').textContent = permissionHints[approvalMode] + ' · Shift+Enter for newline';
      prompt.placeholder = approvalMode === 'ask' ? 'Ask about your project…' : 'Ask the agent to build, fix, or explore…';
    }
    syncSend();
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
  function addCopy(body, reportId, canonicalText) {
    const controls = document.createElement('div'); controls.className = 'message-actions';
    const button = document.createElement('button'); button.type = 'button'; button.className = 'icon'; button.title = 'Copy';
    const copyTitle = 'Copy';
    button.title = copyTitle;
    button.setAttribute('aria-label', reportId ? 'Copy review report' : 'Copy assistant message');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const copyPath = 'M5 5h8v9H5zM3 11H1V1h8v2';
    path.setAttribute('d', copyPath); svg.append(path); button.append(svg);
    const feedback = document.createElement('span'); feedback.className = 'muted'; feedback.setAttribute('role', 'status');
    let feedbackTimer;
    button.addEventListener('click', () => {
      clearTimeout(feedbackTimer); feedback.textContent = ''; button.disabled = true;
      path.setAttribute('d', copyPath); button.title = copyTitle;
      const requestId = String(++copyRequestId);
      copies.set(requestId, success => {
        button.disabled = false; feedback.textContent = success ? 'Copied' : 'Copy failed. Try again.';
        path.setAttribute('d', success ? 'M3 8l3 3 7-7' : copyPath); button.title = success ? 'Copied' : copyTitle;
        feedbackTimer = setTimeout(() => { feedback.textContent = ''; path.setAttribute('d', copyPath); button.title = copyTitle; }, 2000);
      });
      // Include folded content, excluding the role, code summaries and controls.
      const text = canonicalText ?? [...body.querySelectorAll('.prose, pre')].map(node => node.textContent).join('');
      vscode.postMessage(reportId ? { type: 'copyReview', requestId, reportId } : { type: 'copy', requestId, text });
    });
    controls.append(button, feedback); body.parentElement.append(controls);
  }
  function addMessage(role, text, className) {
    const followTail = nearBottom(); welcome.hidden = true;
    const item = document.createElement('section'); item.className = 'message ' + (className || (role === 'You' ? 'user' : 'assistant'));
    const label = document.createElement('div'); label.className = 'role'; label.textContent = role;
    const body = document.createElement('div'); renderBody(body, text);
    item.append(label, body); messages.append(item); follow(followTail); return body;
  }
  function renderCompletion(body, report, text) {
    body.replaceChildren(); body.className = 'completion-report';
    const title = document.createElement('p'); title.className = 'completion-status';
    title.textContent = 'Verification: ' + report.verification;
    const scope = document.createElement('p'); scope.textContent = report.scope;
    const missing = document.createElement('p'); missing.textContent = report.notRecorded;
    const checks = document.createElement('ul'); checks.setAttribute('aria-label', 'Declared checks');
    for (const check of report.checks) {
      const row = document.createElement('li'); row.textContent = check.command + ' — ' + check.state; checks.append(row);
    }
    if (!report.checks.length) { const row = document.createElement('li'); row.textContent = 'No verification checks declared; verification not established.'; checks.append(row); }
    const detail = document.createElement('details'), label = document.createElement('summary'), pre = document.createElement('pre');
    label.textContent = 'All tool attempts and evidence (' + report.attempts.length + ')'; pre.textContent = text; detail.append(label, pre);
    body.append(title, scope, checks, missing);
    if (report.limitation) { const limitation = document.createElement('p'); limitation.textContent = report.limitation; body.append(limitation); }
    body.append(detail);
    if (report.research?.length) {
      const research = document.createElement('details'); research.className = 'research-results';
      const heading = document.createElement('summary'); heading.textContent = 'Read-only research — not command verification'; research.append(heading);
      for (const batch of report.research.slice(0, 16)) {
        const label = document.createElement('p'); label.textContent = 'Batch ' + batch.id + ' — ' + batch.state; research.append(label);
        for (const result of batch.results.slice(0, 16)) {
          const child = document.createElement('details'); child.className = 'subagent';
          const title = document.createElement('summary'); title.textContent = result.title + ' [' + result.id + '] — ' + researchState(result.state);
          const content = document.createElement('div'); content.className = 'subagent-body'; appendResearchResult(content, result);
          child.append(title, content); research.append(child);
        }
      }
      body.append(research);
    }
    const modelText = report.unverifiedModelText;
    if (modelText && (modelText.nextSteps || modelText.checkReasons.length)) {
      const notes = document.createElement('details'); notes.className = 'model-suggestions';
      const heading = document.createElement('summary'); heading.textContent = 'Unverified model suggestions — not completion evidence';
      notes.append(heading);
      if (modelText.nextSteps) { const next = document.createElement('p'); next.className = 'prose'; next.textContent = modelText.nextSteps; notes.append(next); }
      for (const reason of modelText.checkReasons) { const row = document.createElement('p'); row.textContent = reason.command + ': ' + reason.text; notes.append(row); }
      body.append(notes);
    }
  }
  function addReview(id, report) {
    const tail = nearBottom();
    const body = addMessage('Code review', '', 'assistant review-report');
    const label = document.createElement('p'); label.className = 'muted'; label.textContent = report.label;
    const summary = document.createElement('p'); summary.className = 'review-summary'; summary.textContent = report.summary;
    body.append(label, summary);
    for (const classification of ['confirmed', 'potential']) {
      const group = document.createElement('section'); group.className = 'review-group';
      const heading = document.createElement('h2'); heading.textContent = classification === 'confirmed' ? 'Confirmed findings' : 'Potential risks';
      group.append(heading);
      for (const [index, finding] of report.findings.entries()) {
        if (finding.classification !== classification) continue;
        const card = document.createElement('section'); card.className = 'review-finding';
        const title = document.createElement('h3'); title.textContent = finding.severity + ': ' + finding.title;
        const explanation = document.createElement('p'); explanation.textContent = finding.explanation;
        const evidenceLabel = document.createElement('p'); evidenceLabel.className = 'muted'; evidenceLabel.textContent = 'Evidence';
        const evidence = document.createElement('pre'); evidence.textContent = finding.evidence;
        const references = document.createElement('div'); references.className = 'review-references';
        references.setAttribute('aria-label', 'Review source references');
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
        button.textContent = 'Open ' + finding.path + ':' + finding.startLine + (finding.endLine !== finding.startLine ? '-' + finding.endLine : '') + ' (' + finding.side + ')';
        button.addEventListener('click', () => vscode.postMessage({ type: 'openReviewReference', reportId: id, findingIndex: index }));
        references.append(button); card.append(title, explanation, evidenceLabel, evidence, references); group.append(card);
      }
      if (group.children.length === 1) { const empty = document.createElement('p'); empty.textContent = 'None reported.'; group.append(empty); }
      body.append(group);
    }
    if (!report.findings.length) {
      const caveat = document.createElement('p'); caveat.textContent = 'No actionable findings were identified in the reviewed changes. This does not establish that the changes are defect-free.'; body.append(caveat);
    }
    const limitsHeading = document.createElement('h2'); limitsHeading.textContent = 'Limitations';
    const tests = document.createElement('p'); tests.textContent = 'Tests were not run. This was a read-only review.';
    const limits = document.createElement('ul');
    for (const limitation of report.limitations) { const item = document.createElement('li'); item.textContent = limitation; limits.append(item); }
    body.append(limitsHeading, tests, limits); addCopy(body, id); follow(tail);
  }
  function researchState(state) {
    return { queued: 'Queued', running: 'Working', completed: 'Completed', failed: 'Failed', cancelled: 'Cancelled', limited: 'Limit reached' }[state] || state;
  }
  function appendResearchResult(body, result) {
    const add = (tag, text) => { const node = document.createElement(tag); node.textContent = text; body.append(node); return node; };
    add('p', 'Read-only research. Tests were not run by this subagent.');
    add('h3', 'Model findings');
    if (!result.findings.length) add('p', 'No findings reported.');
    for (const finding of result.findings.slice(0, 32)) {
      add('p', finding.text);
      add('h3', 'Observed evidence');
      if (!finding.evidence.length) add('p', 'No observed evidence supplied for this finding.');
      for (const evidence of finding.evidence.slice(0, 16)) {
        add('p', evidence.observationId + ' · ' + evidence.tool + (evidence.path ? ' · ' + evidence.path : ''));
        add('pre', evidence.quote);
      }
    }
    add('h3', 'Limitations');
    add('p', 'State: ' + researchState(result.state) + ' · Duration: ' + result.durationMs + ' ms');
    if (!result.limitations.length) add('p', 'No additional limitations reported.');
    for (const limitation of result.limitations.slice(0, 32)) add('p', limitation);
  }
  function addSubagent(activity) {
    const tail = nearBottom(); welcome.hidden = true;
    let entry = subagents.get(activity.id);
    if (!entry) {
      const item = document.createElement('details'); item.className = 'action subagent';
      const summary = document.createElement('summary');
      const heading = document.createElement('div'); heading.className = 'action-heading';
      const title = document.createElement('div'); title.className = 'action-title'; title.textContent = activity.title;
      const attribution = document.createElement('div'); attribution.className = 'action-path'; attribution.textContent = 'Research · ' + activity.id; attribution.title = activity.id;
      const badge = document.createElement('span'); badge.className = 'action-state';
      heading.append(title, attribution); summary.append(heading, badge);
      const body = document.createElement('div'); body.className = 'subagent-body'; item.append(summary, body); messages.append(item);
      entry = { item, body, title: activity.title }; subagents.set(activity.id, entry);
    }
    entry.item.dataset.state = activity.state;
    entry.item.querySelector('.action-state').textContent = researchState(activity.state);
    entry.body.replaceChildren(); entry.item.querySelector('.message-actions')?.remove();
    if (activity.result) {
      appendResearchResult(entry.body, activity.result);
      addCopy(entry.body, undefined, JSON.stringify({ ...activity, title: entry.title, result: { ...activity.result, testsRun: false } }, null, 2));
    } else {
      const note = document.createElement('p'); note.textContent = activity.state === 'queued' ? 'Waiting to start read-only research.' : 'Read-only research in progress. Tests were not run by this subagent.'; entry.body.append(note);
    }
    follow(tail);
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
  function addSummary(id, text, append = true) {
    const tail = nearBottom(); welcome.hidden = true;
    let entry = summaries.get(id);
    if (!entry) {
      const item = document.createElement('details'); item.className = 'reasoning summary-block'; item.open = busy;
      const label = document.createElement('summary'); label.textContent = 'Reasoning summary';
      const body = document.createElement('div'); body.className = 'summary-body';
      item.append(label, body); messages.append(item);
      entry = { item, body, text: '', active: busy }; summaries.set(id, entry);
    }
    entry.text = append ? entry.text + text : text;
    renderBody(entry.body, entry.text); follow(tail);
  }
  function finishSummaries() {
    for (const entry of summaries.values()) {
      if (entry.active) { entry.item.open = false; entry.active = false; }
    }
  }
  window.addEventListener('message', event => {
    const msg = event.data;
    if (msg.type === 'workflow' && (msg.workflow === 'normal' || msg.workflow === 'review')) {
      workflow = msg.workflow; workflowPending = false; updateComposerState();
    }
    if (msg.type === 'summaryDelta') addSummary(msg.id, msg.text);
    if (msg.type === 'workspace') {
      byId('workspaceLabel').textContent = 'Workspace: ' + msg.label;
      byId('workspaceButton').title = msg.path || msg.label;
      canSelectWorkspace = msg.canSelect === true;
      byId('workspaceButton').disabled = busy || !canSelectWorkspace;
    }
    if (msg.type === 'models') {
      approvalMode = msg.approvalMode || 'safe'; byId('permissionMode').value = approvalMode;
      byId('apiMode').value = msg.apiMode || 'chat-completions';
      byId('reasoningSummary').value = msg.reasoningSummary || 'auto';
      byId('reasoningSummary').disabled = busy || byId('apiMode').value !== 'responses';
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
    if (msg.type === 'permissionMode') { approvalMode = msg.approvalMode; byId('permissionMode').value = approvalMode; updateComposerState(); remember(); }
    if (msg.type === 'sessions') {
      if (activeSessionId && activeSessionId !== msg.activeSessionId) drafts.set(activeSessionId, prompt.value);
      const changed = activeSessionId !== msg.activeSessionId;
      activeSessionId = msg.activeSessionId;
      byId('session').replaceChildren(...msg.sessions.map(item => {
        const option = document.createElement('option');
        const preview = (item.preview || '').replace(/\s+/g, ' ').trim();
        const characters = Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(preview), part => part.segment);
        const shortPreview = characters.length > 60 ? characters.slice(0, 60).join('') + '…' : preview;
        const label = item.title + (preview ? ' — ' + preview : '');
        option.value = item.id;
        option.textContent = item.title + (shortPreview ? ' — ' + shortPreview : '');
        option.title = label;
        option.setAttribute('aria-label', label);
        option.selected = item.id === activeSessionId;
        return option;
      }));
      byId('session').title = byId('session').selectedOptions[0]?.title || '';
      byId('taskTitle').textContent = msg.sessions.find(item => item.id === activeSessionId)?.title || 'New task';
      if (changed) prompt.value = drafts.get(activeSessionId) || '';
      resizePrompt();
    }
    if (msg.type === 'restore') {
      copies.clear();
      if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
      currentReasoning = undefined; reasoningText = ''; currentAssistant = undefined; assistantText = '';
      messages.replaceChildren(welcome); welcome.hidden = msg.items.length > 0; actions.clear(); summaries.clear(); subagents.clear();
      for (const item of msg.items) {
        if (item.completionReport) {
          const body = addMessage('Agent', ''); renderCompletion(body, item.completionReport, item.text); addCopy(body, undefined, item.text);
        }
        else if (item.reviewReport) addReview(item.id, item.reviewReport);
        else if (item.subagent) addSubagent(item.subagent);
        else if (item.role === 'Tool') addTool(item.text, item.activity);
        else if (item.role === 'Summary') addSummary(item.id || 'restored-' + summaries.size, item.text, false);
        else if (item.role === 'Reasoning') { currentReasoning = undefined; addReasoning(item.text); currentReasoning = undefined; }
        else {
          const body = addMessage(item.role, item.text);
          if (item.role === 'DeepLocal' && item.text.trim()) addCopy(body);
        }
      }
    }
    if (msg.type === 'status') status.textContent = msg.message;
    if (msg.type === 'subagent') addSubagent(msg.activity);
    if (msg.type === 'toolStart' || msg.type === 'toolResult') {
      if (msg.type === 'toolStart') finishSummaries();
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
      failed = false; assistantText = ''; reasoningText = ''; currentReasoning = undefined; currentCompletion = undefined; activeReview = msg.review === true;
      currentAssistant = msg.agent ? undefined : addMessage('Agent', ''); setBusy(true); status.textContent = activeReview ? 'Reviewing changes…' : 'Thinking…';
    }
    if (msg.type === 'assistantDelta' && currentAssistant) {
      if (!assistantText) messages.append(currentAssistant.parentElement);
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
    if (msg.type === 'reviewResult') {
      if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
      currentReasoning?.remove(); currentReasoning = undefined; reasoningText = '';
      addReview(msg.id, msg.report);
    }
    if (msg.type === 'assistantFinal') {
      if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
      currentReasoning?.remove(); currentReasoning = undefined; reasoningText = '';
      if (!currentAssistant) currentAssistant = addMessage('Agent', '');
      if (currentAssistant) {
        const tail = nearBottom(); assistantText = msg.text; currentCompletion = msg.completionReport;
        if (currentCompletion) renderCompletion(currentAssistant, currentCompletion, assistantText);
        else renderBody(currentAssistant, assistantText);
        messages.append(currentAssistant.parentElement); follow(tail);
      }
    }
    if (msg.type === 'assistantDone') {
      finishSummaries();
      if (scheduledRender) cancelAnimationFrame(scheduledRender); scheduledRender = undefined;
      if (reasoningText) addReasoning(reasoningText);
      if (currentAssistant && assistantText && !currentCompletion) renderBody(currentAssistant, assistantText);
      if (currentAssistant && !assistantText.trim()) currentAssistant.parentElement.remove();
      if (currentAssistant && assistantText.trim() && (currentCompletion || (!failed && (!msg.outcome || msg.outcome === 'success')))) addCopy(currentAssistant, undefined, currentCompletion ? assistantText : undefined);
      setBusy(false); currentAssistant = undefined; currentReasoning = undefined;
      const reviewed = activeReview || msg.review === true;
      status.textContent = msg.outcome === 'cancelled' ? (reviewed ? 'Review stopped' : 'Stopped · Applied changes kept') : failed || msg.outcome === 'error' ? 'Needs attention' : msg.outcome === 'success' ? (reviewed ? 'Review completed' : 'Task completed') : 'Ready';
      if (currentCompletion) status.textContent = 'Verification: ' + currentCompletion.verification;
      currentCompletion = undefined;
      activeReview = false;
      remember(); resizePrompt();
    }
    if (msg.type === 'error') { failed = true; addMessage('Needs attention', msg.message, 'error'); status.textContent = 'Needs attention'; }
    if (msg.type === 'notice') addMessage('Note', msg.message);
    if (msg.type === 'copyResult') {
      copies.get(msg.requestId)?.(msg.success === true); copies.delete(msg.requestId);
    }
  });
  send.addEventListener('click', () => {
    const text = prompt.value.trim(); if (busy || workflowPending || (workflow !== 'review' && !text) || !model.value) return;
    activeReview = workflow === 'review';
    failed = false; setBusy(true); status.textContent = 'Starting…'; toggleSheet('', false);
    addMessage('You', text || 'Review ' + byId('reviewSource').selectedOptions[0].textContent.toLowerCase());
    // The conversation owns submitted text. Keep the composer available for a follow-up.
    prompt.value = ''; drafts.delete(activeSessionId); resizePrompt(); remember(); prompt.focus();
    if (workflow === 'review') {
      const source = byId('reviewSource').value;
      const review = { source };
      if (source === 'commits') { review.base = byId('reviewBase').value.trim(); review.target = byId('reviewTarget').value.trim(); }
      vscode.postMessage({ type: 'send', text, model: model.value, review });
    } else vscode.postMessage({ type: 'send', text, model: model.value, useAgent: approvalMode !== 'ask' });
  });
  stop.addEventListener('click', () => { stop.disabled = true; status.textContent = 'Stopping…'; vscode.postMessage({ type: 'stop' }); });
  prompt.addEventListener('input', () => { if (activeSessionId) drafts.set(activeSessionId, prompt.value); remember(); resizePrompt(); });
  prompt.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send.click(); } });
  for (const [id, type] of [['workspaceButton', 'selectWorkspace'], ['refresh', 'refreshModels'], ['backendButton', 'setBackend'], ['setRemoteKeyButton', 'setRemoteApiKey'], ['clearRemoteKeyButton', 'clearRemoteApiKey'], ['newSession', 'newSession']]) byId(id).addEventListener('click', () => vscode.postMessage({ type }));
  byId('deleteSession').addEventListener('click', () => vscode.postMessage({ type: 'deleteSession', sessionId: byId('session').value }));
  byId('session').addEventListener('change', () => { toggleSheet('', false); vscode.postMessage({ type: 'switchSession', sessionId: byId('session').value }); });
  model.addEventListener('change', () => { selectedModel = model.value; model.title = model.value; remember(); syncSend(); });
  byId('apiMode').addEventListener('change', () => vscode.postMessage({ type: 'setApiMode', apiMode: byId('apiMode').value }));
  byId('reasoningSummary').addEventListener('change', () => vscode.postMessage({ type: 'setSummary', summary: byId('reasoningSummary').value }));
  byId('permissionMode').addEventListener('change', () => { approvalMode = byId('permissionMode').value; updateComposerState(); remember(); vscode.postMessage({ type: 'setApprovalMode', approvalMode }); });
  byId('workflow').addEventListener('change', () => {
    if (busy || workflowPending) { updateComposerState(); return; }
    const requested = byId('workflow').value;
    if (requested === workflow) return;
    workflowPending = true; updateComposerState();
    vscode.postMessage({ type: 'setWorkflow', workflow: requested });
  });
  byId('reviewSource').addEventListener('change', updateComposerState);
  for (const [id, panel] of [['historyButton', 'historyPanel'], ['settingsButton', 'settingsPanel']]) byId(id).addEventListener('click', () => toggleSheet(panel, byId(panel).hidden));
  for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => { const id = button.dataset.close; toggleSheet('', false); byId(id === 'historyPanel' ? 'historyButton' : 'settingsButton').focus(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { toggleSheet('', false); prompt.focus(); } });
  for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { prompt.value = button.dataset.prompt; prompt.dispatchEvent(new Event('input')); prompt.focus(); });
  for (const [id, type, approved] of [['preview', 'preview', false], ['approve', 'approval', true], ['reject', 'approval', false]]) byId(id).addEventListener('click', () => {
    if (!approvalId) return;
    vscode.postMessage({ type, approvalId, approved });
    if (type === 'approval') for (const action of ['preview', 'approve', 'reject']) byId(action).disabled = true;
  });
  byId('permissionMode').value = approvalMode; updateComposerState(); vscode.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}
