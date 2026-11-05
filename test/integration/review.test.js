const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const vscode = require('vscode');
const { buildSync } = require('esbuild');

buildSync({ entryPoints: [path.join(__dirname, '../../src/chat-panel.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode', 'koffi'], outfile: path.join(__dirname, '../../out/review-panel.cjs') });
const { ChatPanel } = require('../../out/review-panel.cjs');
const execute = promisify(execFile);
const sourcePath = 'review-fixture/src/math.js';
const baseline = 'export const divide = n => n;\n';
const staged = 'export const divide = n => 1 / n;\n';
const working = 'export const divide = n => 999;\n';
const finding = { title: 'Division by zero', severity: 'High', classification: 'confirmed',
  explanation: 'A zero input returns Infinity.', evidence: '1 / n', path: sourcePath,
  side: 'target', startLine: 1, endLine: 1 };
const tool = (name, args) => ({ kind: 'toolCall', value: {
  id: name, type: 'function', function: { name, arguments: JSON.stringify(args) },
} });

async function waitFor(predicate, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

suite('Read-only review with real Git and VS Code documents', () => {
  let root, harness;
  const git = async (...args) => (await execute('git', args, { cwd: root, windowsHide: true })).stdout;
  const write = text => fs.writeFile(path.join(root, sourcePath), text);

  suiteSetup(async () => {
    assert.equal(vscode.workspace.workspaceFolders.length, 1);
    root = vscode.workspace.workspaceFolders[0].uri.fsPath;
    // Fail before touching Git if this suite was launched outside its disposable fixture.
    assert.equal(path.basename(root), 'anchor-one');
    assert.match(path.basename(path.dirname(root)), /^deeplocal-host-/);
    await git('init');
    await git('config', 'user.name', 'Review integration');
    await git('config', 'user.email', 'review@example.invalid');
    await git('config', 'core.autocrlf', 'false');
    await fs.mkdir(path.join(root, 'review-fixture/src'), { recursive: true });
    await fs.mkdir(path.join(root, 'review-fixture/test'), { recursive: true });
    await write(baseline);
    await fs.writeFile(path.join(root, 'review-fixture/test/math.test.js'), '// divide should reject zero\n');
    await git('add', '--', 'review-fixture');
    await git('commit', '-m', 'Review integration baseline');
  });

  setup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await write(staged);
    await git('add', '--', sourcePath);
    await write(working);
  });

  teardown(async () => {
    if (harness) {
      harness.dispose();
      for (const subscription of harness.context.subscriptions) subscription.dispose();
      harness = undefined;
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  async function panel(turns) {
    const posts = [], requests = [];
    let receive, dispose, turn = 0, release;
    const state = () => {
      const values = new Map();
      return { get: (key, fallback) => values.has(key) ? values.get(key) : fallback,
        update: async (key, value) => { values.set(key, value); } };
    };
    const context = { subscriptions: [], workspaceState: state(), globalState: state() };
    const client = {
      listModels: async () => [{ id: 'review-test' }], modelInformation: () => ({ toolCalling: true }),
      cancel: () => release?.(),
      streamChat: async function* (_id, request) {
        requests.push(request);
        if (turns === 'wait') await new Promise(resolve => { release = resolve; });
        else yield* turns[turn++] ?? [];
      },
    };
    const instance = new ChatPanel(context, client, { error() {}, info() {}, debug() {} },
      { get: async () => undefined, set: async () => {}, clear: async () => {} });
    instance.resolveWebviewView({ onDidDispose: callback => { dispose = callback; }, webview: {
      cspSource: 'vscode-webview:', onDidReceiveMessage: callback => { receive = callback; },
      postMessage: message => { posts.push(message); return Promise.resolve(true); },
    } });
    harness = { context, posts, requests, send: message => receive(message), dispose: () => dispose() };
    harness.send({ type: 'setWorkflow', workflow: 'review' });
    await waitFor(() => posts.find(message => message.type === 'workflow' && message.workflow === 'review'), 'review mode');
    return harness;
  }

  async function review(active) {
    active.send({ type: 'send', model: 'review-test', text: '', review: { source: 'staged' } });
    return waitFor(() => active.posts.find(message => message.type === 'assistantDone'), 'review completion');
  }

  test('reviews staged evidence and opens its read-only snapshot without changing files or index', async () => {
    const active = await panel([
      [tool('read_review_file', { path: sourcePath, side: 'target' }),
        tool('search_review_source', { query: 'reject zero' })],
      [tool('submit_review', { summary: 'One actionable defect.', findings: [finding] })],
    ]);
    const before = await git('status', '--porcelain=v1');
    const index = await git('show', `:${sourcePath}`);
    assert.equal((await review(active)).outcome, 'success', JSON.stringify(active.posts));
    assert.equal(active.requests.length, 2);
    const replies = active.requests[1].messages.filter(message => message.role === 'tool');
    assert.equal(replies[0].content, staged);
    assert.match(replies[1].content, /math\.test\.js/);
    const result = active.posts.find(message => message.type === 'reviewResult');
    assert.equal(result.report.testsRun, false);
    assert.equal(result.report.sources[0].content, staged);
    assert.deepEqual(result.report.findings, [finding]);
    assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), working);
    assert.equal(await git('show', `:${sourcePath}`), index);
    assert.equal(await git('status', '--porcelain=v1'), before);
    active.send({ type: 'openReviewReference', reportId: result.id, findingIndex: 0 });
    const editor = await waitFor(() => {
      const candidate = vscode.window.activeTextEditor;
      return candidate?.document.uri.scheme === 'deeplocal-review' && candidate;
    }, 'review source document');
    assert.equal(editor.document.getText(), staged);
    assert.notEqual(vscode.workspace.fs.isWritableFileSystem(editor.document.uri.scheme), true);
    assert.equal(editor.document.isDirty, false);
  });

  for (const [name, args] of [['write_file', { path: sourcePath, content: 'changed' }],
    ['run_command', { command: 'node', args: ['-e', "require('fs').writeFileSync('review-command-ran.txt','bad')"] }],
    ['submit_review', { summary: 'Malformed' }]]) {
    test(`rejects ${name} without modifying Git or producing a report`, async () => {
      const active = await panel([[tool(name, args)]]);
      const before = await git('status', '--porcelain=v1');
      assert.equal((await review(active)).outcome, 'error');
      const error = active.posts.find(message => message.type === 'error');
      assert.match(error.message, name === 'submit_review' ? /Invalid review/ : /not permitted/);
      assert.ok(!active.posts.some(message => message.type === 'reviewResult'));
      await assert.rejects(fs.access(path.join(root, 'review-command-ran.txt')), { code: 'ENOENT' });
      assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), working);
      assert.equal(await git('show', `:${sourcePath}`), staged);
      assert.equal(await git('status', '--porcelain=v1'), before);
    });
  }

  test('handles an empty staged diff without requesting a model', async () => {
    await git('restore', '--source=HEAD', '--staged', '--', sourcePath);
    const active = await panel([]);
    assert.equal((await review(active)).outcome, 'success');
    assert.equal(active.requests.length, 0);
    assert.match(active.posts.find(message => message.type === 'assistantFinal').text, /No staged changes/);
  });

  test('stops an in-flight review and preserves review mode', async () => {
    const active = await panel('wait');
    const finished = review(active);
    await waitFor(() => active.requests.length, 'model request');
    active.send({ type: 'stop' });
    assert.equal((await finished).outcome, 'cancelled');
    assert.ok(!active.posts.some(message => message.type === 'reviewResult'));
    active.posts.length = 0;
    active.send({ type: 'ready' });
    await waitFor(() => active.posts.find(message => message.type === 'workflow' && message.workflow === 'review'), 'preserved review mode');
    assert.equal(await fs.readFile(path.join(root, sourcePath), 'utf8'), working);
  });
});
