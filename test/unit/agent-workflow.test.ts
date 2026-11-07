import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { posix as path } from 'node:path';
import { ChatPanel } from '../../src/chat-panel';
import * as vscode from 'vscode';
import { invokeAgentTool } from '../../src/agent-tools';
import { ChatCompletionRequest, ChatMessage, StreamEvent } from '../../src/protocol';
import { toolActivity } from '../../src/tool-activity';
import { mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import type { CommandResult } from '../../src/command-runner';

const env = vi.hoisted(() => ({
  files: new Map<string, string>(), dirty: false, version: 1,
  apply: vi.fn(), show: vi.fn(), dispose: vi.fn(), command: vi.fn(), trash: vi.fn(),
  clipboard: vi.fn(), picker: vi.fn(),
  save: vi.fn(),
  diagnostics: new Map<string, vscode.Diagnostic[]>(),
  diagnosticListeners: new Set<(event: vscode.DiagnosticChangeEvent) => void>(),
  folders: [] as vscode.WorkspaceFolder[],
  foldersChanged: (_event: vscode.WorkspaceFoldersChangeEvent) => {},
  config: { injectSystemPrompt: true, agentMaxTurns: 3, agentMaxRepairIterations: 0, maxOutputTokens: 1000, backend: 'local', approvalMode: 'every' },
}));

vi.mock('../../src/config', () => ({ getConfig: () => env.config }));
vi.mock('vscode', () => {
  const uri = (value: string) => ({ fsPath: value, scheme: 'file', toString: () => value });
  class WorkspaceEdit {
    operations: Array<{ kind: string; target: { fsPath: string }; text?: string }> = [];
    createFile(target: { fsPath: string }) { this.operations.push({ kind: 'create', target }); }
    insert(target: { fsPath: string }, _position: unknown, text: string) { this.operations.push({ kind: 'write', target, text }); }
    replace(target: { fsPath: string }, _range: unknown, text: string) { this.operations.push({ kind: 'write', target, text }); }
  }
  return {
    env: { language: 'en', clipboard: { writeText: env.clipboard } },
    FileType: { File: 1, Directory: 2 },
    Uri: { parse: uri, joinPath: (root: { fsPath: string }, relative: string) => uri(path.resolve(root.fsPath, relative)) },
    WorkspaceEdit, Position: class {}, Range: class {},
    window: { showQuickPick: env.picker, showTextDocument: env.show, showWarningMessage: vi.fn(), activeTextEditor: {
      document: { fileName: '/project/existing.ts', uri: uri('/project/existing.ts'), getText: () => 'important original' },
    } },
    commands: { executeCommand: env.command },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    languages: {
      getDiagnostics: (target?: { fsPath: string }) => target ? env.diagnostics.get(target.fsPath) ?? []
        : [...env.diagnostics].map(([file, diagnostics]) => [uri(file), diagnostics]),
      onDidChangeDiagnostics: (callback: (event: vscode.DiagnosticChangeEvent) => void) => {
        env.diagnosticListeners.add(callback);
        return { dispose: () => env.diagnosticListeners.delete(callback) };
      },
    },
    workspace: {
      get workspaceFolders() { return env.folders; },
      onDidChangeWorkspaceFolders: (callback: typeof env.foldersChanged) => { env.foldersChanged = callback; return { dispose: vi.fn() }; },
      onDidChangeTextDocument: () => ({ dispose: vi.fn() }),
      asRelativePath: (target: { fsPath: string }) => path.relative('/project', target.fsPath),
      registerTextDocumentContentProvider: () => ({ dispose: env.dispose }),
      fs: { stat: async (target: { fsPath: string }) => {
        if (!env.files.has(target.fsPath)) throw Object.assign(new Error('not found'), { code: 'FileNotFound' });
        return { type: target.fsPath.endsWith('/folder') ? 2 : 1 };
      }, delete: async (target: { fsPath: string }, options: unknown) => {
        env.trash(target.fsPath, options);
        env.files.delete(target.fsPath);
      } },
      openTextDocument: async (target: { fsPath: string }) => ({
        uri: target, get isDirty() { return env.dirty; }, get version() { return env.version; },
        getText: () => env.files.get(target.fsPath) ?? '', positionAt: (offset: number) => offset,
        save: async () => { env.save(target); return true; },
      }),
      applyEdit: async (edit: WorkspaceEdit) => {
        env.apply(edit);
        for (const operation of edit.operations) {
          if (operation.kind === 'create' && env.files.has(operation.target.fsPath)) return false;
        }
        for (const operation of edit.operations) env.files.set(operation.target.fsPath, operation.text ?? '');
        return true;
      },
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  env.folders = [{ name: 'project', uri: { fsPath: '/project', scheme: 'file', toString: () => '/project' }, index: 0 } as vscode.WorkspaceFolder];
  env.files.clear();
  env.diagnostics.clear();
  env.diagnosticListeners.clear();
  env.save.mockReset();
  env.files.set('/project/existing.ts', 'important original');
  env.dirty = false;
  env.version = 1;
  env.config.agentMaxTurns = 3;
  // Reporting-only fixtures finish immediately; repair scenarios opt in below.
  env.config.agentMaxRepairIterations = 0;
  env.config.approvalMode = 'every';
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const createArgs = JSON.stringify({ path: 'snake.html', content: '<html>snake</html>' });

function publishDiagnostics(file: string, diagnostics: vscode.Diagnostic[]) {
  env.diagnostics.set(file, diagnostics);
  const target = { fsPath: file, scheme: 'file', toString: () => file } as vscode.Uri;
  for (const listener of env.diagnosticListeners) listener({ uris: [target] });
}

function diagnostic(message: string, severity: number, source: string, code: number): vscode.Diagnostic {
  return { message, severity, source, code, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } } as vscode.Diagnostic;
}

it.each(['create_file', 'write_file', 'replace_in_file'])('blocks duplicate imports through %s before approval or writing', async name => {
  const original = "import { SnakeRenderer } from './renderer';\nnew SnakeRenderer();";
  const duplicate = "import type { SnakeRenderer } from './renderer';\n";
  env.files.set('/project/existing.ts', original);
  const args = name === 'replace_in_file' ? { path: 'existing.ts', oldText: 'new SnakeRenderer();', newText: duplicate + 'new SnakeRenderer();' }
    : { path: name === 'create_file' ? 'new.ts' : 'existing.ts', content: duplicate + original };
  const approve = vi.fn(async () => true);
  const result = await invokeAgentTool('duplicate', name, JSON.stringify(args), { approve });
  expect(result.status).toBe('error');
  expect(result.content).toContain('No change applied');
  expect(result.content).toContain('SnakeRenderer');
  expect(env.files.get('/project/existing.ts')).toBe(original);
  expect(env.files.has('/project/new.ts')).toBe(false);
  expect(approve).not.toHaveBeenCalled();
  expect(env.apply).not.toHaveBeenCalled();
});

it('retains saved edits and forwards new compilation errors to the model and persisted transcript', async () => {
  env.diagnostics.set('/project/existing.ts', [diagnostic('Use a type import', 1, 'eslint', 1)]);
  env.save.mockImplementation(() => publishDiagnostics('/project/existing.ts', [diagnostic('Class cannot be used as a value', 0, 'ts', 1361)]));
  const editTool: StreamEvent = { kind: 'toolCall', value: {
    id: 'edit-regression', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'existing.ts', content: 'export const changed = true;' }) },
  } };
  const harness = panelHarness([[editTool], [{ kind: 'text', value: 'The saved edit requires repair.' }]]);
  harness.send({ type: 'send', text: 'Fix the lint warning', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'approval')).toBe(true));
  const approval = harness.sent.find(message => message.type === 'approval')!;
  harness.send({ type: 'approval', approvalId: approval.approvalId, approved: true });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true), { timeout: 4000 });
  const result = harness.requests[1].messages.find(message => message.role === 'tool')!;
  expect(result.content).toContain('saved and retained');
  expect(result.content).toContain('Class cannot be used as a value');
  expect(harness.sent.find(message => message.type === 'toolResult')?.activity).toMatchObject({ state: 'error' });
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ role: string; text: string }> }>;
  expect(sessions[0].transcript.find(item => item.role === 'Tool')?.text).toContain('Class cannot be used as a value');
  expect(env.files.get('/project/existing.ts')).toBe('export const changed = true;');
  expect(env.diagnosticListeners.size).toBe(0);
});

