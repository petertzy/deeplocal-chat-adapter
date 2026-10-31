import { beforeEach, expect, it, vi } from 'vitest';
import { ChatPanel } from '../../src/chat-panel';
import type { AgentToolOptions, AgentToolResult } from '../../src/agent-tools';
import type { ChatCompletionRequest, StreamEvent } from '../../src/protocol';
import type { CompletionReport } from '../../src/task-evidence';
import type { SubagentActivity, SubagentTask } from '../../src/subagent-types';

const env = vi.hoisted(() => ({
  invoke: vi.fn(), verify: vi.fn(), foldersChanged: (_event: unknown) => {},
  folders: [{ name: 'project', index: 0, uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } }],
  config: { backend: 'local', baseUrl: 'http://local/v1', apiMode: 'chat-completions', approvalMode: 'safe',
    injectSystemPrompt: true, agentMaxTurns: 5, agentMaxRepairIterations: 0, maxOutputTokens: 1000,
    subagents: { enabled: true, maxConcurrent: 2, maxTasks: 6, maxTurns: 8, timeoutMs: 120000,
      batchTimeoutMs: 300000, maxOutputTokens: 8192, totalOutputTokens: 32768 } },
}));
vi.mock('../../src/config', () => ({ getConfig: () => env.config }));
vi.mock('../../src/agent-tools', () => ({
  getAgentTools: () => [], invokeAgentTool: env.invoke, verifyResearchSources: env.verify,
  toolResultsToMessages: (results: AgentToolResult[]) => results.map(result => ({ role: 'tool', tool_call_id: result.callId, content: result.content })),
}));
vi.mock('vscode', () => ({
  workspace: {
    get workspaceFolders() { return env.folders; },
    onDidChangeWorkspaceFolders: (callback: typeof env.foldersChanged) => { env.foldersChanged = callback; return { dispose: vi.fn() }; },
    registerTextDocumentContentProvider: () => ({ dispose: vi.fn() }),
  },
}));

const task = (title: string): SubagentTask => ({ title, objective: `Inspect ${title}`, context: `Only ${title} context`, paths: ['src'], tools: ['read_file'] });
const tool = (id: string, name: string, args: unknown): StreamEvent => ({ kind: 'toolCall', value: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } });
const submission = () => tool('submitted', 'submit_research', { findings: [{ text: 'Observed export.', evidence: [{ observationId: 'obs-1', quote: 'export const value' }] }], limitations: [] });

beforeEach(() => {
  vi.clearAllMocks();
  env.folders = [{ name: 'project', index: 0, uri: { scheme: 'file', fsPath: '/project', toString: () => 'file:///project' } }];
  env.config.approvalMode = 'safe';
  env.config.subagents.enabled = true;
  env.verify.mockResolvedValue(undefined);
  env.invoke.mockImplementation(async (id: string, name: string, _args: string, options: AgentToolOptions): Promise<AgentToolResult> => {
    if (options.approvalMode === 'every') {
      if (!await options.approve?.('Read src/file.ts?')) return { callId: id, name, status: 'declined', content: 'User declined tool execution.' };
    }
    options.signal?.throwIfAborted();
    return { callId: id, name, status: 'success', content: 'export const value = 1;', researchSources: [{ path: 'src/file.ts', digest: 'host-digest' }] };
  });
});

