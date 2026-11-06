const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const nativeFs = require('node:fs');
const koffi = require('koffi');
const os = require('node:os');
const path = require('node:path');
const vscode = require('vscode');
const { buildSync } = require('esbuild');

async function assertSameDirectory(actual, expected) {
  assert.equal(
    await fs.realpath(actual),
    await fs.realpath(expected),
  );
}

// Exercise the actual source against VS Code's real filesystem, edits and URIs.
buildSync({ entryPoints: [path.join(__dirname, '../../src/agent-tools.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode', 'koffi'], outfile: path.join(__dirname, '../../out/workspace-tools.cjs') });
const { invokeAgentTool, toolResultsToMessages, verifyResearchSources } = require('../../out/workspace-tools.cjs');
buildSync({ entryPoints: [path.join(__dirname, '../../src/subagent-runner.ts')], bundle: true,
  platform: 'node', format: 'cjs', outfile: path.join(__dirname, '../../out/workspace-subagent.cjs') });
const { runSubagent } = require('../../out/workspace-subagent.cjs');

function researchChild(folder, tool, args, controller = new AbortController(), calls) {
  const requests = [], results = [], pending = [];
  const task = { title: 'Inspect fixture', objective: 'Inspect assigned sources', context: '', paths: ['src'], tools: [tool] };
  const toolCall = (name, value, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(value) } });
  const options = {
    requestId: 'fixture-parent', model: 'fixture', signal: controller.signal,
    limits: { maxTurns: 2, maxOutputTokens: 8192 }, maxOutputTokens: 2048,
    stream: async function* (_id, request) {
      requests.push(structuredClone(request));
      const turnCalls = requests.length === 1 ? calls || [toolCall(tool, args, 'source')]
        : [toolCall('submit_research', { findings: [], limitations: [] }, 'submission')];
      for (const value of turnCalls) yield { kind: 'toolCall', value };
    },
    invoke: (_task, call, signal) => {
      const operation = invokeAgentTool(call.id, call.function.name, call.function.arguments,
        { workspaceFolder: folder, approvalMode: 'full', signal, researchPolicy: task })
        .then(result => { results.push(result); return result; });
      pending.push(operation);
      return operation;
    },
    cancel() {}, reserve() {}, onActivity() {},
  };
  return { requests, results, pending, run: () => runSubagent({ id: 'fixture-child', task,
    signal: controller.signal, options, reserveOutput: value => value }) };
}

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
    temporary = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deeplocal-workspaces-')));
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
      const commandResult = JSON.parse(result.content);
      assert.equal(commandResult.exitCode, 0);
      await assertSameDirectory(commandResult.cwd, folder.uri.fsPath);
      await assertSameDirectory(commandResult.stdout.trim(), folder.uri.fsPath);
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
    const commandResult = JSON.parse(result.content);
    await assertSameDirectory(commandResult.cwd, folders[1].uri.fsPath);
    await assertSameDirectory(commandResult.stdout.trim(), folders[1].uri.fsPath);
  });

  test('failed commands preserve separate diagnostics and actual exit codes for model tool messages', async () => {
    for (const exitCode of [0, 1]) {
      const result = await call('run_command', { command: 'node', args: ['-e', `process.stdout.write('src/main.ts:8 lint failure\\n');process.stderr.write('stderr detail\\n');process.exitCode=${exitCode}`] });
      assert.equal(result.status, exitCode ? 'error' : 'success');
      const value = JSON.parse(result.content);
      assert.equal(value.exitCode, exitCode);
      assert.equal(value.stdout, 'src/main.ts:8 lint failure\n');
      assert.equal(value.stderr, 'stderr detail\n');
      assert.equal(value.error, null);
      await assertSameDirectory(value.cwd, folders[1].uri.fsPath);
      assert.deepEqual(toolResultsToMessages([result]), [{ role: 'tool', tool_call_id: 'test', content: result.content }]);
    }
    const missing = await call('run_command', { command: 'missing-synthetic-command-78', args: [] });
    assert.equal(missing.status, 'error');
    assert.equal(JSON.parse(missing.content).error.code, 'ENOENT');
    assert.equal(JSON.parse(missing.content).exitCode, null);
  });

  test('command cancellation retains partial output and denied/pre-cancelled commands never launch', async () => {
    const controller = new AbortController();
    const marker = path.join(folders[1].uri.fsPath, 'command-ready');
    const pending = call('run_command', { command: 'node', args: ['-e', "require('fs').writeSync(1,'partial output\\n');require('fs').writeFileSync('command-ready','ready');setInterval(()=>{},1000)"] }, folders[1], { signal: controller.signal });
    try {
      const deadline = Date.now() + 5000;
      while (true) {
        try { await fs.access(marker); break; } catch {
          assert.ok(Date.now() < deadline, 'command must start before cancellation');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    } finally { controller.abort(); }
    const result = await pending;
    assert.equal(result.status, 'error');
    assert.equal(JSON.parse(result.content).stdout, 'partial output\n');
    assert.equal(JSON.parse(result.content).cancelled, true);
    const args = { command: 'node', args: ['-e', "require('fs').writeFileSync('unexpected-command','executed')"] };
    const denied = await call('run_command', args, folders[1], { approvalMode: 'every', approve: async () => false });
    assert.equal(denied.status, 'declined');
    const cancelled = await call('run_command', args, folders[1], { signal: controller.signal });
    assert.equal(JSON.parse(cancelled.content).cancelled, true);
    await assert.rejects(fs.access(path.join(folders[1].uri.fsPath, 'unexpected-command')));
  });

  test('command output is redacted before model/display results while keeping lint errors useful', async () => {
    const sentinel = 'syntheticCredential78';
    await fs.writeFile(path.join(folders[1].uri.fsPath, 'synthetic-diagnostics.txt'), 'API_KEY=' + sentinel + '\nsrc/main.ts:8 lint failure\n');
    const result = await call('run_command', { command: 'node', args: ['-e', "process.stdout.write(require('fs').readFileSync('synthetic-diagnostics.txt'));process.stderr.write('stderr failure');process.exitCode=1"] });
    assert.doesNotMatch(result.content, new RegExp(sentinel));
    assert.match(JSON.parse(result.content).stdout, /API_KEY=\[redacted\]/);
    assert.match(JSON.parse(result.content).stdout, /src\/main.ts:8 lint failure/);
    assert.equal(JSON.parse(result.content).stderr, 'stderr failure');
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

  test('research stays scoped and read-only under full access and verifies observed bytes', async () => {
    const researchPolicy = { tools: ['read_file', 'search_workspace', 'list_workspace_files'], paths: ['same.txt'] };
    const options = { approvalMode: 'full', researchPolicy, workspaceFolder: folders[1] };
    if (process.platform !== 'linux' && process.platform !== 'darwin') {
      const originalReadFile = nativeFs.readFile;
      const originalLoad = koffi.load;
      let descriptorReads = 0, nativeLoads = 0;
      try {
        nativeFs.readFile = function (file, ...args) {
          if (typeof file === 'number') descriptorReads++;
          return originalReadFile.call(this, file, ...args);
        };
        koffi.load = function (...args) { nativeLoads++; return originalLoad.apply(this, args); };
        const read = await call('read_file', { path: 'same.txt' }, folders[1], options);
        assert.equal(read.status, 'error');
        assert.match(read.content, /Scoped research is unavailable on this platform/);
        assert.doesNotMatch(read.content, /root-1/);
        assert.deepEqual(read.researchSources || [], []);
        const search = await call('search_workspace', { query: 'root-' }, folders[1], options);
        assert.equal(search.status, 'success', search.content);
        assert.match(search.content, /coverage is incomplete/);
        assert.doesNotMatch(search.content, /root-1/);
        assert.deepEqual(search.researchSources || [], []);
        assert.equal(descriptorReads, 0, 'unsupported research must not read any descriptor');
        assert.equal(nativeLoads, 0, 'unsupported research must reject before loading a native library');
        assert.equal((await call('read_file', { path: 'package.json' }, folders[1], options)).status, 'error');
        for (const name of ['write_file', 'delete_file', 'run_command']) {
          assert.equal((await call(name, { path: 'same.txt', content: 'forbidden', command: process.execPath, args: ['-e', 'process.exit(1)'] }, folders[1], options)).status, 'error');
        }
        assert.equal((await call('list_workspace_files', {}, folders[1], options)).content, 'same.txt');
        assert.equal(await fs.readFile(path.join(roots[1].fsPath, 'same.txt'), 'utf8'), 'root-1');
      } finally {
        nativeFs.readFile = originalReadFile;
        koffi.load = originalLoad;
      }
      return;
    }
    const read = await call('read_file', { path: 'same.txt' }, folders[1], options);
    assert.equal(read.status, 'success');
    assert.equal(read.content, 'root-1');
    await verifyResearchSources(read.researchSources, options);
    assert.equal((await call('read_file', { path: 'package.json' }, folders[1], options)).status, 'error');
    for (const name of ['write_file', 'delete_file', 'run_command']) {
      assert.equal((await call(name, { path: 'same.txt', content: 'forbidden', command: process.execPath, args: ['-e', 'process.exit(1)'] }, folders[1], options)).status, 'error');
    }
    assert.equal(await fs.readFile(path.join(roots[1].fsPath, 'same.txt'), 'utf8'), 'root-1');
    const listing = await call('list_workspace_files', {}, folders[1], options);
    assert.equal(listing.content, 'same.txt');
    const search = await call('search_workspace', { query: 'root-' }, folders[1], options);
    assert.match(search.content, /same.txt:1: root-1/);
    assert.doesNotMatch(search.content, /root-0/);
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(roots[1], 'same.txt'));
    const change = new vscode.WorkspaceEdit();
    change.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), 'changed after research');
    assert.equal(await vscode.workspace.applyEdit(change), true);
    assert.equal(await document.save(), true);
    await assert.rejects(verifyResearchSources(read.researchSources, options), /Research evidence changed/);
    const controller = new AbortController();
    controller.abort();
    assert.equal((await call('search_workspace', { query: 'root-' }, folders[1], { ...options, signal: controller.signal })).status, 'error');
  });

  for (const name of ['read_file', 'search_workspace']) {
    for (const replacement of ['hardlink', 'junction']) {
      test(`research ${name} rejects an outside ${replacement} substitution even after the validated path is restored`, async function () {
        if (process.platform !== 'linux' && process.platform !== 'darwin') { this.skip(); return; }
        const prefix = `research-open-race-${name}-${replacement}`;
        const insideDirectory = path.join(roots[1].fsPath, prefix);
        const parkedDirectory = path.join(roots[1].fsPath, `${prefix}-parked`);
        const outsideDirectory = path.join(roots[0].fsPath, prefix);
        const target = path.join(insideDirectory, 'source.txt');
        const parkedFile = path.join(insideDirectory, 'source-original.txt');
        const outsideFile = path.join(outsideDirectory, 'source.txt');
        const sentinel = `OUTSIDE_RESEARCH_SENTINEL_${name}_${replacement}`;
        await fs.mkdir(insideDirectory);
        await fs.mkdir(outsideDirectory);
        await fs.writeFile(target, 'allowed research source');
        await fs.writeFile(outsideFile, sentinel);
        const originalLoad = koffi.load;
        const originalReadFile = nativeFs.readFile;
        const descriptors = new Map();
        let intercepted = 0, readCalls = 0, closeCalls = 0;
        let parked = false, linked = false, openedDescriptor, openedLifetime, traversalLifetime, nativeClose;
        function restoreTarget() {
          if (linked) {
            // Unlink the directory symlink itself, never its target.
            nativeFs.unlinkSync(replacement === 'hardlink' ? target : insideDirectory);
            linked = false;
          }
          if (parked) {
            nativeFs.renameSync(replacement === 'hardlink' ? parkedFile : parkedDirectory,
              replacement === 'hardlink' ? target : insideDirectory);
            parked = false;
          }
        }
        try {
          nativeFs.readFile = function (file, ...args) {
            if (typeof file === 'number' && descriptors.has(file)) readCalls++;
            return originalReadFile.call(this, file, ...args);
          };
          koffi.load = function (...loadArgs) {
            const library = originalLoad.apply(this, loadArgs);
            return {
              func(signature) {
                const native = library.func(signature);
                if (signature === 'int close(int)') {
                  nativeClose = native;
                  return fd => {
                    if (descriptors.get(fd) === (replacement === 'hardlink' ? openedLifetime : traversalLifetime)) closeCalls++;
                    const result = native(fd);
                    if (result === 0) descriptors.delete(fd);
                    return result;
                  };
                }
                if (signature !== 'int openat(int, const char *, int, int)') return native;
                return (parent, file, flags, mode) => {
                  const interceptedName = replacement === 'hardlink' ? 'source.txt' : prefix;
                  if (file !== interceptedName) {
                    const fd = native(parent, file, flags, mode);
                    if (fd >= 0) descriptors.set(fd, {});
                    return fd;
                  }
                  assert.equal(++intercepted, 1, 'intercept exactly the scoped native openat');
                  traversalLifetime = descriptors.get(parent);
                  assert.ok(traversalLifetime, 'parent must have a live owned descriptor');
                  // Path checks are complete. Restore the approved names before
                  // returning from openat so subsequent validation sees them.
                  try {
                    nativeFs.renameSync(replacement === 'hardlink' ? target : insideDirectory,
                      replacement === 'hardlink' ? parkedFile : parkedDirectory);
                    parked = true;
                    if (replacement === 'hardlink') nativeFs.linkSync(outsideFile, target);
                    else nativeFs.symlinkSync(outsideDirectory, insideDirectory, 'dir');
                    linked = true;
                    openedDescriptor = native(parent, file, flags, mode);
                    if (openedDescriptor >= 0) {
                      openedLifetime = {};
                      descriptors.set(openedDescriptor, openedLifetime);
                    }
                    if (replacement === 'hardlink') {
                      assert.ok(openedDescriptor >= 0, 'native openat must open a real descriptor');
                      const actual = nativeFs.fstatSync(openedDescriptor, { bigint: true });
                      const outside = nativeFs.statSync(outsideFile, { bigint: true });
                      assert.equal(actual.dev, outside.dev, 'fixture must open the sibling workspace object');
                      assert.equal(actual.ino, outside.ino, 'fixture must open the sibling workspace object');
                    } else {
                      assert.ok(flags & nativeFs.constants.O_NOFOLLOW, 'directory traversal must forbid symlinks');
                      assert.equal(openedDescriptor, -1, 'native openat must reject the substituted directory symlink');
                    }
                  } finally { restoreTarget(); }
                  assert.equal(nativeFs.readFileSync(target, 'utf8'), 'allowed research source',
                    'approved path is restored before validation resumes');
                  return openedDescriptor;
                };
              },
            };
          };
          const result = await call(name, name === 'read_file' ? { path: `${prefix}/source.txt` } : { query: 'OUTSIDE_RESEARCH_SENTINEL' }, folders[1], {
            approvalMode: 'full', researchPolicy: { tools: [name], paths: [prefix] },
          });
          assert.equal(intercepted, 1, 'exercise the actual production native openat path');
          assert.equal(readCalls, 0, 'outside descriptor must be rejected before reading any bytes');
          assert.equal(closeCalls, 1, replacement === 'hardlink'
            ? 'rejected outside descriptor must be closed' : 'directory descriptor must close after traversal rejection');
          assert.equal(descriptors.size, 0, 'all native descriptors must be closed');
          assert.doesNotMatch(result.content, /OUTSIDE_RESEARCH_SENTINEL/);
          assert.deepEqual(result.researchSources || [], [], 'wrong descriptor must never produce a source fingerprint');
          if (name === 'read_file') assert.equal(result.status, 'error', result.content);
          else {
            assert.equal(result.status, 'success', result.content);
            assert.match(result.content, /coverage is incomplete/);
          }
        } finally {
          koffi.load = originalLoad;
          nativeFs.readFile = originalReadFile;
          if (nativeClose) for (const fd of descriptors.keys()) nativeClose(fd);
          restoreTarget();
          // These exact fixture directories are the only recursive cleanup targets.
          assert.equal(path.dirname(path.resolve(insideDirectory)), path.resolve(roots[1].fsPath));
          assert.equal(path.dirname(path.resolve(outsideDirectory)), path.resolve(roots[0].fsPath));
          await fs.rm(insideDirectory, { recursive: true, force: true });
          await fs.rm(outsideDirectory, { recursive: true, force: true });
        }
      });
    }
  }

  for (const tool of ['read_file', 'search_workspace']) {
    for (const admission of ['poisoned-metadata', 'ancestor-open', 'workspace-open']) {
      test(`research ${tool} rejects ${admission} with unchanged directory timestamps before child continuation`, async function () {
        if (process.platform !== 'linux' && process.platform !== 'darwin') { this.skip(); return; }
        const fixture = path.join(temporary, `admission-${tool}-${admission}`);
        const admitted = path.join(fixture, 'admitted'), parked = path.join(fixture, 'parked');
        const excluded = path.join(fixture, 'excluded'), workspace = path.join(admitted, 'workspace');
        const source = path.join(workspace, 'src/source.txt');
        const sentinel = 'EXCLUDED_ADMISSION_SENTINEL';
        await fs.mkdir(path.dirname(source), { recursive: true });
        await fs.mkdir(path.join(excluded, 'workspace/src'), { recursive: true });
        await fs.writeFile(source, 'allowed source');
        await fs.writeFile(path.join(excluded, 'workspace/src/source.txt'), sentinel);
        const index = vscode.workspace.workspaceFolders.length;
        await changeFolders(index, 0, { uri: vscode.Uri.file(workspace), name: 'admission' });
        const folder = vscode.workspace.workspaceFolders[index];
        const originalLstat = fs.lstat, originalLoad = koffi.load, originalRead = nativeFs.readFile;
        const times = new Map(), live = new Map();
        let substitutions = 0, frozenStats = 0, reads = 0, nativeClose;
        function substitute(operation) {
          substitutions++;
          const victim = admission === 'workspace-open' ? workspace : admitted;
          const destination = admission === 'workspace-open' ? path.join(excluded, 'workspace') : excluded;
          nativeFs.renameSync(victim, parked);
          nativeFs.symlinkSync(destination, victim, 'dir');
          try { return operation(); }
          finally { nativeFs.unlinkSync(victim); nativeFs.renameSync(parked, victim); }
        }
        try {
          fs.lstat = async function (target, options) {
            const name = String(target);
            const stat = admission === 'poisoned-metadata' && (name === workspace || name.startsWith(workspace + path.sep))
              ? substitute(() => nativeFs.lstatSync(target, options)) : await originalLstat.call(this, target, options);
            if (stat.isDirectory() && typeof stat.ctimeNs === 'bigint') {
              const before = times.get(name) || { ctimeNs: stat.ctimeNs, mtimeNs: stat.mtimeNs };
              times.set(name, before);
              Object.assign(stat, before);
              frozenStats++;
            }
            return stat;
          };
          nativeFs.readFile = function (file, ...args) {
            if (typeof file === 'number' && live.has(file)) reads++;
            return originalRead.call(this, file, ...args);
          };
          koffi.load = function (...args) {
            const library = originalLoad.apply(this, args);
            return { func(signature) {
              const native = library.func(signature);
              if (signature === 'int close(int)') {
                nativeClose = native;
                return fd => {
                  assert.ok(live.has(fd), 'close must own the current descriptor lifetime');
                  const result = native(fd);
                  assert.equal(result, 0);
                  live.delete(fd);
                  return result;
                };
              }
              if (signature !== 'int openat(int, const char *, int, int)') return native;
              return (parent, name, flags, mode) => {
                const intercept = admission === 'ancestor-open' ? name === 'admitted'
                  : admission === 'workspace-open' ? name === 'workspace' : name === workspace;
                // The absolute-path branch exercises the previously unsafe implementation too.
                const fd = intercept ? substitute(() => native(parent, name, flags, mode)) : native(parent, name, flags, mode);
                if (fd >= 0) {
                  assert.ok(!live.has(fd), 'fd reuse must begin a new owned lifetime');
                  live.set(fd, {});
                }
                return fd;
              };
            } };
          };
          const child = researchChild(folder, tool, tool === 'read_file' ? { path: 'src/source.txt' } : { query: sentinel });
          const result = await child.run();
          assert.ok(substitutions > 0, 'exercise the real filesystem substitution');
          assert.ok(frozenStats > 0, 'exercise metadata observations with held directory timestamps');
          assert.equal(reads, 0, 'reject admission before reading any content');
          assert.equal(live.size, 0, 'all acquired native descriptor lifetimes must close');
          assert.equal(child.requests.length, 2, 'inspect the actual next child-model request');
          const forwarded = child.requests[1].messages.filter(message => message.role === 'tool');
          assert.equal(forwarded.length, 1);
          assert.doesNotMatch(JSON.stringify(forwarded), new RegExp(sentinel));
          assert.deepEqual(child.results[0].researchSources || [], []);
          assert.deepEqual(result.findings, []);
          assert.equal(result.state, 'completed');
          assert.equal(nativeFs.readFileSync(source, 'utf8'), 'allowed source');
        } finally {
          fs.lstat = originalLstat;
          koffi.load = originalLoad;
          nativeFs.readFile = originalRead;
          if (nativeClose) for (const fd of live.keys()) nativeClose(fd);
          await changeFolders(index, 1);
          assert.equal(path.dirname(path.resolve(fixture)), path.resolve(temporary));
          await fs.rm(fixture, { recursive: true, force: true });
        }
      });
    }
  }

  test('research rejects a workspace alias and directs users to its canonical directory', async function () {
    if (process.platform !== 'linux' && process.platform !== 'darwin') { this.skip(); return; }
    const alias = path.join(temporary, 'research-alias');
    await fs.symlink(roots[1].fsPath, alias, 'dir');
    const index = vscode.workspace.workspaceFolders.length;
    await changeFolders(index, 0, { uri: vscode.Uri.file(alias), name: 'alias' });
    try {
      const result = await call('read_file', { path: 'same.txt' }, vscode.workspace.workspaceFolders[index],
        { researchPolicy: { tools: ['read_file'], paths: ['same.txt'] } });
      assert.equal(result.status, 'error');
      assert.match(result.content, /symbolic links/i);
      assert.match(result.content, /canonical directory/i);
      assert.deepEqual(result.researchSources || [], []);
    } finally { await changeFolders(index, 1); await fs.unlink(alias); }
  });

  for (const tool of ['read_file', 'search_workspace']) {
    test(`research ${tool} aborts the actual descriptor read before another source or evidence`, async function () {
      if (process.platform !== 'linux' && process.platform !== 'darwin') { this.skip(); return; }
      const fixture = path.join(temporary, `cancel-${tool}`);
      const sourceBytes = 2 * 1024 * 1024;
      await fs.mkdir(path.join(fixture, 'src'), { recursive: true });
      await fs.writeFile(path.join(fixture, 'src/a.txt'), Buffer.alloc(sourceBytes, 65));
      await fs.writeFile(path.join(fixture, 'src/b.txt'), 'second source must not be read');
      const index = vscode.workspace.workspaceFolders.length;
      await changeFolders(index, 0, { uri: vscode.Uri.file(fixture), name: 'cancel' });
      const folder = vscode.workspace.workspaceFolders[index], controller = new AbortController();
      const originalRead = nativeFs.readFile, originalLoad = koffi.load;
      const live = new Map();
      let reads = 0, callbacks = 0, abortCode, callbackAborted = false, bytesAfterAbort = 0, readLifetime, nativeClose;
      try {
        koffi.load = function (...args) {
          const library = originalLoad.apply(this, args);
          return { func(signature) {
            const native = library.func(signature);
            if (signature === 'int close(int)') {
              nativeClose = native;
              return fd => {
                const lifetime = live.get(fd);
                assert.ok(lifetime, 'close must own a live descriptor');
                if (lifetime === readLifetime) assert.equal(callbacks, 1, 'read callback must settle before close');
                const result = native(fd);
                assert.equal(result, 0);
                live.delete(fd);
                return result;
              };
            }
            if (signature !== 'int openat(int, const char *, int, int)') return native;
            return (...openArgs) => {
              const fd = native(...openArgs);
              if (fd >= 0) { assert.ok(!live.has(fd)); live.set(fd, {}); }
              return fd;
            };
          } };
        };
        nativeFs.readFile = function (file, ...args) {
          if (typeof file !== 'number' || !live.has(file)) return originalRead.call(this, file, ...args);
          reads++;
          readLifetime = live.get(file);
          const callback = args.pop();
          assert.equal(args[0]?.signal, controller.signal, 'pass Stop signal into Node descriptor read');
          const result = originalRead.call(this, file, ...args, (error, bytes) => {
            callbacks++;
            abortCode = error?.code;
            callbackAborted = controller.signal.aborted;
            if (controller.signal.aborted && bytes) bytesAfterAbort += bytes.length;
            callback(error, bytes);
          });
          controller.abort(new Error('Fixture Stop'));
          return result;
        };
        const calls = tool === 'read_file' ? ['a', 'b'].map(name => ({ id: name, type: 'function',
          function: { name: tool, arguments: JSON.stringify({ path: `src/${name}.txt` }) } })) : undefined;
        const child = researchChild(folder, tool, tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'A' }, controller, calls);
        const result = await child.run();
        await Promise.all(child.pending); // Child cancellation may beat native cleanup.
        assert.equal(reads, 1, 'no subsequent source starts reading');
        assert.equal(callbacks, 1, 'exercise the actual asynchronous read callback');
        assert.equal(callbackAborted, true, 'actual read callback must observe the aborted signal');
        // Some Node versions drop AbortError for caller-owned numeric fds.
        // In either case the actual read must stop buffering the assigned file.
        assert.ok(abortCode === undefined || abortCode === 'ABORT_ERR', `unexpected read error: ${abortCode}`);
        assert.ok(bytesAfterAbort < sourceBytes, 'abort must stop buffering before the complete source is read');
        assert.equal(live.size, 0);
        assert.equal(child.requests.length, 1, 'cancelled content never reaches another model request');
        assert.equal(result.state, 'cancelled');
        assert.deepEqual(result.findings, []);
        for (const outcome of child.results) assert.deepEqual(outcome.researchSources || [], []);
      } finally {
        nativeFs.readFile = originalRead;
        koffi.load = originalLoad;
        if (nativeClose) for (const fd of live.keys()) nativeClose(fd);
        await changeFolders(index, 1);
        assert.equal(path.dirname(path.resolve(fixture)), path.resolve(temporary));
        await fs.rm(fixture, { recursive: true, force: true });
      }
    });
  }

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