it('retains a saved TypeScript edit when cancellation interrupts diagnostic validation', async () => {
  const controller = new AbortController();
  env.save.mockImplementation(() => controller.abort());
  const result = await invokeAgentTool('cancel-validation', 'write_file', JSON.stringify({ path: 'existing.ts', content: 'export const saved = true;' }),
    { approvalMode: 'full', signal: controller.signal });
  expect(result.content).toContain('saved and retained');
  expect(result.status).toBe('error');
  expect(env.files.get('/project/existing.ts')).toBe('export const saved = true;');
  expect(env.diagnosticListeners.size).toBe(0);
});

it('preserves observed diagnostic errors when displaying the saved editor fails', async () => {
  env.save.mockImplementation(() => publishDiagnostics('/project/existing.ts', [diagnostic('Runtime class requires a value import', 0, 'ts', 1361)]));
  env.show.mockRejectedValueOnce(new Error('Editor unavailable'));
  const content = 'export const saved = true;';
  const result = await invokeAgentTool('display-failure', 'write_file', JSON.stringify({ path: 'existing.ts', content }),
    { approvalMode: 'full' });
  expect(result.status).toBe('error');
  expect(result.content).toContain('saved and retained');
  expect(result.content).toContain('Runtime class requires a value import');
  expect(result.content).toContain('Editor unavailable');
  expect(env.files.get('/project/existing.ts')).toBe(content);
  expect(env.diagnosticListeners.size).toBe(0);
});

it('creates the requested file without touching the active file, with a reviewable diff', async () => {
  const approve = vi.fn(async (_message: string, preview?: () => Promise<void>) => {
    expect(env.files.has('/project/snake.html')).toBe(false);
    await preview?.();
    return true;
  });
  const result = await invokeAgentTool('c1', 'create_file', createArgs, { approve });
  expect(result.content).toBe('Created snake.html.');
  expect(env.files.get('/project/existing.ts')).toBe('important original');
  expect(env.files.get('/project/snake.html')).toBe('<html>snake</html>');
  expect(env.command.mock.calls[0][0]).toBe('vscode.diff');
  expect(env.show).toHaveBeenCalled();
  expect(env.dispose).toHaveBeenCalledOnce();
});

it('refuses create_file on existing paths and protects dirty documents', async () => {
  const approve = vi.fn(async () => true);
  const args = JSON.stringify({ path: 'existing.ts', content: 'replacement' });
  expect((await invokeAgentTool('c1', 'create_file', args, { approve })).content).toContain('already exists');
  env.dirty = true;
  expect((await invokeAgentTool('c2', 'write_file', args, { approve })).content).toContain('unsaved');
  expect(approve).not.toHaveBeenCalled();
  expect(env.apply).not.toHaveBeenCalled();
});

it('rejecting or stopping during approval never writes files', async () => {
  const rejected = await invokeAgentTool('c1', 'create_file', createArgs, { approve: async () => false });
  expect(rejected.content).toContain('declined');
  const controller = new AbortController();
  await invokeAgentTool('c2', 'create_file', createArgs, { signal: controller.signal, approve: async () => {
    controller.abort();
    return true;
  } });
  expect(env.apply).not.toHaveBeenCalled();
  expect(env.dispose).toHaveBeenCalledTimes(2);
});

it('applies safe-mode normal file changes automatically but protects sensitive paths', async () => {
  const approve = vi.fn(async () => true);
  const normal = await invokeAgentTool('c1', 'create_file', createArgs, { approvalMode: 'safe', approve });
  expect(normal.status).toBe('success');
  expect(approve).not.toHaveBeenCalled();
  const sensitive = await invokeAgentTool('c2', 'create_file', JSON.stringify({ path: '.env.local', content: 'KEY=value' }), { approvalMode: 'safe', approve });
  expect(sensitive.status).toBe('success');
  expect(approve).toHaveBeenCalledOnce();
});

it('ask-only mode declines all operations without applying an edit', async () => {
  const result = await invokeAgentTool('c1', 'create_file', createArgs, { approvalMode: 'ask' });
  expect(result.status).toBe('declined');
  expect(result.content).toContain('Ask-only');
  expect(env.apply).not.toHaveBeenCalled();
});

it('approve-every-operation mode also asks before read-only tools', async () => {
  const approve = vi.fn(async () => false);
  const result = await invokeAgentTool('c1', 'get_active_file', '{}', { approvalMode: 'every', approve });
  expect(result.status).toBe('declined');
  expect(approve).toHaveBeenCalledWith('Allow tool: get_active_file', undefined);
});

it('rejects files changed during review and a newly created path collision', async () => {
  const result = await invokeAgentTool('c1', 'write_file', JSON.stringify({ path: 'existing.ts', content: 'new' }), {
    approve: async () => { env.version++; return true; },
  });
  expect(result.content).toContain('changed during review');
  expect(env.apply).not.toHaveBeenCalled();
  const collision = await invokeAgentTool('c2', 'create_file', createArgs, { approve: async () => {
    env.files.set('/project/snake.html', 'user created this');
    return true;
  } });
  expect(collision.content).toContain('could not apply');
  expect(env.files.get('/project/snake.html')).toBe('user created this');
});

it('requires approval for deletion, rejects directories, and uses trash rather than permanent removal', async () => {
  const args = JSON.stringify({ path: 'existing.ts' });
  expect((await invokeAgentTool('d1', 'delete_file', args, { approve: async () => false })).status).toBe('declined');
  expect(env.files.has('/project/existing.ts')).toBe(true);
  const controller = new AbortController();
  await invokeAgentTool('d2', 'delete_file', args, { signal: controller.signal, approve: async () => { controller.abort(); return true; } });
  expect(env.trash).not.toHaveBeenCalled();
  env.files.set('/project/folder', '');
  expect((await invokeAgentTool('d3', 'delete_file', '{"path":"folder"}')).status).toBe('error');
  const result = await invokeAgentTool('d4', 'delete_file', args, { approve: async (_message, preview) => { await preview?.(); return true; } });
  expect(result.status).toBe('success');
  expect(env.trash).toHaveBeenCalledWith('/project/existing.ts', { recursive: false, useTrash: true });
  expect(env.command.mock.calls[0][3]).toBe('Delete existing.ts');
});

it('tool progress identifies operation and path without exposing generated contents', () => {
  for (const [name, title] of [['create_file', 'Create file'], ['replace_in_file', 'Modify file'], ['delete_file', 'Delete file']]) {
    const activity = toolActivity('request:1', { id: 'c1', type: 'function', function: { name, arguments: JSON.stringify({ path: 'snake.html', content: 'huge source code' }) } });
    expect(activity).toMatchObject({ title, detail: 'snake.html', state: 'running' });
    expect(JSON.stringify(activity)).not.toContain('huge source code');
  }
});