function harness(tasks = [task('A'), task('B')], failSecond = false, saved?: unknown[]) {
  const state = new Map<string, unknown>();
  if (saved) state.set('deeplocal.sessions.folders:file:///project', saved);
  const memento = { get: (key: string, fallback: unknown) => state.get(key) ?? fallback,
    update: async (key: string, value: unknown) => { state.set(key, structuredClone(value)); } };
  const sent: Array<Record<string, any>> = [];
  const requests: Array<{ id: string; request: ChatCompletionRequest }> = [];
  let receive = (_message: unknown) => {};
  let dispose = () => {};
  let primaryTurns = 0;
  const client = {
    modelInformation: () => ({ toolCalling: true, maxOutputTokens: 1000 }), listModels: async () => [{ id: 'test' }], cancel: vi.fn(),
    streamChat: async function* (id: string, request: ChatCompletionRequest): AsyncGenerator<StreamEvent> {
      requests.push({ id, request: structuredClone(request) });
      if (id.includes(':child:')) {
        if (failSecond && JSON.parse(request.messages[1].content!).title === 'B') {
          yield tool('forbidden', 'write_file', { path: 'src/file.ts', content: 'no' });
        } else if (id.endsWith(':turn:1')) yield tool('read', 'read_file', { path: 'src/file.ts' });
        else yield submission();
      } else if (primaryTurns++ === 0) yield tool('delegate', 'delegate_research', { tasks });
      else yield tool('complete', 'submit_completion', { checks: [], nextSteps: '' });
    },
  };
  const panel = new ChatPanel({ subscriptions: [], workspaceState: memento, globalState: memento } as never, client as never,
    { error: vi.fn() } as never, { get: async () => '', set: async () => {}, clear: async () => {} });
  panel.resolveWebviewView({ webview: { html: '', options: {}, cspSource: 'test:',
    postMessage: (message: Record<string, unknown>) => sent.push(message),
    onDidReceiveMessage: (callback: typeof receive) => { receive = callback; } }, onDidDispose: (callback: () => void) => { dispose = callback; } } as never);
  return { state, sent, client, requests, send: (message: unknown) => receive(message), dispose: () => dispose(),
    done: async () => {
      await vi.waitFor(() => expect(sent.some(message => message.type === 'assistantDone')).toBe(true));
      return sent.find(message => message.type === 'assistantFinal')!.completionReport as CompletionReport;
    } };
}

it('integrates attributed partial research, scoped invocation, freshness and canonical saved evidence', async () => {
  const h = harness(undefined, true);
  h.send({ type: 'send', model: 'test', text: 'Research independent tasks' });
  const report = await h.done();
  expect(report.verification).toBe('unverified');
  expect(report.research?.[0].state).toBe('partial');
  expect(report.research?.[0].results.map(result => result.state)).toEqual(['completed', 'failed']);
  expect(env.invoke).toHaveBeenCalledTimes(1);
  expect(env.invoke.mock.calls[0][3]).toMatchObject({ researchPolicy: { tools: ['read_file'], paths: ['src'] }, workspaceFolder: env.folders[0] });
  expect(env.verify).toHaveBeenCalledWith([{ path: 'src/file.ts', digest: 'host-digest' }], expect.objectContaining({ researchPolicy: { tools: ['read_file'], paths: ['src'] } }));
  const primary = h.requests.filter(request => !request.id.includes(':child:'));
  expect(primary[1].request.messages.some(message => message.role === 'tool' && message.content?.includes('partial'))).toBe(true);
  const sessions = [...h.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ subagent?: SubagentActivity; completionReport?: CompletionReport }> }>;
  expect(sessions[0].transcript.filter(item => item.subagent)).toHaveLength(2);
  expect(sessions[0].transcript.at(-1)?.completionReport).toEqual(report);
});

it('serializes child approvals and dismisses each before presenting the next', async () => {
  env.config.approvalMode = 'every';
  const h = harness();
  h.send({ type: 'send', model: 'test', text: 'Research two tasks' });
  await vi.waitFor(() => expect(h.sent.filter(message => message.type === 'approval')).toHaveLength(1));
  const first = h.sent.find(message => message.type === 'approval')!;
  expect(first.message).toContain('Research: A');
  h.send({ type: 'approval', approvalId: first.approvalId, approved: true });
  await vi.waitFor(() => expect(h.sent.filter(message => message.type === 'approval')).toHaveLength(2));
  const second = h.sent.filter(message => message.type === 'approval')[1];
  expect(second.message).toContain('Research: B');
  expect(h.sent.findIndex(message => message.type === 'approvalDone' && message.approvalId === first.approvalId))
    .toBeLessThan(h.sent.indexOf(second));
  h.send({ type: 'approval', approvalId: second.approvalId, approved: true });
  expect((await h.done()).research?.[0].state).toBe('completed');
});

it.each(['stop', 'workspace removal'])('cancels queued children and all approvals on %s', async reason => {
  env.config.approvalMode = 'every';
  const h = harness([task('A'), task('B'), task('C')]);
  h.send({ type: 'send', model: 'test', text: 'Research three tasks' });
  await vi.waitFor(() => expect(h.sent.some(message => message.type === 'approval')).toBe(true));
  if (reason === 'stop') h.send({ type: 'stop' });
  else { const removed = env.folders; env.folders = []; env.foldersChanged({ added: [], removed }); }
  const report = await h.done();
  expect(report.verification).toBe('interrupted');
  expect(report.research?.[0].results.map(result => result.state)).toEqual(['cancelled', 'cancelled', 'cancelled']);
  expect(h.sent.filter(message => message.type === 'approval')).toHaveLength(1);
  expect(h.sent.filter(message => message.type === 'approvalDone')).toHaveLength(1);
  expect(h.requests.filter(request => !request.id.includes(':child:'))).toHaveLength(1);
  expect(h.sent.filter(message => message.type === 'subagent' && message.activity.state === 'cancelled')).toHaveLength(3);
});

