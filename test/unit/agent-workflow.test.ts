import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Script } from 'node:vm';
import * as path from 'node:path';
import { ChatPanel } from '../../src/chat-panel';
import { invokeAgentTool } from '../../src/agent-tools';
import { ChatCompletionRequest, StreamEvent } from '../../src/protocol';

const env = vi.hoisted(() => ({
  files: new Map<string, string>(), dirty: false, version: 1,
  apply: vi.fn(), show: vi.fn(), dispose: vi.fn(), command: vi.fn(),
  config: { injectSystemPrompt: true, agentMaxTurns: 3, maxOutputTokens: 1000, backend: 'local' },
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
    Uri: { parse: uri, joinPath: (root: { fsPath: string }, relative: string) => uri(path.resolve(root.fsPath, relative)) },
    WorkspaceEdit, Position: class {}, Range: class {},
    window: { showTextDocument: env.show, showWarningMessage: vi.fn(), activeTextEditor: {
      document: { fileName: '/project/existing.ts', uri: uri('/project/existing.ts'), getText: () => 'important original' },
    } },
    commands: { executeCommand: env.command },
    workspace: {
      workspaceFolders: [{ name: 'project', uri: uri('/project') }],
      asRelativePath: (target: { fsPath: string }) => path.relative('/project', target.fsPath),
      registerTextDocumentContentProvider: () => ({ dispose: env.dispose }),
      fs: { stat: async (target: { fsPath: string }) => {
        if (!env.files.has(target.fsPath)) throw Object.assign(new Error('not found'), { code: 'FileNotFound' });
        return {};
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
  const panel = new ChatPanel({ workspaceState: memento, globalState: memento } as never, client as never,
    { error: vi.fn() } as never, { get: async () => '', set: async () => {}, clear: async () => {} });
  const webview = { html: '', options: {}, cspSource: 'test:',
    postMessage: (message: Record<string, unknown>) => { sent.push(message); },
    onDidReceiveMessage: (handler: typeof receive) => { receive = handler; },
  };
  panel.resolveWebviewView({ webview, onDidDispose: () => {} } as never);
  return { sent, requests, state, webview, client, send: (message: unknown) => receive(message) };
}

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
  expect(harness.sent.some((message) => message.type === 'error' && String(message.message).includes('step limit'))).toBe(true);
  expect(env.apply).not.toHaveBeenCalled();
});