it('uses the redacted activity for status, live rows and persisted/restored rows without changing execution arguments', async () => {
  const sentinel = 'syntheticCredential53';
  const argumentsValue = JSON.stringify({ path: `.env.${sentinel}`, content: 'synthetic file payload' });
  const sensitiveTool: StreamEvent = { kind: 'toolCall', value: {
    id: 'sensitive-53', type: 'function', function: { name: 'create_file', arguments: argumentsValue },
  } };
  const harness = panelHarness([[sensitiveTool], [{ kind: 'text', value: 'File creation declined.' }]]);
  harness.send({ type: 'send', text: 'Create the requested configuration', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'approval')).toBe(true));
  expect(harness.sent).toContainEqual({ type: 'status', message: 'Create file · [sensitive target redacted]' });
  const start = harness.sent.find(message => message.type === 'toolStart')!;
  expect(start.activity).toMatchObject({ detail: '[sensitive target redacted]', state: 'running' });
  // Approval and execution retain their existing exact target; only activity labels are redacted.
  const approval = harness.sent.find(message => message.type === 'approval')!;
  expect(approval.message).toContain(`.env.${sentinel}`);
  harness.send({ type: 'approval', approvalId: approval.approvalId, approved: false });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));
  const activity = harness.sent.find(message => message.type === 'toolResult')!.activity;
  expect(activity).toMatchObject({ title: 'Create file', detail: '[sensitive target redacted]', state: 'declined' });
  expect(JSON.stringify(harness.sent.filter(message => message.type === 'status' || message.type === 'toolStart' || message.type === 'toolResult'))).not.toContain(sentinel);
  expect(harness.requests[1].messages.find(message => message.tool_calls)?.tool_calls?.[0].function.arguments).toBe(argumentsValue);
  expect(env.apply).not.toHaveBeenCalled();
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ id: string; transcript: Array<{ role: string; activity?: unknown }> }>;
  expect(sessions[0].transcript.find(item => item.role === 'Tool')?.activity).toEqual(activity);
  harness.send({ type: 'switchSession', sessionId: sessions[0].id });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'restore')).toBe(true));
  const restored = harness.sent.find(message => message.type === 'restore')!;
  expect(JSON.stringify(restored)).toContain('[sensitive target redacted]');
  expect(JSON.stringify(restored)).not.toContain(sentinel);
});

it('redacts recognizable sensitive labels saved before the update when restoring activity', async () => {
  const sentinel = 'syntheticCredential53';
  const harness = panelHarness([], [{
    role: 'Tool', text: 'create_file\nUser declined file change.',
    activity: { id: 'old-53', title: 'Create file', detail: `.env.${sentinel}`, state: 'declined' },
  }, {
    role: 'Tool', text: 'run_command\nUser declined command execution.',
    activity: { id: 'attached-53', title: 'Run command', detail: 'docker run --env-file=.env.production demo-image', state: 'declined' },
  }, {
    role: 'Tool', text: 'read_file\nRead complete.',
    activity: { id: 'ordinary', title: 'Read file', detail: 'src/config.ts', state: 'success' },
  }, {
    role: 'Tool', text: 'read_file\nMissing saved target.',
    activity: { id: 'invalid', title: 'Read file', detail: null, state: 'error' },
  }]);
  harness.send({ type: 'switchSession', sessionId: 'stored' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'restore')).toBe(true));
  const restored = harness.sent.find(message => message.type === 'restore')!;
  expect(JSON.stringify(restored)).toContain('[sensitive target redacted]');
  expect(JSON.stringify(restored)).toContain('src/config.ts');
  expect(JSON.stringify(restored)).not.toContain(sentinel);
  expect(JSON.stringify(restored)).not.toContain('.env.production');
  expect(restored.items).toEqual(expect.arrayContaining([expect.objectContaining({
    activity: { id: 'attached-53', title: 'Run command', detail: '[sensitive target redacted]', state: 'declined' },
  })]));
  expect(restored.items).toEqual(expect.arrayContaining([expect.objectContaining({
    activity: { id: 'invalid', title: 'Read file', detail: '', state: 'error' },
  })]));
});

it('summarizes the latest visible user request without changing saved titles or exposing model/tool text', async () => {
  const latest = '  Follow up\n日本語 👩🏽‍💻 <img src=x onerror="synthetic57()"> & "quotes" ' + 'context '.repeat(40);
  const items = [
    { role: 'You', text: 'First request' },
    { role: 'DeepLocal', text: 'Earlier answer' },
    { role: 'You', text: latest },
    { role: 'Summary', text: 'Provider summary must not be used' },
    { role: 'Tool', text: 'Tool result must not be used' },
    { role: 'DeepLocal', text: 'Latest answer must not be used' },
  ];
  const harness = panelHarness([], items, [{ role: 'user', content: 'Model-only history' }]);
  harness.send({ type: 'switchSession', sessionId: 'stored' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'sessions')).toBe(true));
  expect(harness.sent.find(message => message.type === 'sessions')).toEqual({
    type: 'sessions', activeSessionId: 'stored',
    sessions: [{ id: 'stored', title: 'Saved task', preview: latest, updatedAt: 1 }],
  });
  const stored = harness.state.get('deeplocal.sessions.folders:/project') as Array<Record<string, unknown>>;
  expect(stored[0].title).toBe('Saved task');
  expect(stored[0].transcript).toEqual(items);
  expect(stored[0]).not.toHaveProperty('preview');
});

it.each([
  [[], [], ''],
  [[{ role: 'DeepLocal', text: 'No user request yet' }], [], ''],
  [[{ role: 'You', text: ' \n\t ' }], [{ role: 'user', content: 'Older request' }], ' \n\t '],
  [[{ role: 'Tool', text: 'Retained tool result' }], [
    { role: 'user', content: 'Older request' }, { role: 'user', content: 'Latest retained request' }, { role: 'tool', content: 'Tool result' },
  ], 'Latest retained request'],
  [[], [{ role: 'user', content: null }], ''],
])('handles empty or trimmed session transcripts (%#)', async (items, history, expected) => {
  const harness = panelHarness([], items as Array<Record<string, unknown>>, history as ChatMessage[]);
  harness.send({ type: 'switchSession', sessionId: 'stored' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'sessions')).toBe(true));
  expect(harness.sent.find(message => message.type === 'sessions')).toMatchObject({ sessions: [{ preview: expected }] });
});

it('updates session previews after follow-ups and preserves selection, titles and the persistence format', async () => {
  const harness = panelHarness([[{ kind: 'text', value: 'First answer' }], [{ kind: 'text', value: 'Second answer' }]]);
  harness.send({ type: 'send', text: 'Original title', model: 'test', useAgent: false });
  await vi.waitFor(() => expect(harness.sent.filter(message => message.type === 'assistantDone')).toHaveLength(1));
  harness.send({ type: 'send', text: 'Latest request\nwith more detail', model: 'test', useAgent: false });
  await vi.waitFor(() => expect(harness.sent.filter(message => message.type === 'assistantDone')).toHaveLength(2));
  const previous = harness.sent.filter(message => message.type === 'sessions').at(-1)!;
  expect(previous).toMatchObject({ sessions: [{ title: 'Original title', preview: 'Latest request\nwith more detail' }] });
  harness.send({ type: 'newSession' });
  await vi.waitFor(() => expect(harness.sent.filter(message => message.type === 'sessions').at(-1)?.activeSessionId).not.toBe(previous.activeSessionId));
  expect(harness.sent.filter(message => message.type === 'sessions').at(-1)).toMatchObject({ sessions: expect.arrayContaining([expect.objectContaining({ title: 'New session', preview: '' })]) });
  harness.send({ type: 'switchSession', sessionId: previous.activeSessionId });
  await vi.waitFor(() => expect(harness.sent.filter(message => message.type === 'sessions').at(-1)?.activeSessionId).toBe(previous.activeSessionId));
  expect(harness.state.get('deeplocal.activeSessionId.folders:/project')).toBe(previous.activeSessionId);
  const stored = harness.state.get('deeplocal.sessions.folders:/project') as Array<Record<string, unknown>>;
  expect(stored.every(session => !('preview' in session))).toBe(true);
});

