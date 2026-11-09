const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vscode = require('vscode');
const { buildSync } = require('esbuild');

const repository = path.join(__dirname, '../..');
const outfile = path.join(repository, 'out/project-verification-host.cjs');
buildSync({ stdin: { contents: "export { invokeAgentTool } from './src/agent-tools'; export { TaskEvidence } from './src/task-evidence';", resolveDir: repository },
  bundle: true, platform: 'node', format: 'cjs', external: ['vscode', 'koffi'], outfile });
const { invokeAgentTool, TaskEvidence } = require(outfile);

suite('Project verification with real metadata and processes', () => {
  let folder, safeProject, unsafeProject, preferences;
  const call = (name, args, options = {}) => invokeAgentTool('verification', name, JSON.stringify(args),
    { workspaceFolder: folder, approvalMode: 'safe', ...options });

  suiteSetup(async () => {
    folder = vscode.workspace.workspaceFolders[0];
    safeProject = 'project-verification/safe project';
    unsafeProject = 'project-verification/unsafe';
    for (const relative of [safeProject, unsafeProject]) await fs.mkdir(path.join(folder.uri.fsPath, relative), { recursive: true });
    await fs.writeFile(path.join(folder.uri.fsPath, safeProject, 'package.json'), JSON.stringify({ scripts: {
      lint: 'node check.cjs lint', 'check-types': 'node check.cjs typecheck',
      build: 'node check.cjs build', test: 'node check.cjs test',
    } }));
    await fs.writeFile(path.join(folder.uri.fsPath, safeProject, 'check.cjs'),
      "console.log(process.argv[2]); process.exitCode = process.argv[2] === 'build' ? 1 : 0;");
    await fs.writeFile(path.join(folder.uri.fsPath, unsafeProject, 'package.json'), JSON.stringify({ scripts: {
      lint: 'npm run deploy', deploy: 'node deploy.cjs',
    } }));
    await fs.writeFile(path.join(folder.uri.fsPath, unsafeProject, 'deploy.cjs'), "require('fs').writeFileSync('started', 'unexpected');");
    preferences = vscode.workspace.getConfiguration('deeplocal', folder.uri).inspect('verificationPreferences')?.workspaceFolderValue;
  });

  suiteTeardown(async () => {
    await vscode.workspace.getConfiguration('deeplocal', folder.uri).update('verificationPreferences', preferences, vscode.ConfigurationTarget.WorkspaceFolder);
  });

  test('discovers nested manifests without executing scripts or inventing missing checks', async () => {
    const result = await call('discover_verification_commands', {});
    assert.equal(result.status, 'success', result.content);
    const report = JSON.parse(result.content);
    const checks = report.commands.filter(item => item.project === safeProject + '/package.json');
    assert.deepEqual(checks.map(item => item.category), ['lint', 'typecheck', 'build', 'test']);
    assert.ok(report.inspected.includes(safeProject + '/package.json'));
    assert.ok(report.skippedUnsafe.some(item => item.project === unsafeProject + '/package.json'));
    assert.ok(!report.commands.some(item => item.project === unsafeProject + '/package.json'));
    assert.ok(report.missing.some(item => item.project === unsafeProject + '/package.json' && item.category === 'test'));
    await assert.rejects(fs.access(path.join(folder.uri.fsPath, unsafeProject, 'started')));
  });

  test('honors the selected folder verification preferences', async () => {
    const configuration = vscode.workspace.getConfiguration('deeplocal', folder.uri);
    try {
      await configuration.update('verificationPreferences', ['lint'], vscode.ConfigurationTarget.WorkspaceFolder);
      const report = JSON.parse((await call('discover_verification_commands', {})).content);
      assert.deepEqual(report.preferences, ['lint']);
      assert.ok(report.commands.every(item => item.category === 'lint'));
    } finally {
      await configuration.update('verificationPreferences', preferences, vscode.ConfigurationTarget.WorkspaceFolder);
    }
  });

  test('keeps a failed build independent of passing lint, type checking and tests', async () => {
    const report = JSON.parse((await call('discover_verification_commands', {})).content);
    const checks = report.commands.filter(item => item.project === safeProject + '/package.json');
    const evidence = new TaskEvidence();
    for (const category of ['build', 'lint', 'typecheck', 'test']) {
      const check = checks.find(item => item.category === category);
      assert.ok(check, category + ' should be discovered');
      const args = { command: check.command, args: check.args, verification: true };
      const invocation = { id: category, type: 'function', function: { name: 'run_command', arguments: JSON.stringify(args) } };
      const result = await invokeAgentTool(category, 'run_command', invocation.function.arguments, { workspaceFolder: folder, approvalMode: 'full' });
      assert.equal(result.command?.exitCode, category === 'build' ? 1 : 0, result.content);
      evidence.record(invocation, result);
    }
    const final = evidence.report(JSON.stringify({ checks: checks.map(({ command, args }) => ({ command, args })), nextSteps: '' }));
    assert.equal(final.verification, 'failed');
    assert.deepEqual(final.checks.map(check => check.state), ['failed', 'passed', 'passed', 'passed']);
    assert.equal(final.attempts.length, 4);
  });

  test('requires approval before a manually requested unsafe delegated script executes', async () => {
    let approvals = 0;
    const result = await call('run_command', { command: 'npm', args: ['--prefix', unsafeProject, 'run', 'lint'] },
      { approve: async () => { approvals++; return false; } });
    assert.equal(result.status, 'declined', result.content);
    assert.equal(approvals, 1);
    await assert.rejects(fs.access(path.join(folder.uri.fsPath, unsafeProject, 'started')));
  });
});
