const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { buildSync } = require('esbuild');

buildSync({ entryPoints: [path.join(__dirname, '../../src/agent-tools.ts')], bundle: true,
  platform: 'node', format: 'cjs', external: ['vscode', 'koffi'], outfile: path.join(__dirname, '../../out/edit-validation-tools.cjs') });
const { invokeAgentTool } = require('../../out/edit-validation-tools.cjs');

suite('TypeScript edit validation with real documents', () => {
  let folder, directory, collection;
  const uri = name => vscode.Uri.joinPath(directory, name);
  const call = (name, args, options = {}) => invokeAgentTool('edit-validation', name, JSON.stringify(args),
    { workspaceFolder: folder, approvalMode: 'full', ...options });
  const relative = name => path.relative(folder.uri.fsPath, uri(name).fsPath).split(path.sep).join('/');

  async function waitFor(predicate, message, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() > deadline) assert.fail(message);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  suiteSetup(async () => {
    folder = vscode.workspace.workspaceFolders[0];
    directory = vscode.Uri.joinPath(folder.uri, 'issue80-validation');
    await fs.mkdir(directory.fsPath, { recursive: true });
    collection = vscode.languages.createDiagnosticCollection('issue80-validation');
  });

  teardown(async () => {
    collection.clear();
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  suiteTeardown(async () => {
    collection.dispose();
    await fs.rm(directory.fsPath, { recursive: true, force: true });
  });

  test('rejects duplicated imports on create, write and replacement before requesting approval', async () => {
    const original = "import { SnakeRenderer } from './renderer';\nnew SnakeRenderer();\n";
    const duplicate = "import type { SnakeRenderer } from './renderer';\n";
    await fs.writeFile(uri('duplicate.ts').fsPath, original);
    let approvals = 0;
    for (const name of ['create_file', 'write_file', 'replace_in_file']) {
      const args = name === 'replace_in_file'
        ? { path: relative('duplicate.ts'), oldText: 'new SnakeRenderer();', newText: duplicate + 'new SnakeRenderer();' }
        : { path: relative(name === 'create_file' ? 'new-duplicate.ts' : 'duplicate.ts'), content: duplicate + original };
      const result = await call(name, args, { approvalMode: 'every', approve: async () => { approvals++; return true; } });
      assert.equal(result.status, 'error');
      assert.match(result.content, /No change applied/);
      assert.match(result.content, /SnakeRenderer/);
    }
    assert.equal(approvals, 0);
    assert.equal(await fs.readFile(uri('duplicate.ts').fsPath, 'utf8'), original);
    await assert.rejects(fs.stat(uri('new-duplicate.ts').fsPath), { code: 'ENOENT' });
  });

  test('keeps the saved edit while reporting a new dependent-file error after a lint warning resolves', async () => {
    const edited = uri('controlled.ts');
    const dependent = uri('dependent.ts');
    await fs.writeFile(edited.fsPath, 'export const initial = true;\n');
    await fs.writeFile(dependent.fsPath, 'export {};\n');
    const warning = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'Use type-only imports', vscode.DiagnosticSeverity.Warning);
    warning.source = 'eslint';
    collection.set(edited, [warning]);
    const listener = vscode.workspace.onDidSaveTextDocument(document => {
      if (document.uri.toString() !== edited.toString()) return;
      collection.set(edited, []);
      const error = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 1), 'Dependent consumer now fails', vscode.DiagnosticSeverity.Error);
      error.source = 'issue80-test';
      error.code = 9001;
      collection.set(dependent, [error]);
    });
    try {
      const content = 'export const changed = true;\n';
      const result = await call('write_file', { path: relative('controlled.ts'), content });
      assert.equal(result.status, 'error', result.content);
      assert.match(result.content, /saved and retained/);
      assert.match(result.content, /Dependent consumer now fails/);
      assert.match(result.content, /dependent\.ts/);
      assert.equal(await fs.readFile(edited.fsPath, 'utf8'), content);
      assert.equal((await vscode.workspace.openTextDocument(edited)).isDirty, false);
    } finally { listener.dispose(); }
  });

  test('observes the real TypeScript language service when a class import becomes type-only', async () => {
    const typescript = vscode.extensions.getExtension('vscode.typescript-language-features');
    assert.ok(typescript, 'Built-in TypeScript language service is available');
    await typescript.activate();
    await fs.writeFile(uri('tsconfig.json').fsPath, JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['runtime.ts', 'renderer.ts'] }));
    await fs.writeFile(uri('renderer.ts').fsPath, 'export class FoodRenderer {}\n');
    const initial = "import { FoodRenderer } from './renderer';\nexport const renderer = new FoodRenderer();\nconst baseline: string = 123;\n";
    await fs.writeFile(uri('runtime.ts').fsPath, initial);
    const document = await vscode.workspace.openTextDocument(uri('runtime.ts'));
    await vscode.window.showTextDocument(document);
    // Requesting language features ensures the inferred/configured project is loaded.
    await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', document.uri);
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).some(diagnostic => diagnostic.code === 2322), 'TypeScript did not publish the baseline diagnostic');
    const content = initial.replace('import {', 'import type {').replace('const baseline: string = 123;\n', '');
    const result = await call('write_file', { path: relative('runtime.ts'), content });
    await waitFor(() => vscode.languages.getDiagnostics(document.uri).some(diagnostic => diagnostic.code === 1361), 'TypeScript did not report runtime use of a type-only class import');
    assert.equal(await fs.readFile(document.uri.fsPath, 'utf8'), content);
    assert.match(result.content, /saved and retained/);
    assert.match(result.content, /1361/);
    assert.equal(result.status, 'error');
  });
});