it.each([false, true])('preserves sanitized command results in activity, saved history and model continuation (cancel=%s)', async cancel => {
  const directory = await mkdtemp(path.join(tmpdir(), 'panel-command-'));
  const sentinel = 'syntheticCredential78';
  try {
    env.folders = [{ name: 'commands', index: 0, uri: { fsPath: directory, scheme: 'file', toString: () => directory } } as vscode.WorkspaceFolder];
    await writeFile(path.join(directory, 'diagnostics.txt'), 'src/main.ts:8 lint failure\nAPI_KEY=' + sentinel + '\n<img src=x onerror="synthetic78()">');
    const code = "const fs=require('fs');fs.writeSync(1,fs.readFileSync('diagnostics.txt'));fs.writeSync(2,'stderr diagnostic\\n');fs.writeFileSync('ready','ready');" + (cancel ? 'setInterval(()=>{},1000)' : 'process.exitCode=1');
    const event: StreamEvent = { kind: 'toolCall', value: { id: 'cmd78', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: process.execPath, args: ['-e', code] }) } } };
    const harness = panelHarness([[event], [{ kind: 'text', value: 'The lint diagnostic identifies the failing line.' }]]);
    harness.send({ type: 'send', model: 'test', text: 'Run the synthetic diagnostic' });
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'approval')).toBe(true));
    const approval = harness.sent.find(message => message.type === 'approval')!;
    harness.send({ type: 'approval', approvalId: approval.approvalId, approved: true });
    if (cancel) {
      await vi.waitFor(async () => { await access(path.join(directory, 'ready')); }, { timeout: 5000 });
      harness.send({ type: 'stop' });
    }
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true), { timeout: 5000 });
    const tool = harness.sent.find(message => message.type === 'toolResult')!;
    expect(tool.activity).toMatchObject({ title: 'Run command', state: cancel ? 'cancelled' : 'error' });
    const result = JSON.parse((tool.text as string).slice('run_command\n'.length));
    expect(result).toMatchObject({ exitCode: cancel ? null : 1, cancelled: cancel, stderr: 'stderr diagnostic\n' });
    expect(result.stdout).toContain('src/main.ts:8 lint failure');
    expect(result.stdout).toContain('[redacted]');
    const completion = harness.sent.find(message => message.type === 'assistantFinal')!;
    expect(JSON.parse(completion.text as string)).toMatchObject({ verification: cancel ? 'interrupted' : 'unverified',
      attempts: [{ state: cancel ? 'incomplete' : 'failed', cancelled: cancel }] });
    expect(JSON.stringify(harness.sent)).not.toContain(sentinel);
    const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ id: string; history: ChatMessage[]; transcript: unknown[] }>;
    expect(JSON.stringify(sessions)).not.toContain(sentinel);
    expect(sessions[0].history.find(message => message.role === 'tool')?.content).toBe((tool.text as string).slice('run_command\n'.length));
    if (!cancel) expect(harness.requests[1].messages.find(message => message.role === 'tool')?.content).toBe((tool.text as string).slice('run_command\n'.length));
    harness.send({ type: 'switchSession', sessionId: sessions[0].id });
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'restore')).toBe(true));
    expect(JSON.stringify(harness.sent.filter(message => message.type === 'restore'))).toContain('src/main.ts:8 lint failure');
    expect(JSON.stringify(harness.sent.filter(message => message.type === 'restore'))).not.toContain(sentinel);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function panelHarness(responses: StreamEvent[][], savedItems?: Array<Record<string, unknown>>, savedHistory: ChatMessage[] = []) {
  const state = new Map<string, unknown>();
  if (savedItems) state.set('deeplocal.sessions.folders:/project', [{
    id: 'stored', title: 'Saved task', updatedAt: 1, history: savedHistory, transcript: savedItems,
  }]);
  const memento = { get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
  const sent: Array<Record<string, unknown>> = [];
  const requests: ChatCompletionRequest[] = [];
  let receive: (message: unknown) => void = () => undefined;
  const client = {
    modelInformation: () => ({ toolCalling: true }), cancel: vi.fn(),
    streamChat: async function* (_id: string, request: ChatCompletionRequest) {
      requests.push(structuredClone(request));
      for (const event of responses.shift() ?? []) yield event;
    },
  };
  const panel = new ChatPanel({ subscriptions: [], workspaceState: memento, globalState: memento } as never, client as never,
    { error: vi.fn() } as never, { get: async () => '', set: async () => {}, clear: async () => {} });
  const webview = { html: '', options: {}, cspSource: 'test:',
    postMessage: (message: Record<string, unknown>) => { sent.push(message); },
    onDidReceiveMessage: (handler: typeof receive) => { receive = handler; },
  };
  panel.resolveWebviewView({ webview, onDidDispose: () => {} } as never);
  return { panel, sent, requests, state, webview, client, send: (message: unknown) => receive(message) };
}

it('keeps ordinary chat free of agent-only tool and verification instructions', async () => {
  const harness = panelHarness([[{ kind: 'text', value: 'Hello! How can I help?' }]]);
  harness.send({ type: 'send', model: 'test', text: 'Hello there', useAgent: false });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));

  const request = harness.requests[0];
  const prompt = request.messages[0]?.content ?? '';
  expect(request.tools).toBeUndefined();
  expect(prompt).toContain('helpful assistant');
  expect(prompt).toContain('everyday conversation');
  expect(prompt).toContain('Always answer in the language of the user’s latest message');
  expect(prompt).not.toContain('discover_verification_commands');
  expect(prompt).not.toContain('submit_completion');
  expect(prompt).not.toContain('create_file');
});

it('keeps a conversational Agent reply free of verification evidence', async () => {
  const harness = panelHarness([[{ kind: 'text', value: 'Hello! How can I help?' }]]);
  harness.send({ type: 'send', model: 'test', text: 'Hello there', useAgent: true });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));

  const final = harness.sent.find(message => message.type === 'assistantFinal')!;
  expect(final).toMatchObject({ text: 'Hello! How can I help?' });
  expect(final.completionReport).toBeUndefined();
  expect(harness.sent.some(message => message.type === 'toolStart')).toBe(false);
});

const completion = (checks: unknown[], nextSteps = ''): StreamEvent => ({ kind: 'toolCall', value: {
  id: 'completion82', type: 'function', function: { name: 'submit_completion', arguments: JSON.stringify({ checks, nextSteps }) },
} });
const processCall = (id: string, code: string): StreamEvent => ({ kind: 'toolCall', value: {
  id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: process.execPath, args: ['-e', code] }) },
} });

it('does not accept a passed build claim when the agent has executed no tools', async () => {
  const harness = panelHarness([[{ kind: 'text', value: 'The build passed; everything is fixed.' }]]);
  harness.send({ type: 'send', model: 'test', text: 'Run the build and report its result.' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));
  const report = JSON.parse(harness.sent.find(message => message.type === 'assistantFinal')!.text as string);
  expect(report).toMatchObject({ verification: 'unverified', attempts: [], checks: [] });
  expect(report.notRecorded).toContain('absent from the recorded attempts is not_run');
  expect(JSON.stringify(harness.sent)).not.toContain('The build passed; everything is fixed.');
});

