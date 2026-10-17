import { beforeEach, expect, it, vi } from 'vitest';
import { posix as path } from 'node:path';
import type * as vscode from 'vscode';
import { invokeAgentTool, toolResultsToMessages } from '../../src/agent-tools';

const env = vi.hoisted(() => ({ readFile: vi.fn(), folders: [] as vscode.WorkspaceFolder[] }));

vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath });
  return {
    Uri: { joinPath: (root: { fsPath: string }, relative: string) => uri(path.resolve(root.fsPath, relative)) },
    workspace: {
      get workspaceFolders() { return env.folders; },
      asRelativePath: (target: { fsPath: string }) => path.relative('/project', target.fsPath),
      fs: { readFile: env.readFile },
    },
  };
});

beforeEach(() => {
  vi.resetAllMocks();
  env.folders = [{ name: 'project', uri: { fsPath: '/project' }, index: 0 } as vscode.WorkspaceFolder];
});

function readFile(filePath = 'assets/example.bin', maxChars?: number) {
  return invokeAgentTool('read-1', 'read_file', JSON.stringify({ path: filePath, maxChars }));
}

it.each([
  ['PNG header', Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)],
  ['NUL in valid UTF-8', new TextEncoder().encode('before\0after')],
  ['invalid UTF-8 without NUL', Uint8Array.of(0x61, 0xff, 0x62)],
  ['incomplete UTF-8', Uint8Array.of(0xe2, 0x82)],
  ['UTF-16', Uint8Array.of(0xff, 0xfe, 0x61, 0x00)],
])('rejects %s without putting file bytes in tool messages', async (_label, bytes) => {
  env.readFile.mockResolvedValue(bytes);
  const result = await readFile();
  const content = 'Tool error: Cannot read assets/example.bin: binary or unsupported file (expected UTF-8 text).';
  expect(result).toEqual({ callId: 'read-1', name: 'read_file', status: 'error', content });
  expect(toolResultsToMessages([result])).toEqual([{ role: 'tool', tool_call_id: 'read-1', content }]);
  expect(env.readFile).toHaveBeenCalledWith({ fsPath: '/project/assets/example.bin' });
});

it.each([
  ['ASCII', 'hello, world!\r\nsecond line\tindented\n'],
  ['Unicode', 'café — Ελληνικά — 日本語 — नमस्ते — 😀\n'],
  ['a literal replacement character', 'valid UTF-8: \ufffd'],
  ['empty text', ''],
])('preserves %s text', async (_label, text) => {
  env.readFile.mockResolvedValue(new TextEncoder().encode(text));
  expect(await readFile('notes.txt')).toEqual({ callId: 'read-1', name: 'read_file', status: 'success', content: text });
});

it('keeps the existing UTF-8 BOM decoding behavior', async () => {
  env.readFile.mockResolvedValue(Uint8Array.of(0xef, 0xbb, 0xbf, 0x68, 0x69));
  expect((await readFile('notes.txt')).content).toBe('hi');
});

it('truncates decoded characters rather than bytes', async () => {
  env.readFile.mockResolvedValue(new TextEncoder().encode('é日😀z'));
  expect((await readFile('notes.txt', 4)).content).toBe('é日😀\n\n... truncated ...');
  expect((await readFile('notes.txt', 5)).content).toBe('é日😀z');
});

it.each([undefined, 0, -1])('retains the default limit for maxChars=%s', async (maxChars) => {
  env.readFile.mockResolvedValue(new TextEncoder().encode('x'.repeat(30001)));
  expect((await readFile('notes.txt', maxChars)).content).toBe(`${'x'.repeat(30000)}\n\n... truncated ...`);
});

it.each([
  ['NUL', Uint8Array.of(0x61, 0x62, 0x63, 0x00)],
  ['invalid UTF-8', Uint8Array.of(0x61, 0x62, 0x63, 0xff)],
])('detects %s beyond the truncation limit', async (_label, bytes) => {
  env.readFile.mockResolvedValue(bytes);
  expect(await readFile('notes.txt', 2)).toMatchObject({
    status: 'error', content: 'Tool error: Cannot read notes.txt: binary or unsupported file (expected UTF-8 text).',
  });
});

it('reports the resolved workspace-relative path even with a small maxChars', async () => {
  env.readFile.mockResolvedValue(Uint8Array.of(0));
  expect((await readFile('assets/../images/logo.bin', 1)).content).toBe(
    'Tool error: Cannot read images/logo.bin: binary or unsupported file (expected UTF-8 text).',
  );
});

it.each(['../outside.bin', 'assets/../../outside.bin', '', '   '])('rejects invalid path %j before reading', async (filePath) => {
  expect((await readFile(filePath)).status).toBe('error');
  expect(env.readFile).not.toHaveBeenCalled();
});

it('preserves file-system errors', async () => {
  env.readFile.mockRejectedValue(new Error('File not found'));
  expect(await readFile('missing.txt')).toMatchObject({ status: 'error', content: 'Tool error: File not found' });
});


it('keeps an awaited read pinned when the caller changes its selected folder', async () => {
  const second = { name: 'second', uri: { fsPath: '/second' }, index: 1 } as vscode.WorkspaceFolder;
  env.folders.push(second);
  let finish!: (bytes: Uint8Array) => void;
  env.readFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const options = { workspaceFolder: second };
  const pending = invokeAgentTool('read', 'read_file', '{"path":"same.txt"}', options);
  options.workspaceFolder = env.folders[0];
  expect(env.readFile).toHaveBeenCalledWith({ fsPath: '/second/same.txt' });
  finish(new TextEncoder().encode('second contents'));
  expect(await pending).toMatchObject({ status: 'success', content: 'second contents' });
});

it('does not return an awaited read after its pinned folder is removed', async () => {
  const selected = env.folders[0];
  let finish!: (bytes: Uint8Array) => void;
  env.readFile.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = invokeAgentTool('read', 'read_file', '{"path":"same.txt"}', { workspaceFolder: selected });
  env.folders = [];
  finish(new TextEncoder().encode('must not reach the model'));
  const result = await pending;
  expect(result.status).toBe('error');
  expect(result.content).toContain('removed');
  expect(result.content).not.toContain('must not reach the model');
});
