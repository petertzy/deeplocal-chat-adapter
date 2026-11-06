import { expect, it, vi } from 'vitest';
import type { ChatCompletionRequest, StreamEvent } from '../../src/protocol';
import { DEFAULT_SUBAGENT_LIMITS, type SubagentManagerOptions, type SubagentTask } from '../../src/subagent-types';
import { runSubagent } from '../../src/subagent-runner';

const task: SubagentTask = { title: 'Inspect source', objective: 'Find bounded evidence', context: 'child context', paths: ['src'], tools: ['read_file'] };
function call(name: string, args: unknown, id = name): StreamEvent {
  return { kind: 'toolCall', value: { id, type: 'function', function: { name, arguments: JSON.stringify(args) } } };
}
const report = { findings: [{ text: 'Observed fact', evidence: [{ observationId: 'obs-1', quote: 'actual source' }] }], limitations: [] };
function setup(turns: StreamEvent[][]) {
  const controller = new AbortController();
  let turn = 0;
  const options: SubagentManagerOptions = {
    requestId: 'parent', model: 'model', signal: controller.signal, limits: { ...DEFAULT_SUBAGENT_LIMITS, enabled: true }, maxOutputTokens: 4096,
    stream: vi.fn(async function* (_id: string, _request: ChatCompletionRequest) { yield* turns[turn++] ?? []; }),
    cancel: vi.fn(), invoke: vi.fn(async (_task, tool) => ({ callId: tool.id, name: tool.function.name, status: 'success' as const, content: 'actual source' })),
    reserve: vi.fn(), onActivity: vi.fn(),
  };
  const reserveOutput = vi.fn((requested: number) => requested);
  return { controller, options, reserveOutput, run: () => runSubagent({ id: 'child', task, signal: controller.signal, options, reserveOutput }) };
}

it('keeps task context isolated and maps only host provenance into the report', async () => {
  const context = { source: 'remote', model: 'model', items: [{ type: 'reasoning', encrypted_content: 'opaque' }] };
  const state = setup([[call('read_file', { path: 'src/a.ts' }, 'read'), { kind: 'responseContext', value: context }], [call('submit_research', report, 'submit')]]);
  expect(await state.run()).toMatchObject({ state: 'completed', testsRun: false, findings: [{ evidence: [{ observationId: 'obs-1', tool: 'read_file', path: 'src/a.ts', quote: 'actual source' }] }] });
  const stream = vi.mocked(state.options.stream);
  const first = stream.mock.calls[0][1];
  expect(first.messages).toHaveLength(2);
  expect(JSON.parse(first.messages[1].content!)).toEqual(task);
  expect(first.tools!.map(tool => tool.function.name)).toEqual(['read_file', 'submit_research']);
  expect(first.max_tokens).toBe(2048);
  const second = stream.mock.calls[1][1];
  expect(second.messages[2]).toMatchObject({ role: 'assistant', responseContext: context, tool_calls: [{ id: 'read' }] });
  expect(JSON.parse(second.messages[3].content!)).toEqual({ observationId: 'obs-1', content: 'actual source' });
  expect(stream.mock.calls[0][0]).not.toBe(stream.mock.calls[1][0]);
});

it.each([
  [[call('submit_research', report)]],
  [[call('write_file', { path: 'src/a.ts' })]],
  [[call('read_file', { path: 'other/a.ts' })]],
  [[call('read_file', { path: 'src/../secret' })]],
  [[call('read_file', { path: 'src/a.ts', extra: true })]],
  [[{ kind: 'text', value: 'Done, tests passed.' }]],
  [[call('submit_research', { findings: [], limitations: [], testsRun: true })]],
  [[call('submit_research', { findings: [], limitations: [] }), call('read_file', { path: 'src/a.ts' })]],
] .map(turns => ({ turns: turns as StreamEvent[][] })))('rejects invalid completion or tool violations before invocation %#', async ({ turns }) => {
  const state = setup(turns);
  expect(await state.run()).toMatchObject({ state: 'failed', testsRun: false });
  expect(state.options.invoke).not.toHaveBeenCalled();
});

it('rejects duplicate IDs across turns and fabricated quotes', async () => {
  const duplicate = setup([[call('read_file', { path: 'src/a.ts' }, 'same')], [call('submit_research', report, 'same')]]);
  expect(await duplicate.run()).toMatchObject({ state: 'failed' });
  const fabricated = setup([[call('read_file', { path: 'src/a.ts' })], [call('submit_research', { ...report, findings: [{ text: 'Claim', evidence: [{ observationId: 'obs-1', quote: 'invented' }] }] })]]);
  expect(await fabricated.run()).toMatchObject({ state: 'failed' });
});

it('preserves host discovery limitations even when the model omits them', async () => {
  const state = setup([[call('read_file', { path: 'src/a.ts' })], [call('submit_research', report)]]);
  state.options.invoke = vi.fn(async (_task, tool) => ({ callId: tool.id, name: tool.function.name,
    status: 'success' as const, content: 'actual source', researchLimitations: ['Scoped files may be unscanned.'] }));
  expect((await state.run()).limitations).toContain('Scoped files may be unscanned.');
});