it.each([false, true])('rejects misleading completion prose after a real failed check (structured=%s)', async structured => {
  const directory = await mkdtemp(path.join(tmpdir(), 'completion82-'));
  const mode = env.config.approvalMode;
  try {
    env.config.approvalMode = 'full'; env.folders = [{ name: 'synthetic', index: 0, uri: { scheme: 'file', fsPath: directory, toString: () => directory } } as vscode.WorkspaceFolder];
    const code = "console.error('src/main.ts:8 lint failure');process.exitCode=1";
    const final: StreamEvent[] = structured ? [completion([{ command: process.execPath, args: ['-e', code] }, { command: 'npm', args: ['run', 'build'] }], 'Bitte zuerst den fehlgeschlagenen Check reparieren.')] : [{ kind: 'text', value: 'All fixed. Lint and build passed.' }];
    const harness = panelHarness([[processCall('lint82', code)], final]);
    harness.send({ type: 'send', model: 'test', text: 'Fix lint; run lint and build. Bitte auf Deutsch antworten.' });
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true), { timeout: 5000 });
    const done = harness.sent.find(message => message.type === 'assistantFinal')!;
    const report = JSON.parse(done.text as string);
    expect(report.verification).toBe(structured ? 'failed' : 'unverified');
    expect(report.attempts[0]).toMatchObject({ tool: 'run_command', state: 'failed', exitCode: 1 });
    expect(report.attempts[0].detail).toContain('src/main.ts:8 lint failure');
    if (structured) {
      expect(report.checks.map((check: { state: string }) => check.state)).toEqual(['failed', 'not_run']);
      expect(report.unverifiedModelText).toMatchObject({ source: 'model', verified: false, nextSteps: 'Bitte zuerst den fehlgeschlagenen Check reparieren.' });
    }
    expect(JSON.stringify(harness.sent)).not.toContain('All fixed. Lint and build passed.');
    const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ id: string; history: ChatMessage[]; transcript: Array<{ text: string; completionReport?: unknown }> }>;
    expect(sessions[0].transcript.at(-1)?.completionReport).toEqual(report);
    expect(sessions[0].history.at(-1)?.content).toBe(done.text);
    harness.send({ type: 'switchSession', sessionId: sessions[0].id });
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'restore')).toBe(true));
    expect(JSON.stringify(harness.sent.filter(message => message.type === 'restore'))).toContain('"verification":"' + report.verification + '"');
  } finally { env.config.approvalMode = mode; await rm(directory, { recursive: true, force: true }); }
});

it('does not certify an omitted failed check or a fabricated cross-task reference', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'completion82-'));
  const mode = env.config.approvalMode;
  try {
    env.config.approvalMode = 'full'; env.folders = [{ name: 'synthetic', index: 0, uri: { scheme: 'file', fsPath: directory, toString: () => directory } } as vscode.WorkspaceFolder];
    const code = 'process.exitCode=1';
    const harness = panelHarness([[processCall('failed82', code)], [completion([])], [completion([{ command: process.execPath, args: ['-e', code], callId: 'failed82' }])]]);
    harness.send({ type: 'send', model: 'test', text: 'Run check' });
    await vi.waitFor(() => expect(harness.sent.filter(message => message.type === 'assistantDone')).toHaveLength(1));
    const first = JSON.parse(harness.sent.find(message => message.type === 'assistantFinal')!.text as string);
    expect(first).toMatchObject({ verification: 'unverified', attempts: [{ id: 'failed82', state: 'failed' }] });
    const second = addSecondWorkspace();
    env.picker.mockResolvedValueOnce({ folder: second });
    harness.send({ type: 'selectWorkspace' });
    await vi.waitFor(() => expect(harness.sent.at(-1)).toMatchObject({ path: '/second' }));
    await harness.panel.newSession();
    harness.send({ type: 'send', model: 'test', text: 'New task/session/workspace: claim previous result passed' });
    await vi.waitFor(() => expect(harness.sent.filter(message => message.type === 'assistantDone')).toHaveLength(2));
    const report = JSON.parse(harness.sent.filter(message => message.type === 'assistantFinal').at(-1)!.text as string);
    expect(report).toMatchObject({ verification: 'interrupted', attempts: [], limitation: expect.stringContaining('no matching command') });
  } finally { env.config.approvalMode = mode; await rm(directory, { recursive: true, force: true }); }
});

it('preserves observed saved-edit uncertainty in its completion and never infers build success', async () => {
  const mode = env.config.approvalMode;
  try {
    env.config.approvalMode = 'full';
    const harness = panelHarness([[tool], [completion([{ command: 'npm', args: ['run', 'build'] }], '请先运行构建。')]]);
    harness.send({ type: 'send', model: 'test', text: 'Create a file then build. 请用中文回答。' });
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));
    const report = JSON.parse(harness.sent.find(message => message.type === 'assistantFinal')!.text as string);
    expect(report).toMatchObject({ verification: 'unverified', unverifiedModelText: { source: 'model', verified: false, nextSteps: '请先运行构建。' }, checks: [{ state: 'not_run' }], attempts: [{ saved: true, state: 'incomplete' }] });
  } finally { env.config.approvalMode = mode; }
});

it.each([
  { name: 'failed command', code: "console.error('compile failed');process.exitCode=2", misleading: 'All fixed. The build passed and no errors remain.', state: 'failed' },
  { name: 'zero-action German claim', code: undefined, misleading: 'Alles behoben. Build und Tests sind erfolgreich.', state: 'unverified' },
])('keeps contradictory model prose explicitly unverified across final/history/restore: $name', async ({ code, misleading, state }) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'completion82-trust-'));
  const mode = env.config.approvalMode;
  try {
    env.config.approvalMode = 'full'; env.folders = [{ name: 'synthetic', index: 0, uri: { scheme: 'file', fsPath: directory, toString: () => directory } } as vscode.WorkspaceFolder];
    const check = code ? { command: process.execPath, args: ['-e', code] } : { command: 'npm', args: ['run', 'build'], reason: misleading };
    const responses: StreamEvent[][] = code ? [[processCall('failed-trust', code)], [completion([check], misleading)]] : [[completion([check], misleading)]];
    const harness = panelHarness(responses);
    harness.send({ type: 'send', model: 'test', text: 'Bitte korrigiere den Build und teste ihn.' });
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true), { timeout: 5000 });
    const final = harness.sent.find(message => message.type === 'assistantFinal')!;
    const report = JSON.parse(final.text as string);
    expect(report).toMatchObject({ verification: state, checks: [{ state: code ? 'failed' : 'not_run' }],
      unverifiedModelText: { source: 'model', verified: false, notice: 'Suggestions and stated reasons are not completion evidence.', nextSteps: misleading } });
    expect(report).not.toHaveProperty('nextSteps');
    expect(report.checks[0]).not.toHaveProperty('reason');
    if (!code) expect(report.unverifiedModelText.checkReasons[0].text).toBe(misleading);
    const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ id: string; history: ChatMessage[]; transcript: Array<{ completionReport?: unknown }> }>;
    expect(JSON.parse(sessions[0].history.at(-1)!.content as string).unverifiedModelText).toEqual(report.unverifiedModelText);
    expect(sessions[0].transcript.at(-1)?.completionReport).toEqual(report);
    harness.send({ type: 'switchSession', sessionId: sessions[0].id });
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'restore')).toBe(true));
    const items = harness.sent.find(message => message.type === 'restore')!.items as Array<{ text: string; completionReport?: unknown }>;
    expect(items.at(-1)?.completionReport).toEqual(report);
    expect(JSON.parse(items.at(-1)!.text).unverifiedModelText).toEqual(report.unverifiedModelText);
  } finally { env.config.approvalMode = mode; await rm(directory, { recursive: true, force: true }); }
});

it('writes webview copy requests to the VS Code clipboard and reports the result', async () => {
  const harness = panelHarness([]);
  env.clipboard.mockResolvedValueOnce(undefined);
  harness.send({ type: 'copy', requestId: 'one', text: 'Complete answer\nconsole.log("safe");' });
  await vi.waitFor(() => expect(harness.sent).toContainEqual({ type: 'copyResult', requestId: 'one', success: true }));
  expect(env.clipboard).toHaveBeenCalledWith('Complete answer\nconsole.log("safe");');
  env.clipboard.mockRejectedValueOnce(new Error('Clipboard unavailable'));
  harness.send({ type: 'copy', requestId: 'two', text: 'Retry' });
  await vi.waitFor(() => expect(harness.sent).toContainEqual({ type: 'copyResult', requestId: 'two', success: false }));
});

const tool: StreamEvent = { kind: 'toolCall', value: {
  id: 'c1', type: 'function', function: { name: 'create_file', arguments: createArgs },
} };

