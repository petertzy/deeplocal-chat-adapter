import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import { posix as path } from 'node:path';
import { ChatPanel } from '../../src/chat-panel';
import * as vscode from 'vscode';
import { invokeAgentTool } from '../../src/agent-tools';
import { ChatCompletionRequest, StreamEvent } from '../../src/protocol';
import { toolActivity } from '../../src/tool-activity';

const env = vi.hoisted(() => ({
  files: new Map<string, string>(), dirty: false, version: 1,
  apply: vi.fn(), show: vi.fn(), dispose: vi.fn(), command: vi.fn(), trash: vi.fn(),
  clipboard: vi.fn(), picker: vi.fn(),
  folders: [] as vscode.WorkspaceFolder[],
  foldersChanged: (_event: vscode.WorkspaceFoldersChangeEvent) => {},
  config: { injectSystemPrompt: true, agentMaxTurns: 3, maxOutputTokens: 1000, backend: 'local', approvalMode: 'every' },
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
    workspace: {
      get workspaceFolders() { return env.folders; },
      onDidChangeWorkspaceFolders: (callback: typeof env.foldersChanged) => { env.foldersChanged = callback; return { dispose: vi.fn() }; },
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
        save: async () => true,
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
  env.files.set('/project/existing.ts', 'important original');
  env.dirty = false;
  env.version = 1;
  env.config.agentMaxTurns = 3;
});
afterEach(() => vi.useRealTimers());

const createArgs = JSON.stringify({ path: 'snake.html', content: '<html>snake</html>' });

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

function panelHarness(responses: StreamEvent[][]) {
  const state = new Map<string, unknown>();
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
  expect(sessions[0].transcript.at(-1)?.text).toBe('Created snake.html.');
});

it('retains partial progress when a model stream fails', async () => {
  const harness = panelHarness([]);
  harness.client.streamChat = async function* () {
    yield { kind: 'text', value: 'I will inspect the workspace.' } as StreamEvent;
    throw new Error('Stream interrupted');
  };
  harness.send({ type: 'send', text: 'Inspect the project', model: 'test' });
  await vi.waitFor(() => expect(harness.sent.some((message) => message.type === 'assistantDone')).toBe(true));
  const sessions = [...harness.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ role: string; text: string }> }>;
  expect(sessions[0].transcript.at(-1)).toEqual({ role: 'Reasoning', text: 'I will inspect the workspace.' });
  expect(harness.sent.some((message) => message.type === 'assistantFinal')).toBe(false);
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
  expect(harness.requests[2].messages.some(message => message.responseContext?.items[0]?.phase === 'final_answer')).toBe(true);
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
  expect(harness.sent.some((message) => message.type === 'error' && String(message.message).includes('safety limit'))).toBe(true);
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
