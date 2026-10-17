import { beforeEach, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { invokeAgentTool } from '../../src/agent-tools';

const env = vi.hoisted(() => ({
  text: '',
  selection: '',
  diagnostics: [] as Array<{ severity: number; message: string; range: { start: { line: number; character: number } } }>,
  files: [] as Array<{ fsPath: string; scheme: string; toString: () => string }>,
}));

vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file', toString: () => fsPath });
  const root = path.resolve('/project');
  return {
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    Uri: { joinPath: (base: { fsPath: string }, relative: string) => uri(path.resolve(base.fsPath, relative)) },
    workspace: {
      workspaceFolders: [{ name: 'project', uri: uri(root) }],
      asRelativePath: (target: { fsPath: string }) => path.relative(root, target.fsPath),
      findFiles: async (_include: string, _exclude: string, maxResults?: number) => env.files.slice(0, maxResults),
      fs: { readFile: async () => new TextEncoder().encode(env.text) },
    },
    window: { activeTextEditor: {
      selection: { isEmpty: false },
      document: { uri: uri(path.resolve('/project', 'file.ts')), getText: () => env.selection },
    } },
    languages: { getDiagnostics: () => env.diagnostics.length ? [[uri(path.resolve('/project', 'file.ts')), env.diagnostics]] : [] },
    DiagnosticSeverity: { 0: 'Error' },
  };
});

beforeEach(() => {
  env.text = '';
  env.selection = '';
  env.diagnostics = [];
  env.files = [];
});

it('caps an oversized maxChars for read_file', async () => {
  env.text = 'a'.repeat(100000);

  const result = await invokeAgentTool('call-1', 'read_file', JSON.stringify({ path: 'big.txt', maxChars: 1e9 }));

  expect(result.status).toBe('success');
  expect(result.content.length).toBeLessThanOrEqual(60100);
  expect(result.content).toContain('... truncated ...');
});

it('caps an oversized maxChars for get_selection', async () => {
  env.selection = 'a'.repeat(100000);

  const result = await invokeAgentTool('call-1', 'get_selection', JSON.stringify({ maxChars: 1e9 }));

  expect(result.content).toHaveLength(60000 + '\n\n... truncated ...'.length);
  expect(result.content).toContain('... truncated ...');
});

it('caps oversized maxResults for diagnostics', async () => {
  env.diagnostics = Array.from({ length: 501 }, (_, line) => ({
    severity: 0, message: `message ${line}`, range: { start: { line, character: 0 } },
  }));

  const result = await invokeAgentTool('call-1', 'get_diagnostics', JSON.stringify({ maxResults: 1e9 }));

  expect(result.content.split('\n')).toHaveLength(500);
});

it('caps oversized maxResults for workspace file listings and search results', async () => {
  env.files = Array.from({ length: 501 }, (_, index) => ({
    fsPath: path.resolve('/project', `file-${index}.txt`), scheme: 'file', toString: () => `file-${index}.txt`,
  }));
  const list = await invokeAgentTool('call-1', 'list_workspace_files', JSON.stringify({ maxResults: 1e9 }));
  expect(list.content.split('\n')).toHaveLength(500);

  env.text = 'match';
  const search = await invokeAgentTool('call-2', 'search_workspace', JSON.stringify({ query: 'match', maxResults: 1e9 }));
  expect(search.content.split('\n')).toHaveLength(500);
});