it('defaults to tools even with an active editor; approvals execute and tool results survive follow-ups', async () => {
  const harness = panelHarness([[tool], [{ kind: 'text', value: 'Created snake.html.' }], [{ kind: 'text', value: 'It is ready.' }]]);
  // Also check the actual generated browser script, including template escaping.
  const script = harness.webview.html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)?.[1];
  expect(script).toBeTruthy();
  expect(() => new Script(script!)).not.toThrow();
  expect(harness.webview.html).not.toContain('editActiveFile');
  expect(harness.webview.html).toContain('permissionMode');
  harness.send({ type: 'send', text: 'Create a snake game', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'approval')).toBe(true));
  const approval = harness.sent.find((message) => message.type === 'approval')!;
  expect(harness.requests[0].messages.find((message) => message.role === 'user')?.content).toBe('Create a snake game');
  expect(harness.requests[0].tools?.some((entry) => entry.function.name === 'create_file')).toBe(true);
  harness.send({ type: 'approval', approvalId: approval.approvalId, approved: true });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'assistantDone')).toBe(true));
  expect(env.files.get('/project/existing.ts')).toBe('important original');
  expect(env.files.has('/project/snake.html')).toBe(true);
  expect(harness.requests[1].messages.some((message) => message.role === 'tool' && message.content === 'Created snake.html.')).toBe(true);
  harness.send({ type: 'send', text: 'What did you create?', model: 'test' });
  await vi.waitFor(() => expect(harness.requests).toHaveLength(3));
  expect(harness.requests[2].messages.some((message) => message.role === 'tool')).toBe(true);
  await vi.waitFor(() => expect(harness.sent.filter((message) => message.type === 'assistantDone')).toHaveLength(2));
});

it('keeps tool-call progress separate from the final answer and persists it before the operation', async () => {
  const harness = panelHarness([[{ kind: 'text', value: 'I will create the requested file.' }, tool], [{ kind: 'text', value: 'Created snake.html.' }]]);
  harness.send({ type: 'send', text: 'Create a snake game', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'reasoningDelta')).toBe(true));
  const progressIndex = harness.sent.findIndex((message) => message.type === 'reasoningDelta');
  const operationIndex = harness.sent.findIndex((message) => message.type === 'toolStart');
  expect(progressIndex).toBeLessThan(operationIndex);
  const approval = harness.sent.find((message) => message.type === 'approval')!;
  harness.send({ type: 'approval', approvalId: approval.approvalId, approved: true });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'assistantDone')).toBe(true));
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ role: string; text: string }> }>;
  const stored = sessions[0].transcript.find((item) => item.role === 'Reasoning');
  expect(stored?.text).toBe('I will create the requested file.');
  expect(sessions[0].transcript.map((item) => item.role)).toEqual(['You', 'Reasoning', 'Tool', 'DeepLocal']);
  expect(JSON.parse(sessions[0].transcript.at(-1)!.text)).toMatchObject({ verification: 'unverified', attempts: [{ tool: 'create_file', saved: true }] });
  expect(harness.sent.filter(message => message.type === 'assistantFinal')[0].text).not.toBe('Created snake.html.');
});

it('reports interrupted evidence rather than promoting unfinished model prose', async () => {
  const harness = panelHarness([]);
  harness.client.streamChat = async function* () {
    yield { kind: 'text', value: 'I will inspect the workspace.' } as StreamEvent;
    throw new Error('Stream interrupted');
  };
  harness.send({ type: 'send', text: 'Inspect the project', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'assistantDone')).toBe(true));
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ role: string; text: string }> }>;
  expect(JSON.parse(sessions[0].transcript.at(-1)!.text)).toMatchObject({ verification: 'interrupted', attempts: [], limitation: 'Stream interrupted' });
  expect(harness.sent.find(message => message.type === 'assistantFinal')?.text).not.toContain('I will inspect the workspace.');
});

it('keeps provider summaries distinct and carries opaque Responses items across tools and follow-ups', async () => {
  const firstContext = { source: 'remote:https://example.test/v1', model: 'test', items: [
    { type: 'reasoning', id: 'r1', summary: [], encrypted_content: 'opaque-secret' },
    { type: 'function_call', call_id: 'c1', name: 'create_file', arguments: createArgs },
  ] };
  const finalContext = { ...firstContext, items: [{ type: 'message', phase: 'final_answer', content: [{ type: 'output_text', text: 'Created.' }] }] };
  const harness = panelHarness([
    [{ kind: 'summary', id: 'r1:0', value: 'Planning the file.' }, { kind: 'text', value: 'I will create it.' }, { kind: 'responseContext', value: firstContext }, tool],
    [{ kind: 'summary', id: 'r2:0', value: 'Reviewing the result.' }, { kind: 'text', value: 'Created.' }, { kind: 'responseContext', value: finalContext }],
    [{ kind: 'text', value: 'Yes.' }],
  ]);
  harness.send({ type: 'send', text: 'Create a file', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'approval')).toBe(true));
  const approval = harness.sent.find(message => message.type === 'approval')!;
  harness.send({ type: 'approval', approvalId: approval.approvalId, approved: true });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));
  expect(harness.requests[1].messages.find(message => message.tool_calls)?.responseContext).toEqual(firstContext);
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ id: string; transcript: Array<{ role: string; text: string }> }>;
  expect(sessions[0].transcript.map(item => item.role)).toEqual(['You', 'Summary', 'Reasoning', 'Tool', 'Summary', 'DeepLocal']);
  harness.send({ type: 'switchSession', sessionId: sessions[0].id });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'restore')).toBe(true));
  expect(JSON.stringify(harness.sent)).not.toContain('opaque-secret');
  harness.send({ type: 'send', text: 'Please explain the result', model: 'test', useAgent: false });
  await vi.waitFor(() => expect(harness.requests).toHaveLength(3));
  // The discarded unstructured completion must not survive as opaque context.
  expect(harness.requests[2].messages.some(message => message.responseContext?.items[0]?.phase === 'final_answer')).toBe(false);
  expect(harness.requests[2].messages.some(message => message.responseContext?.items[0]?.type === 'reasoning')).toBe(true);
  await vi.waitFor(() => expect(harness.sent.filter(message => message.type === 'assistantDone')).toHaveLength(2));
});

it('persists a provider summary when the stream fails before producing an answer', async () => {
  const harness = panelHarness([]);
  harness.client.streamChat = async function* () {
    yield { kind: 'summary', id: 'r1:0', value: 'Partial summary' } as StreamEvent;
    throw new Error('Stream interrupted');
  };
  harness.send({ type: 'send', text: 'Explain this project', model: 'test', useAgent: false });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ role: string; text: string }> }>;
  expect(sessions[0].transcript.map(item => item.role)).toEqual(['You', 'Summary']);
  expect(sessions[0].transcript.at(-1)?.text).toBe('Partial summary');
});


it('Stop dismisses approval, prevents writes and new turns, and permits a subsequent task', async () => {
  const secondTool: StreamEvent = { kind: 'toolCall', value: {
    id: 'c2', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'other.html', content: 'other' }) },
  } };
  const harness = panelHarness([[tool, secondTool], [{ kind: 'text', value: 'New task completed.' }]]);
  harness.send({ type: 'send', text: 'Create a file', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'approval')).toBe(true));
  harness.send({ type: 'send', text: 'duplicate request', model: 'test' });
  harness.send({ type: 'stop' });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'assistantDone')).toBe(true));
  expect(env.apply).not.toHaveBeenCalled();
  expect(harness.requests).toHaveLength(1);
  expect(harness.sent.some((message) => message.type === 'approvalDone')).toBe(true);
  harness.send({ type: 'send', text: 'Explain the project', model: 'test', useAgent: false });
  await vi.waitFor(() => expect(harness.requests).toHaveLength(2));
  expect(harness.requests[1].tools).toBeUndefined();
  expect(harness.requests[1].messages.filter((message) => message.role === 'tool')).toHaveLength(2);
  expect(harness.requests[1].messages.find((message) => message.tool_call_id === 'c2')?.content).toContain('not executed');
  await vi.waitFor(() => expect(harness.sent.filter((message) => message.type === 'assistantDone')).toHaveLength(2));
});

