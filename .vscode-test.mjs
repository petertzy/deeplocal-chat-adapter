import { defineConfig } from '@vscode/test-cli';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Start in multi-root mode: converting a single-folder window during a test
// restarts its Extension Host. All test workspace files stay temporary.
const directory = mkdtempSync(join(tmpdir(), 'deeplocal-host-'));
for (const name of ['anchor-one', 'anchor-two']) mkdirSync(join(directory, name));
const workspace = join(directory, 'test.code-workspace');
writeFileSync(workspace, JSON.stringify({ folders: [{ path: 'anchor-one' }, { path: 'anchor-two' }] }));
process.on('exit', () => rmSync(directory, { recursive: true, force: true }));

export default defineConfig([
  { label: 'single-folder', files: 'test/integration/extension.test.js', workspaceFolder: join(directory, 'anchor-one') },
  { label: 'multi-root', files: 'test/integration/agent-workspace.test.js', workspaceFolder: workspace },
].map(test => ({
  ...test,
  version: '1.104.0',
  extensionDevelopmentPath: '.',
  launchArgs: ['--disable-workspace-trust', `--user-data-dir=${join(directory, test.label, 'profile')}`, `--extensions-dir=${join(directory, test.label, 'extensions')}`],
  mocha: { timeout: 20000 },
})));
