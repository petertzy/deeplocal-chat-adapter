const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { buildSync } = require('esbuild');

// Exercise the actual source against VS Code's real filesystem, edits and URIs.
buildSync({ entryPoints: [path.join(__dirname, '../../src/agent-tools.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode'], outfile: path.join(__dirname, '../../out/workspace-tools.cjs') });
const { invokeAgentTool } = require('../../out/workspace-tools.cjs');

suite('Agent workspace selection with real files', () => {
  let temporary, roots, folders, originalCount;
  const call = (name, args, folder = folders[1], options = {}) => invokeAgentTool('test', name, JSON.stringify(args),
    { workspaceFolder: folder, approvalMode: 'full', ...options });

  async function changeFolders(start, deleteCount, ...additions) {
    const changed = new Promise(resolve => {
      const listener = vscode.workspace.onDidChangeWorkspaceFolders(() => { listener.dispose(); resolve(); });
    });
    assert.equal(vscode.workspace.updateWorkspaceFolders(start, deleteCount, ...additions), true);
    await changed;
  }

  suiteSetup(async () => {
    temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'deeplocal-workspaces-'));
    roots = ['one', 'two'].map(name => vscode.Uri.file(path.join(temporary, name)));
    for (const [index, uri] of roots.entries()) {
      await fs.mkdir(uri.fsPath);
      await fs.writeFile(path.join(uri.fsPath, 'same.txt'), `root-${index}`);
      await fs.writeFile(path.join(uri.fsPath, 'package.json'), JSON.stringify({ scripts: { [`root-${index}`]: 'test' } }));
    }
    originalCount = vscode.workspace.workspaceFolders.length;
    await changeFolders(originalCount, 0, ...roots.map(uri => ({ uri, name: 'duplicate' })));
    folders = roots.map(uri => vscode.workspace.workspaceFolders.find(folder => folder.uri.toString() === uri.toString()));
  });

  setup(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const [index, root] of roots.entries()) {
      // Reset VS Code's document buffer as well as the file, avoiding watcher races.
      const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'same.txt'));
      const edit = new vscode.WorkspaceEdit();
      edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), `root-${index}`);
      assert.equal(await vscode.workspace.applyEdit(edit), true);
      assert.equal(await document.save(), true);
    }
  });

  suiteTeardown(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    const remaining = vscode.workspace.workspaceFolders.length - originalCount;
    if (remaining) await changeFolders(originalCount, remaining);
    await fs.rm(temporary, { recursive: true, force: true });
  });

  test('selects each root despite duplicate names and identical relative filenames', async () => {
    for (let index = 0; index < folders.length; index++) {
      assert.equal((await call('read_file', { path: 'same.txt' }, folders[index])).content, `root-${index}`);
    }
  });

  test('requires explicit selection when several folders are open', async () => {
    const result = await invokeAgentTool('test', 'read_file', '{"path":"same.txt"}');
    assert.equal(result.status, 'error');
    assert.match(result.content, /Choose a workspace folder/);
  });

  test('approved edits, creates, replacements and command cwd use the chosen root', async () => {
    for (const [index, folder] of folders.entries()) {
      const options = { approvalMode: 'every', approve: async () => true };
      assert.equal((await call('write_file', { path: 'same.txt', content: `changed-${index}` }, folder, options)).status, 'success');
      assert.equal((await call('create_file', { path: 'new.txt', content: `created-${index}` }, folder, options)).status, 'success');
      assert.equal((await call('replace_in_file', { path: 'new.txt', oldText: 'created', newText: 'replaced' }, folder, options)).status, 'success');
      const command = process.platform === 'win32' ? 'cmd.exe' : 'pwd';
      const args = process.platform === 'win32' ? ['/d', '/c', 'cd'] : [];
      const result = await call('run_command', { command, args }, folder, options);
      assert.equal(result.status, 'success', result.content);
      assert.equal(result.content.trim(), folder.uri.fsPath);
      assert.equal(await fs.readFile(path.join(folder.uri.fsPath, 'new.txt'), 'utf8'), `replaced-${index}`);
    }
    assert.equal(await fs.readFile(path.join(roots[0].fsPath, 'same.txt'), 'utf8'), 'changed-0');
    assert.equal(await fs.readFile(path.join(roots[1].fsPath, 'same.txt'), 'utf8'), 'changed-1');
  });

  test('does not retarget a command when the options change during approval', async () => {
    const options = { workspaceFolder: folders[1], approvalMode: 'every', approve: async () => {
      options.workspaceFolder = folders[0]; return true;
    } };
    const result = await invokeAgentTool('test', 'run_command', JSON.stringify({ command: process.platform === 'win32' ? 'cmd.exe' : 'pwd',
      args: process.platform === 'win32' ? ['/d', '/c', 'cd'] : [] }), options);
    assert.equal(result.content.trim(), folders[1].uri.fsPath);
  });

  test('scopes listings, search, summaries and diagnostics to the selected root', async () => {
    await fs.writeFile(path.join(roots[0].fsPath, 'only-one.txt'), 'needle private-one');
    await fs.writeFile(path.join(roots[1].fsPath, 'only-two.txt'), 'needle visible-two');
    assert.equal((await call('list_workspace_files', { pattern: 'only-*.txt' })).content, 'only-two.txt');
    assert.equal((await call('list_workspace_files', { pattern: '../one/only-one.txt' })).content, '(no files)');
    const search = await call('search_workspace', { query: 'needle' });
    assert.equal(search.content, 'only-two.txt:1: needle visible-two');
    const summary = await call('get_workspace_summary', {});
    assert.match(summary.content, /root-1/);
    assert.doesNotMatch(summary.content, /root-0/);
    const diagnostics = vscode.languages.createDiagnosticCollection('workspace-test');
    try {
      for (const [index, root] of roots.entries()) diagnostics.set(vscode.Uri.joinPath(root, 'same.txt'), [
        new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), `diagnostic-${index}`),
      ]);
      const result = await call('get_diagnostics', {});
      assert.match(result.content, /same.txt:1:1: Error: diagnostic-1/);
      assert.doesNotMatch(result.content, /diagnostic-0/);
    } finally { diagnostics.dispose(); }
  });

  test('does not disclose an active editor or selection from another root', async () => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(roots[0], 'same.txt'));
    const editor = await vscode.window.showTextDocument(document);
    editor.selection = new vscode.Selection(0, 0, 0, 5);
    for (const name of ['get_active_file', 'get_selection']) {
      assert.match((await call(name, {})).content, /outside the selected workspace/);
    }
    assert.match((await call('get_active_file', {}, folders[0])).content, /Path: same.txt/);
    assert.equal((await call('get_selection', {}, folders[0])).content, 'root-');
  });

  test('rejects traversal, outside absolute paths and URI inputs without touching sibling data', async () => {
    for (const filePath of ['../one/same.txt', '../../outside.txt', roots[0].fsPath + '/same.txt', 'file:///tmp/outside.txt', 'https://example.test/file', 'C:\\outside.txt', '\\\\server\\file']) {
      const result = await call('write_file', { path: filePath, content: 'must not write' });
      assert.equal(result.status, 'error', filePath);
    }
    assert.equal(await fs.readFile(path.join(roots[0].fsPath, 'same.txt'), 'utf8'), 'root-0');
    await fs.writeFile(path.join(roots[1].fsPath, '..allowed.txt'), 'allowed');
    assert.equal((await call('read_file', { path: '..allowed.txt' })).content, 'allowed');
  });

  test('keeps discovery paths relative to the chosen root when another root is nested inside it', async () => {
    const nested = vscode.Uri.joinPath(roots[1], 'nested');
    await fs.mkdir(nested.fsPath);
    await fs.writeFile(path.join(nested.fsPath, 'nested-only.txt'), 'nested');
    const index = vscode.workspace.workspaceFolders.length;
    await changeFolders(index, 0, { uri: nested, name: 'nested' });
    try {
      assert.equal((await call('list_workspace_files', { pattern: '**/nested-only.txt' })).content, 'nested/nested-only.txt');
      assert.equal((await call('read_file', { path: 'nested/nested-only.txt' })).content, 'nested');
    } finally { await changeFolders(index, 1); }
  });

  test('opens files in the chosen root and preserves existing symlink following', async function () {
    const opened = await call('open_file', { path: 'same.txt' });
    assert.equal(opened.content, 'Opened same.txt.');
    assert.equal(vscode.window.activeTextEditor.document.uri.fsPath, path.join(roots[1].fsPath, 'same.txt'));
    if (process.platform === 'win32') { this.skip(); return; }
    // This selector retains the existing filesystem boundary: symlinks are followed.
    // It is not an OS sandbox, just as command cwd does not restrict command arguments.
    await fs.symlink(path.join(roots[0].fsPath, 'same.txt'), path.join(roots[1].fsPath, 'linked.txt'));
    assert.equal((await call('read_file', { path: 'linked.txt' })).content, 'root-0');
  });

  test('preserves binary rejection and upper limits in the selected root', async () => {
    await fs.writeFile(path.join(roots[1].fsPath, 'binary.bin'), Buffer.from([0, 255]));
    assert.equal((await call('read_file', { path: 'binary.bin', maxChars: 1 })).content,
      'Tool error: Cannot read binary.bin: binary or unsupported file (expected UTF-8 text).');
    await fs.writeFile(path.join(roots[1].fsPath, 'large.txt'), 'x'.repeat(70000));
    assert.equal((await call('read_file', { path: 'large.txt', maxChars: 1e9 })).content.length, 60000 + '\n\n... truncated ...'.length);
  });

  test('cancellation or declined approval never edits the selected file', async () => {
    const controller = new AbortController();
    const result = await call('write_file', { path: 'same.txt', content: 'cancelled' }, folders[1], {
      approvalMode: 'every', signal: controller.signal, approve: async () => { controller.abort(); return true; },
    });
    assert.equal(result.status, 'error');
    assert.equal((await call('write_file', { path: 'same.txt', content: 'declined' }, folders[1], {
      approvalMode: 'every', approve: async () => false,
    })).status, 'declined');
    assert.equal(await fs.readFile(path.join(roots[1].fsPath, 'same.txt'), 'utf8'), 'root-1');
  });

  test('a removed folder during approval blocks writes and future invocations', async () => {
    const result = await call('write_file', { path: 'same.txt', content: 'removed' }, folders[1], {
      approvalMode: 'every', approve: async () => { await changeFolders(folders[1].index, 1); return true; },
    });
    assert.equal(result.status, 'error');
    assert.match(result.content, /removed/);
    assert.equal((await call('read_file', { path: 'same.txt' })).status, 'error');
    assert.equal(await fs.readFile(path.join(roots[1].fsPath, 'same.txt'), 'utf8'), 'root-1');
    assert.equal(await fs.readFile(path.join(roots[0].fsPath, 'same.txt'), 'utf8'), 'root-0');
  });
});