it('reports step exhaustion instead of claiming completion', async () => {
  env.config.agentMaxTurns = 1;
  const harness = panelHarness([[tool]]);
  harness.send({ type: 'send', text: 'Create a file', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'approval')).toBe(true));
  const approval = harness.sent.find((message) => message.type === 'approval')!;
  harness.send({ type: 'approval', approvalId: approval.approvalId, approved: false });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'assistantDone')).toBe(true));
  const final = harness.sent.find(message => message.type === 'assistantFinal')!;
  expect(JSON.parse(final.text as string)).toMatchObject({ verification: 'interrupted', limitation: expect.stringContaining('safety limit') });
  expect(env.apply).not.toHaveBeenCalled();
});

function addSecondWorkspace() {
  const second = { name: 'project', uri: { fsPath: '/second', scheme: 'file', toString: () => '/second' }, index: 1 } as vscode.WorkspaceFolder;
  env.folders.push(second);
  return second;
}

it('shows the automatic single root without asking and requires a deliberate choice for multiple roots', async () => {
  const harness = panelHarness([]);
  harness.send({ type: 'ready' });
  await vi.waitFor(() => expect(harness.sent).toContainEqual({ type: 'workspace', label: 'project', path: '/project', canSelect: false }));
  expect(env.picker).not.toHaveBeenCalled();
  addSecondWorkspace();
  harness.send({ type: 'send', text: 'Inspect', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'error' && String(message.message).includes('choose a workspace'))).toBe(true));
  expect(harness.requests).toHaveLength(0);
  env.picker.mockImplementationOnce(async items => items[1]);
  harness.send({ type: 'selectWorkspace' });
  await vi.waitFor(() => expect(harness.sent).toContainEqual({ type: 'workspace', label: 'project (/second)', path: '/second', canSelect: true }));
  expect(env.picker.mock.calls[0][0].map((item: { description: string }) => item.description)).toEqual(['/project', '/second']);
});

it('cancelling the folder picker retains the previous choice; no folder blocks agent work', async () => {
  const second = addSecondWorkspace();
  env.picker.mockResolvedValueOnce({ folder: second }).mockResolvedValueOnce(undefined);
  const harness = panelHarness([]);
  harness.send({ type: 'selectWorkspace' });
  await vi.waitFor(() => expect(harness.sent.at(-1)).toMatchObject({ type: 'workspace', path: '/second', canSelect: true }));
  harness.send({ type: 'selectWorkspace' });
  await vi.waitFor(() => expect(env.picker).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(harness.sent.at(-1)).toMatchObject({ type: 'workspace', path: '/second', canSelect: true }));
  env.folders = [];
  env.foldersChanged({ added: [], removed: [second] });
  expect(harness.sent.at(-1)).toMatchObject({ type: 'workspace', label: 'No folder open' });
  harness.send({ type: 'send', text: 'Inspect', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));
  expect(harness.requests).toHaveLength(0);
});

it('pins every turn and approval to the chosen root and ignores switches during a task', async () => {
  const second = addSecondWorkspace();
  env.picker.mockResolvedValueOnce({ folder: second });
  const harness = panelHarness([[tool], [{ kind: 'text', value: 'Created in second.' }]]);
  harness.send({ type: 'selectWorkspace' });
  await vi.waitFor(() => expect(harness.sent.at(-1)).toMatchObject({ type: 'workspace', path: '/second', canSelect: true }));
  harness.send({ type: 'send', text: 'Create', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'approval')).toBe(true));
  harness.send({ type: 'selectWorkspace' });
  expect(env.picker).toHaveBeenCalledTimes(1);
  expect(harness.sent.filter(message => message.type === 'workspace').at(-1)).toMatchObject({ path: '/second', canSelect: false });
  expect(harness.requests[0].messages[0].content).toContain('Active workspace folder for this task: project (/second)');
  const approval = harness.sent.find(message => message.type === 'approval')!;
  harness.send({ type: 'approval', approvalId: approval.approvalId, approved: true });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));
  expect(env.files.get('/second/snake.html')).toBe('<html>snake</html>');
  expect(env.files.has('/project/snake.html')).toBe(false);
  expect(harness.requests[1].messages[0].content).toContain('/second');
});

it('removing the task root during approval stops the task without writes or fallback', async () => {
  const second = addSecondWorkspace();
  env.picker.mockResolvedValueOnce({ folder: second });
  const harness = panelHarness([[tool]]);
  harness.send({ type: 'selectWorkspace' });
  await vi.waitFor(() => expect(harness.sent.at(-1)).toMatchObject({ path: '/second', canSelect: true }));
  harness.send({ type: 'send', text: 'Create', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'approval')).toBe(true));
  env.folders = [env.folders[0]];
  env.foldersChanged({ added: [], removed: [second] });
  await vi.waitFor(() => expect(harness.sent).toContainEqual({ type: 'assistantDone', outcome: 'cancelled' }));
  expect(env.apply).not.toHaveBeenCalled();
  expect(harness.requests).toHaveLength(1);
  expect(harness.sent.some(message => message.type === 'notice' && String(message.message).includes('removed'))).toBe(true);
});

it('does not start a competing task while the folder picker is pending', async () => {
  const second = addSecondWorkspace();
  let resolve!: (value: unknown) => void;
  env.picker.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  const harness = panelHarness([]);
  harness.send({ type: 'selectWorkspace' });
  harness.send({ type: 'send', text: 'Create', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true));
  expect(harness.requests).toHaveLength(0);
  resolve({ folder: second });
  await vi.waitFor(() => expect(harness.sent.at(-1)).toMatchObject({ path: '/second', canSelect: true }));
});

it('deletes only from the pinned root even if the options change during approval', async () => {
  const second = addSecondWorkspace();
  env.files.set('/second/existing.ts', 'second contents');
  const options = { workspaceFolder: second, approvalMode: 'every' as const, approve: async () => {
    options.workspaceFolder = env.folders[0]; return true;
  } };
  const result = await invokeAgentTool('delete', 'delete_file', '{"path":"existing.ts"}', options);
  expect(result.status).toBe('success');
  expect(env.trash).toHaveBeenCalledWith('/second/existing.ts', { recursive: false, useTrash: true });
  expect(env.files.get('/project/existing.ts')).toBe('important original');
  expect(env.files.has('/second/existing.ts')).toBe(false);
});

const verificationCall = (id: string, script = 'lint'): StreamEvent => ({ kind: 'toolCall', value: {
  id, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm', args: ['run', script], verification: true }) },
} });
const repairEdit = (id = 'repair-edit'): StreamEvent => ({ kind: 'toolCall', value: {
  id, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'fixture.html', content: `fixed ${id}` }) },
} });
const submitRepair = (id: string, scripts: string[] = []): StreamEvent => ({ kind: 'toolCall', value: {
  id, type: 'function', function: { name: 'submit_completion', arguments: JSON.stringify({ checks: scripts.map(script => ({ command: 'npm', args: ['run', script] })), nextSteps: '' }) },
} });

