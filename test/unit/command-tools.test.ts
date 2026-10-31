import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, access, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type * as vscode from 'vscode';
import { invokeAgentTool, toolResultsToMessages } from '../../src/agent-tools';

const env = vi.hoisted(() => ({ folders: [] as vscode.WorkspaceFolder[], confirm: vi.fn() }));
vi.mock('vscode', () => ({
  workspace: { get workspaceFolders() { return env.folders; } },
  window: { showWarningMessage: env.confirm },
}));
let directory: string;
beforeEach(async () => {
  directory = await realpath(await mkdtemp(join(tmpdir(), 'command-tools-')));
  env.folders = [folder(directory)];
  env.confirm.mockReset();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
const folder = (fsPath: string, scheme = 'file') => ({ name: 'test', index: 0,
  uri: { fsPath, scheme, toString: () => fsPath } } as vscode.WorkspaceFolder);
const call = (code: string, options: Parameters<typeof invokeAgentTool>[3] = {}) => invokeAgentTool('command-78', 'run_command',
  JSON.stringify({ command: process.execPath, args: ['-e', code] }), { approvalMode: 'full', ...options });

it('returns JSON process outcomes to the model under the existing tool-call contract', async () => {
  const result = await call("process.stdout.write('stdout error'); process.stderr.write('stderr error'); process.exitCode=1");
  expect(result).toMatchObject({ callId: 'command-78', name: 'run_command', status: 'error' });
  expect(JSON.parse(result.content)).toMatchObject({ cwd: directory, exitCode: 1, stdout: 'stdout error', stderr: 'stderr error', error: null });
  expect(result.content).not.toContain('Tool error:');
  expect(toolResultsToMessages([result])).toEqual([{ role: 'tool', tool_call_id: 'command-78', content: result.content }]);
});

it('retains successful output under the same structured shape', async () => {
  const result = await call("console.log('passed')");
  expect(result.status).toBe('success');
  expect(JSON.parse(result.content)).toMatchObject({ exitCode: 0, stdout: 'passed\n', stderr: '', error: null });
});

it('preserves real partial diagnostics after cancellation rather than replacing them with an abort error', async () => {
  const controller = new AbortController();
  const pending = call("require('fs').writeSync(1,'partial lint failure\\n'); require('fs').writeFileSync('ready','ready'); setInterval(()=>{},1000)", { signal: controller.signal });
  try {
    await vi.waitFor(async () => { await access(join(directory, 'ready')); }, { timeout: 5000 });
  } finally { controller.abort(); }
  const result = await pending;
  expect(result.status).toBe('error');
  expect(JSON.parse(result.content)).toMatchObject({ cancelled: true, timedOut: false, stdout: 'partial lint failure\n' });
});

it.each(['every', 'safe', 'full', 'ask'] as const)('preserves command approval mode %s', async mode => {
  const approve = vi.fn(async () => false);
  const result = await invokeAgentTool('approval', 'run_command', JSON.stringify({ command: 'git', args: ['--version'] }), { approvalMode: mode, approve });
  if (mode === 'full') {
    expect(approve).not.toHaveBeenCalled();
    expect(JSON.parse(result.content)).toHaveProperty('exitCode');
  } else {
    expect(result.status).toBe('declined');
    expect(approve).toHaveBeenCalledTimes(mode === 'ask' ? 0 : 1);
  }
});

it('never starts denied or pre-aborted commands', async () => {
  const code = "require('fs').writeFileSync('unexpected','executed')";
  const approve = vi.fn(async () => false);
  expect((await call(code, { approvalMode: 'every', approve })).status).toBe('declined');
  const controller = new AbortController(); controller.abort();
  const stopped = await call(code, { signal: controller.signal, approvalMode: 'every', approve });
  expect(JSON.parse(stopped.content)).toMatchObject({ cancelled: true, exitCode: null });
  expect(approve).toHaveBeenCalledOnce();
  await expect(access(join(directory, 'unexpected'))).rejects.toThrow();
});

it.each(['true', 1, null, []])('rejects nonboolean verification metadata before approval or execution (%j)', async verification => {
  const approve = vi.fn(async () => true);
  const result = await invokeAgentTool('invalid-verification', 'run_command', JSON.stringify({ command: process.execPath,
    args: ['-e', "require('fs').writeFileSync('unexpected','executed')"], verification }), { approvalMode: 'every', approve });
  expect(result.status).toBe('error');
  expect(result.content).toContain('verification must be a boolean');
  expect(approve).not.toHaveBeenCalled();
  await expect(access(join(directory, 'unexpected'))).rejects.toThrow();
});

it('checks selected workspace identity again after approval and refuses remote cwd', async () => {
  const code = "require('fs').writeFileSync('unexpected','executed')";
  const removed = await call(code, { approvalMode: 'every', approve: async () => { env.folders = []; return true; } });
  expect(removed.status).toBe('error');
  expect(removed.content).toContain('removed');
  env.folders = [folder(directory, 'vscode-remote')];
  expect((await call(code)).content).toContain('Commands require a local workspace');
  await expect(access(join(directory, 'unexpected'))).rejects.toThrow();
});

it('never substitutes another workspace after selection or passes a shell by default', async () => {
  const second = join(directory, 'second');
  const { mkdir } = await import('node:fs/promises'); await mkdir(second);
  env.folders = [folder(directory), folder(second)];
  const selected = env.folders[1];
  const options = { workspaceFolder: selected, approvalMode: 'every' as const, approve: async () => { options.workspaceFolder = env.folders[0]; return true; } };
  const result = await call("console.log(process.cwd());console.log(process.argv[1])", options);
  expect(JSON.parse(result.content)).toMatchObject({ cwd: second, stdout: second + '\nundefined\n' });
  const literal = await invokeAgentTool('literal', 'run_command', JSON.stringify({ command: process.execPath,
    args: ['-e', 'console.log(process.argv[1])', '$(touch unexpected)'] }), { approvalMode: 'full', workspaceFolder: selected });
  expect(JSON.parse(literal.content).stdout).toBe('$(touch unexpected)\n');
  await expect(access(join(second, 'unexpected'))).rejects.toThrow();
});
