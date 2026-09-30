import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
  files: 'test/integration/**/*.test.js',
  version: '1.104.0',
  workspaceFolder: './test/fixtures/workspace',
  extensionDevelopmentPath: '.',
  launchArgs: ['--disable-workspace-trust'],
  mocha: { timeout: 20000 },
});