async function repairHarness(responses: StreamEvent[][], outcomes: Partial<CommandResult>[], limit = 3) {
  env.config.agentMaxTurns = 30;
  env.config.agentMaxRepairIterations = limit;
  env.config.approvalMode = 'full';
  const module = await import('../../src/agent-tools');
  const original = module.invokeAgentTool;
  const commands: string[] = [];
  vi.spyOn(module, 'invokeAgentTool').mockImplementation(async (id, name, args, options) => {
    if (name !== 'run_command') return original(id, name, args, options);
    commands.push(id);
    const input = JSON.parse(args);
    const next = outcomes.shift();
    if (!next) throw new Error('Unexpected command execution');
    const command: CommandResult = { command: input.command, args: input.args, cwd: '/project', exitCode: 0, signal: null,
      stdout: '', stderr: '', durationMs: 1, timedOut: false, cancelled: false, outputLimitExceeded: false, truncated: false, error: null, ...next };
    return { callId: id, name, status: command.exitCode === 0 ? 'success' : 'error', content: JSON.stringify(command), command };
  });
  const harness = panelHarness(responses);
  return { ...harness, commands, done: async () => {
    await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'assistantDone')).toBe(true), { timeout: 5000 });
    return harness.sent.find(message => message.type === 'assistantFinal')!.completionReport as {
      verification: string; limitation?: string; checks: Array<{ state: string; command: string }>;
      attempts: Array<{ id: string; state: string; exitCode?: number; saved?: boolean }>;
    };
  } };
}

it('repairs a failed verification after rejected completion and preserves Responses tool continuation', async () => {
  const rejectedContext = { source: 'local:http://example.test/v1', model: 'test', items: [
    { type: 'function_call', call_id: 'premature79', name: 'submit_completion', arguments: JSON.stringify({ checks: [], nextSteps: '' }) },
  ] };
  const harness = await repairHarness([
    [verificationCall('lint79-first')],
    [{ kind: 'responseContext', value: rejectedContext }, submitRepair('premature79')],
    [repairEdit()], [verificationCall('lint79-fixed')], [submitRepair('finished79')],
  ], [{ exitCode: 1, stderr: 'fixture.html:1 lint error' }, {}]);
  harness.send({ type: 'send', model: 'test', text: 'Fix the lint error and verify it.' });
  const report = await harness.done();
  expect(report.verification).toBe('checks_passed');
  expect(report.checks.map(check => check.state)).toEqual(['passed']);
  expect(report.attempts.filter(attempt => attempt.exitCode !== undefined).map(attempt => attempt.exitCode)).toEqual([1, 0]);
  expect(harness.requests[2].messages.find(message => message.tool_calls?.[0].id === 'premature79')?.responseContext).toEqual(rejectedContext);
  expect(harness.requests[2].messages.find(message => message.tool_call_id === 'premature79')?.content).toContain('Verification is unresolved');
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ role: string; completionReport?: unknown }>; history: ChatMessage[] }>;
  expect(sessions[0].transcript.filter(item => item.role === 'Tool')).toHaveLength(3);
  expect(sessions[0].transcript.at(-1)?.completionReport).toEqual(report);
  expect(JSON.parse(sessions[0].history.at(-1)!.content!)).toEqual(report);
  env.config.approvalMode = 'every';
});

it('keeps a failed build required when later completion lists only passing lint', async () => {
  const harness = await repairHarness([
    [verificationCall('lint-pass')], [verificationCall('build-fail', 'build')], [submitRepair('omit-build', ['lint'])],
    [repairEdit()], [verificationCall('lint-again')], [verificationCall('build-fixed', 'build')], [submitRepair('done-build', ['lint'])],
  ], [{}, { exitCode: 2, stdout: 'TypeScript duplicate identifier' }, {}, {}]);
  harness.send({ type: 'send', model: 'test', text: 'Fix lint and build.' });
  const report = await harness.done();
  expect(report.verification).toBe('checks_passed');
  expect(report.checks).toHaveLength(2);
  expect(report.checks.map(check => check.state)).toEqual(['passed', 'passed']);
  expect(harness.requests[3].messages.at(-1)?.content).toContain('failed build');
  expect(harness.commands).toEqual(['lint-pass', 'build-fail', 'lint-again', 'build-fixed']);
  env.config.approvalMode = 'every';
});

it('stops identical diagnostic failures after a repair without requesting another model turn', async () => {
  const harness = await repairHarness([
    [verificationCall('first')], [repairEdit()], [verificationCall('second')],
  ], [{ exitCode: 1, stderr: 'same diagnostic' }, { exitCode: 1, stderr: 'same diagnostic' }]);
  env.config.agentMaxTurns = 3;
  harness.send({ type: 'send', model: 'test', text: 'Repair lint.' });
  const report = await harness.done();
  expect(report.verification).toBe('failed');
  expect(report.limitation).toContain('two identical failures');
  expect(harness.requests).toHaveLength(3);
  env.config.approvalMode = 'every';
});

it('suppresses an identical failed command when no repair changed workspace state', async () => {
  const harness = await repairHarness([[verificationCall('first')], [verificationCall('blind-repeat')]], [{ exitCode: 1, stderr: 'broken' }]);
  harness.send({ type: 'send', model: 'test', text: 'Fix lint.' });
  const report = await harness.done();
  expect(harness.commands).toEqual(['first']);
  expect(report.checks[0].state).toBe('failed');
  expect(report.attempts.at(-1)).toMatchObject({ id: 'blind-repeat', state: 'not_run' });
  expect(report.limitation).toContain('already failed');
  env.config.approvalMode = 'every';
});

it('stops changing failures at the configured repair boundary', async () => {
  const harness = await repairHarness([[verificationCall('first')], [repairEdit()], [verificationCall('second')], [repairEdit('beyond-limit')]],
    [{ exitCode: 1, stderr: 'first error' }, { exitCode: 1, stderr: 'different error' }], 1);
  harness.send({ type: 'send', model: 'test', text: 'Repair lint.' });
  const report = await harness.done();
  expect(report.limitation).toContain('iteration limit (1)');
  expect(report.verification).toBe('failed');
  expect(harness.requests).toHaveLength(4);
  expect(env.apply).toHaveBeenCalledOnce();
  expect(report.attempts.at(-1)).toMatchObject({ id: 'beyond-limit', state: 'not_run' });
  env.config.approvalMode = 'every';
});

it('requests missing verification after an edit without losing tool transcript or replaying unchecked prose', async () => {
  const harness = await repairHarness([[repairEdit()], [{ kind: 'text', value: 'Everything passed, all fixed!' }],
    [verificationCall('observed')], [submitRepair('finished')]], [{}]);
  harness.send({ type: 'send', model: 'test', text: 'Change the source and verify it.' });
  const report = await harness.done();
  expect(report.verification).toBe('checks_passed');
  expect(harness.requests[2].messages.at(-1)?.content).toContain('verification:true');
  expect(JSON.stringify(harness.requests)).not.toContain('Everything passed, all fixed!');
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ role: string }> }>;
  expect(sessions[0].transcript.filter(item => item.role === 'Tool')).toHaveLength(2);
  env.config.approvalMode = 'every';
});

it.each(['stop', 'workspace removal'])('cancels an active repair during approval on %s without executing later checks', async action => {
  const harness = await repairHarness([[verificationCall('failed-before-stop')], [repairEdit()], [verificationCall('must-not-run')]],
    [{ exitCode: 1, stderr: 'repair needed' }]);
  env.config.approvalMode = 'every';
  harness.send({ type: 'send', model: 'test', text: 'Repair and verify.' });
  await vi.waitFor(() => expect(harness.sent.some(message => message.type === 'approval')).toBe(true));
  if (action === 'stop') harness.send({ type: 'stop' });
  else {
    const removed = env.folders;
    env.folders = [];
    env.foldersChanged({ added: [], removed });
  }
  const report = await harness.done();
  expect(report.verification).toBe('interrupted');
  expect(report.attempts[0]).toMatchObject({ id: 'failed-before-stop', exitCode: 1 });
  expect(harness.commands).toEqual(['failed-before-stop']);
  expect(harness.requests).toHaveLength(2);
  expect(env.apply).not.toHaveBeenCalled();
  expect(harness.sent).toContainEqual({ type: 'assistantDone', outcome: 'cancelled' });
  expect(harness.sent.some(message => message.type === 'approvalDone')).toBe(true);
});