it.each(['disabled', 'chat', 'ask'])('does not expose delegation in %s mode', async mode => {
  env.config.subagents.enabled = mode !== 'disabled';
  env.config.approvalMode = mode === 'ask' ? 'ask' : 'safe';
  const h = harness();
  h.send({ type: 'send', model: 'test', text: 'Research', useAgent: mode !== 'chat' });
  await vi.waitFor(() => expect(h.sent.some(message => message.type === 'assistantDone')).toBe(true));
  expect(h.requests[0].request.tools?.some(tool => tool.function.name === 'delegate_research') ?? false).toBe(false);
  expect(h.requests.some(request => request.id.includes(':child:'))).toBe(false);
  expect(env.invoke).not.toHaveBeenCalled();
});

it('does not send parent history or sibling context to children', async () => {
  const h = harness([task('A'), task('B')], false, [{ id: 'old', title: 'Earlier task', updatedAt: 1,
    history: [{ role: 'user', content: 'parent-history-sentinel' }, { role: 'assistant', content: 'Prior answer' }],
    transcript: [{ role: 'You', text: 'parent-history-sentinel' }, { role: 'DeepLocal', text: 'Prior answer' }] }]);
  h.send({ type: 'send', model: 'test', text: 'Research' });
  await h.done();
  const children = h.requests.filter(request => request.id.includes(':child:'));
  expect(JSON.stringify(children)).not.toContain('parent-history-sentinel');
  for (const child of children) {
    const title = JSON.parse(child.request.messages[1].content!).title;
    expect(JSON.stringify(child.request)).not.toContain(`Only ${title === 'A' ? 'B' : 'A'} context`);
  }
});

it('restores unfinished child cards as interrupted without launching requests', async () => {
  const h = harness(undefined, false, [{ id: 'old', title: 'Saved', updatedAt: 1, history: [],
    transcript: [{ role: 'Tool', text: '', subagent: { id: 'child', parentRequestId: 'old-request', title: 'Inspect', state: 'running' } }] }]);
  h.send({ type: 'ready' });
  await vi.waitFor(() => expect(h.sent.some(message => message.type === 'restore')).toBe(true));
  expect(h.sent.find(message => message.type === 'restore')!.items[0].subagent).toMatchObject({ state: 'cancelled', result: { testsRun: false, limitations: ['Research interrupted by restart; it was not resumed.'] } });
  expect(h.requests).toHaveLength(0);
});

it('rejects stale file evidence while retaining a successful sibling', async () => {
  env.verify.mockRejectedValueOnce(new Error('Research evidence changed or cannot be verified.'));
  const h = harness();
  h.send({ type: 'send', model: 'test', text: 'Research' });
  const report = await h.done();
  expect(report.research?.[0].state).toBe('partial');
  expect(report.research?.[0].results[0]).toMatchObject({ state: 'failed', findings: [] });
  expect(report.research?.[0].results[0].limitations.join(' ')).toContain('Research evidence changed');
});

it('disposing the view cancels research and persists interrupted results', async () => {
  env.config.approvalMode = 'every';
  const h = harness([task('A'), task('B'), task('C')]);
  h.send({ type: 'send', model: 'test', text: 'Research' });
  await vi.waitFor(() => expect(h.sent.some(message => message.type === 'approval')).toBe(true));
  h.dispose();
  await vi.waitFor(() => {
    const sessions = [...h.state.values()].find(Array.isArray) as Array<{ transcript: Array<{ completionReport?: CompletionReport }> }>;
    expect(sessions[0].transcript.at(-1)?.completionReport?.verification).toBe('interrupted');
    expect(sessions[0].transcript.at(-1)?.completionReport?.research?.[0].results.every(result => result.state === 'cancelled')).toBe(true);
  });
  expect(h.requests.filter(request => !request.id.includes(':child:'))).toHaveLength(1);
});
