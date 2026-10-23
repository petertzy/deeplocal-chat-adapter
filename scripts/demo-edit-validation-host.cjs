const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { model, repaired } = require('./demo-edit-validation-fixture.cjs');

async function waitFor(predicate, label, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

exports.run = async () => {
  const workspace = process.env.DEEPLOCAL_DEMO_WORKSPACE;
  assert.equal(vscode.workspace.workspaceFolders?.length, 1);
  assert.equal(await fs.realpath(vscode.workspace.workspaceFolders[0].uri.fsPath), await fs.realpath(workspace));
  const { publisher, name } = require('../package.json');
  const extension = vscode.extensions.getExtension(`${publisher}.${name}`);
  assert.ok(extension, 'Development extension is available');
  await extension.activate();
  await vscode.extensions.getExtension('vscode.typescript-language-features').activate();
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(workspace, 'game.ts')));
  await vscode.window.showTextDocument(document);
  await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
  await waitFor(() => vscode.languages.getDiagnostics(document.uri).some(diagnostic => diagnostic.code === 2322), 'the intentional starting TypeScript error (TS2322)');
  await vscode.commands.executeCommand('deeplocal-chat-adapter.open');

  if (process.env.DEEPLOCAL_DEMO_VERIFY !== '1') {
    await vscode.commands.executeCommand('markdown.showPreviewToSide', vscode.Uri.file(path.join(workspace, 'DEMO.md')));
    await vscode.commands.executeCommand('deeplocal-chat-adapter.open');
    void vscode.window.showInformationMessage(`Issue #80 demo ready. Select ${model} in DeepLocal and send: Run demo`);
    console.log('Demo ready: real TypeScript diagnostics initialized.');
    // Keep the Extension Host alive until the user closes this isolated window.
    return new Promise(() => {});
  }

  // Exercise the real client, HTTP provider, agent loop, file tools and diagnostics.
  // Only the webview transport is captured so verification needs no mouse input.
  const { ChatPanel, DeepLocalClient, Logger } = require(process.env.DEEPLOCAL_DEMO_RUNTIME);
  const output = vscode.window.createOutputChannel('Issue 80 scripted demo verification');
  const client = new DeepLocalClient(new Logger(output));
  await client.listModels();
  const state = new Map();
  const memento = { get: (key, fallback) => state.get(key) ?? fallback, update: async (key, value) => { state.set(key, structuredClone(value)); } };
  const context = { subscriptions: [], workspaceState: memento, globalState: memento };
  const panel = new ChatPanel(context, client, new Logger(output), { get: async () => undefined, set: async () => {}, clear: async () => {} });
  const posts = [];
  let receive, dispose;
  panel.resolveWebviewView({ onDidDispose: callback => { dispose = callback; }, webview: {
    cspSource: 'vscode-webview:', onDidReceiveMessage: callback => { receive = callback; },
    postMessage: message => { posts.push(message); return Promise.resolve(true); },
  } });
  try {
    receive({ type: 'send', model, text: 'Run demo', useAgent: true });
    await waitFor(() => posts.some(message => message.type === 'assistantDone'), 'the scripted conversation', 45000);
    const final = posts.find(message => message.type === 'assistantFinal');
    assert.ok(final?.text.includes('All three demo checks passed.'), JSON.stringify(posts.filter(message => ['error', 'assistantFinal'].includes(message.type))));
    assert.equal(await fs.readFile(document.uri.fsPath, 'utf8'), repaired);
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).filter(diagnostic => diagnostic.severity === vscode.DiagnosticSeverity.Error).length === 0, 'the repaired file to have no TypeScript errors');
    const tools = posts.filter(message => message.type === 'toolResult');
    assert.equal(tools.length, 4);
    assert.deepEqual(tools.map(message => message.activity.state), ['success', 'error', 'error', 'success']);
    console.log('Verified: real HTTP agent loop, duplicate rejection, retained saved errors, targeted repair, and clean final TypeScript diagnostics.');
  } finally {
    dispose();
    for (const subscription of context.subscriptions) subscription.dispose();
    output.dispose();
  }
};
