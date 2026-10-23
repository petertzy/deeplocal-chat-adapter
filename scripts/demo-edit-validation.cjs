const fs = require('node:fs/promises');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runTests } = require('@vscode/test-electron');
const { buildSync } = require('esbuild');
const { createDemoServer, model, original, renderers } = require('./demo-edit-validation-fixture.cjs');

const repository = path.resolve(__dirname, '..');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('npm run demo:edit-validation [-- --verify]\nDefault: open an isolated VS Code window; send "Run demo" in DeepLocal.\n--verify: exercise the same HTTP provider and agent workflow automatically, then exit.');
    return;
  }
  if (args.some(arg => arg !== '--verify')) throw new Error('Unknown argument. Use --help.');
  const verify = args.includes('--verify');
  console.log('Building the extension and demo harness...');
  execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit'], { cwd: repository, stdio: 'inherit', windowsHide: true });
  execFileSync(process.execPath, [path.join(repository, 'esbuild.js')], { cwd: repository, stdio: 'inherit', windowsHide: true });
  const parent = path.join(repository, '.vscode-test', 'issue80-demo');
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, 'run-'));
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(path.join(workspace, '.vscode'), { recursive: true });
  await fs.writeFile(path.join(workspace, 'game.ts'), original);
  await fs.writeFile(path.join(workspace, 'renderers.ts'), renderers);
  await fs.writeFile(path.join(workspace, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ['*.ts'] }, null, 2));
  const guide = '# Issue #80: scripted edit-validation demo\n\n'
    + 'This workspace is disposable. The local scripted provider needs no API key or model.\n\n'
    + '1. Wait for the "demo ready" message.\n'
    + '2. In the DeepLocal sidebar, select `issue80-scripted-demo`. Keep **Build / Ask** and **Safe auto** selected.\n'
    + '3. Send exactly: **Run demo**.\n\n'
    + 'The agent deliberately makes two bad edits, then repairs them. Expand the tool cards:\n\n'
    + '- **Duplicate imports:** rejected before saving; all four identifiers are named.\n'
    + '- **Runtime import misuse:** the original TS2322 error is fixed, but two new TS1361 errors are reported. The saved edit is retained.\n'
    + '- **Targeted repair:** runtime classes become value imports again; both errors resolve.\n\n'
    + 'The starting TS2322 error is intentional. Red tool cards are expected in the first two steps.\n\n'
    + 'Open `game.ts` and **View > Problems** to inspect the result. To see approvals and previews, choose **Approve every action** before sending the prompt.\n\n'
    + 'The provider checks actual tool feedback and file contents; it stops instead of claiming success if a check fails. Diagnostic observation is best effort, not a compiler/build guarantee.\n\n'
    + 'Actual feedback is written to `../demo-results.json`. Close this window and rerun the launcher for a fresh demo.\n';
  await fs.writeFile(path.join(workspace, 'DEMO.md'), guide);
  const server = await createDemoServer(workspace, record => console.log(`${record.passed ? 'PASS' : 'FAIL'}: ${record.step}`));
  try {
    await fs.writeFile(path.join(workspace, '.vscode', 'settings.json'), JSON.stringify({
      'deeplocal.backend': 'local', 'deeplocal.baseUrl': server.baseUrl,
      'deeplocal.apiMode': 'chat-completions', 'deeplocal.approvalMode': 'safe',
      'deeplocal.agentMaxTurns': 10, 'deeplocal.logLevel': 'debug',
      'workbench.startupEditor': 'none', 'workbench.sideBar.location': 'right',
      'typescript.disableAutomaticTypeAcquisition': true,
    }, null, 2));
    const runtime = path.join(directory, 'runtime.cjs');
    buildSync({ stdin: { contents: "export { ChatPanel } from './src/chat-panel'; export { DeepLocalClient } from './src/deeplocal-client'; export { Logger } from './src/logger';", resolveDir: repository },
      bundle: true, platform: 'node', format: 'cjs', external: ['vscode'], outfile: runtime });
    console.log(`Workspace: ${workspace}\nEvidence: ${server.report}\nLocal scripted provider: ${server.baseUrl}\n${verify ? 'Running automatic verification.' : `In DeepLocal, select ${model} and send: Run demo\nClose the demo VS Code window to finish.`}`);
    await runTests({ version: '1.104.0', cachePath: path.join(repository, '.vscode-test'),
      extensionDevelopmentPath: repository,
      extensionTestsPath: path.join(__dirname, 'demo-edit-validation-host.cjs'),
      extensionTestsEnv: { DEEPLOCAL_DEMO_WORKSPACE: workspace, DEEPLOCAL_DEMO_RUNTIME: runtime, DEEPLOCAL_DEMO_VERIFY: verify ? '1' : '0' },
      launchArgs: [workspace, '--new-window', '--disable-workspace-trust', `--user-data-dir=${path.join(directory, 'profile')}`, `--extensions-dir=${path.join(directory, 'extensions')}`],
    });
    if (verify && (server.records.length !== 3 || server.records.some(record => !record.passed))) throw new Error(`Demo did not pass all three checks. See ${server.report}`);
    console.log(`Demo finished. Evidence: ${server.report}`);
  } finally { await server.close(); }
}

if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