it('stops a declined child before fresh-ID retries or remaining calls can prompt again', async () => {
  const state = setup([[call('read_file', { path: 'src/a.ts' }, 'first'), call('read_file', { path: 'src/a.ts' }, 'same-turn-retry')],
    [call('read_file', { path: 'src/a.ts' }, 'later-retry')]]);
  state.options.invoke = vi.fn(async () => ({ callId: 'read_file', name: 'read_file', status: 'declined' as const, content: 'User declined.' }));
  expect(await state.run()).toMatchObject({ state: 'failed', findings: [], limitations: expect.arrayContaining([expect.stringContaining('blocked by a declined action')]) });
  expect(state.options.invoke).toHaveBeenCalledOnce();
  expect(state.options.stream).toHaveBeenCalledOnce();
});

it('retains ordinary tool errors as limitations and can complete a partial investigation', async () => {
  const state = setup([[call('read_file', { path: 'src/a.ts' })], [call('submit_research', { findings: [], limitations: [] })]]);
  state.options.invoke = vi.fn(async () => ({ callId: 'read_file', name: 'read_file', status: 'error' as const, content: 'File unavailable.' }));
  expect(await state.run()).toMatchObject({ state: 'completed', findings: [], limitations: expect.arrayContaining([expect.stringContaining('File unavailable.')]) });
  const continuation = vi.mocked(state.options.stream).mock.calls[1][1];
  expect(JSON.parse(continuation.messages[3].content!)).toEqual({ status: 'error', content: 'File unavailable.' });
});

it('bounds tool results visibly and refuses oversized continuation context', async () => {
  const state = setup([[call('read_file', { path: 'src/a.ts' })], [call('submit_research', { findings: [], limitations: [] })]]);
  state.options.invoke = vi.fn(async () => ({ callId: 'read_file', name: 'read_file', status: 'success' as const, content: 'x'.repeat(20000) }));
  expect(await state.run()).toMatchObject({ state: 'completed', limitations: expect.arrayContaining([expect.stringContaining('truncated')]) });
  expect(vi.mocked(state.options.stream).mock.calls[1][1].messages[3].content).toContain('truncated');
  const oversized = setup([[{ kind: 'responseContext', value: { source: 'remote', model: 'model', items: [{ value: 'x'.repeat(65000) }] } }]]);
  expect(await oversized.run()).toMatchObject({ state: 'limited' });
  expect(oversized.options.cancel).toHaveBeenCalledOnce();
});

it('cancels a pending stream and a pending approval without waiting for either', async () => {
  const streamState = setup([]);
  streamState.options.stream = vi.fn(async function* () { await new Promise(() => {}); });
  const pending = streamState.run();
  streamState.controller.abort();
  expect(await pending).toMatchObject({ state: 'cancelled' });
  expect(streamState.options.cancel).toHaveBeenCalledWith('child:turn:1');
  const toolState = setup([[call('read_file', { path: 'src/a.ts' })]]);
  let entered!: () => void;
  const invoked = new Promise<void>(resolve => { entered = resolve; });
  toolState.options.invoke = vi.fn(() => { entered(); return new Promise<never>(() => {}); });
  const waiting = toolState.run();
  await invoked;
  toolState.controller.abort();
  expect(await waiting).toMatchObject({ state: 'cancelled' });
});

it('enforces per-child turns, calls and output reserves', async () => {
  const state = setup([[call('read_file', { path: 'src/a.ts' })]]);
  state.options.limits.maxTurns = 1;
  state.options.limits.maxOutputTokens = 17;
  expect(await state.run()).toMatchObject({ state: 'limited' });
  expect(state.reserveOutput).toHaveBeenCalledWith(17);
  const budget = setup([[call('submit_research', { findings: [], limitations: [] })]]);
  budget.reserveOutput.mockReturnValue(0);
  expect(await budget.run()).toMatchObject({ state: 'limited' });
  expect(budget.options.stream).not.toHaveBeenCalled();
});

it('rejects per-turn and cumulative call overflow before invoking excess calls', async () => {
  const many = setup([Array.from({ length: 33 }, (_, index) => call('read_file', { path: 'src/a.ts' }, `call-${index}`))]);
  expect(await many.run()).toMatchObject({ state: 'limited' });
  expect(many.options.invoke).not.toHaveBeenCalled();
  const cumulative = setup([Array.from({ length: 32 }, (_, index) => call('read_file', { path: 'src/a.ts' }, `call-${index}`)), [call('submit_research', { findings: [], limitations: [] })]]);
  expect(await cumulative.run()).toMatchObject({ state: 'limited' });
  expect(cumulative.options.reserve).toHaveBeenCalledOnce();
  const shared = setup([[call('read_file', { path: 'src/a.ts' })]]);
  shared.options.reserve = () => { throw new Error('Shared tool quota exhausted.'); };
  expect(await shared.run()).toMatchObject({ state: 'limited' });
  expect(shared.options.invoke).not.toHaveBeenCalled();
});

it('rejects stale evidence and cancels a pending final verification', async () => {
  const stale = setup([[call('submit_research', { findings: [], limitations: [] })]]);
  stale.options.verify = vi.fn(async () => { throw new Error('Research source changed.'); });
  expect(await stale.run()).toMatchObject({ state: 'failed', findings: [] });
  const waiting = setup([[call('submit_research', { findings: [], limitations: [] })]]);
  let entered!: () => void;
  const verifying = new Promise<void>(resolve => { entered = resolve; });
  waiting.options.verify = () => { entered(); return new Promise<never>(() => {}); };
  const pending = waiting.run();
  await verifying;
  waiting.controller.abort();
  expect(await pending).toMatchObject({ state: 'cancelled', findings: [] });
});
