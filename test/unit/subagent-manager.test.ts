import { afterEach, expect, it, vi } from 'vitest';
import { SubagentManager, delegationTool } from '../../src/subagent-manager';
import { DEFAULT_SUBAGENT_LIMITS, type SubagentManagerOptions } from '../../src/subagent-types';
import type { StreamEvent } from '../../src/protocol';

const task = { title: 'Research', objective: 'Inspect source', context: '', paths: ['src'], tools: ['read_file'] };
const args = (count = 1) => JSON.stringify({ tasks: Array.from({ length: count }, (_, index) => ({ ...task, title: `Task ${index}` })) });
function setup() {
  const controller = new AbortController();
  const options: SubagentManagerOptions = {
    requestId: 'root', model: 'model', signal: controller.signal, limits: { ...DEFAULT_SUBAGENT_LIMITS, enabled: true }, maxOutputTokens: 2048,
    stream: vi.fn(async function* () { yield { kind: 'toolCall' as const, value: { id: 'submit', type: 'function' as const, function: { name: 'submit_research', arguments: '{"findings":[],"limitations":[]}' } } }; }),
    cancel: vi.fn(), invoke: vi.fn(), reserve: vi.fn(), onActivity: vi.fn(),
  };
  return { controller, options, manager: () => new SubagentManager(options) };
}
afterEach(() => vi.useRealTimers());

it('advertises a strict delegation schema and validates whole batches before launches', async () => {
  expect(delegationTool().function.name).toBe('delegate_research');
  const state = setup();
  const manager = state.manager();
  for (const invalid of [{ ...task, context: '界'.repeat(4001) }, ...['../secret', 'src/*', 'src/?', 'src/{a,b}', 'src/[ab]'].map(path => ({ ...task, paths: [path] })), { ...task, tools: ['run_command'] }, { ...task, extra: true }, { ...task, tools: [] }]) {
    await expect(manager.run(JSON.stringify({ tasks: [task, invalid] }))).rejects.toThrow();
  }
  expect(state.options.stream).not.toHaveBeenCalled();
  expect((await manager.run(args())).state).toBe('completed');
  manager.stop();
});

it('enforces cumulative task quotas across overlapping batches', async () => {
  const state = setup();
  state.options.limits.maxTasks = 2;
  const manager = state.manager();
  const first = manager.run(args());
  const second = manager.run(args());
  await expect(manager.run(args())).rejects.toThrow('quota');
  expect((await first).state).toBe('completed');
  expect((await second).state).toBe('completed');
  manager.stop();
});

it('bounds concurrency globally, preserves order and valid siblings on partial failure', async () => {
  const state = setup();
  const releases: Array<() => void> = [];
  let active = 0;
  let peak = 0;
  state.options.stream = vi.fn(async function* (id: string): AsyncGenerator<StreamEvent> {
    active++;
    peak = Math.max(peak, active);
    await new Promise<void>(resolve => releases.push(resolve));
    active--;
    if (id.includes('child:2')) yield { kind: 'text', value: 'incomplete' };
    else yield { kind: 'toolCall', value: { id: 'submit', type: 'function', function: { name: 'submit_research', arguments: '{"findings":[],"limitations":[]}' } } };
  });
  const manager = state.manager();
  const first = manager.run(args(3));
  const second = manager.run(args());
  expect(releases).toHaveLength(2);
  releases[1]();
  await vi.waitFor(() => expect(releases).toHaveLength(3));
  releases[2]();
  await vi.waitFor(() => expect(releases).toHaveLength(4));
  releases[3]();
  releases[0]();
  expect((await first)).toMatchObject({ state: 'partial', results: [{ title: 'Task 0', state: 'completed' }, { title: 'Task 1', state: 'failed' }, { title: 'Task 2', state: 'completed' }] });
  expect((await second).state).toBe('completed');
  expect(peak).toBe(2);
  manager.stop();
});

it('reserves shared output synchronously across concurrent children and later batches', async () => {
  const state = setup();
  state.options.limits.totalOutputTokens = 3000;
  const manager = state.manager();
  expect((await manager.run(args(3))).results.map(result => result.state)).toEqual(['completed', 'completed', 'limited']);
  expect(vi.mocked(state.options.stream).mock.calls.map(call => call[1].max_tokens)).toEqual([2048, 952]);
  expect((await manager.run(args())).results[0].state).toBe('limited');
  manager.stop();
});

it('cancels active streams and queued tasks promptly and suppresses late activity', async () => {
  const state = setup();
  state.options.limits.maxConcurrent = 1;
  state.options.stream = vi.fn(async function* () { await new Promise(() => {}); });
  const manager = state.manager();
  const pending = manager.run(args(3));
  state.controller.abort();
  expect(await pending).toMatchObject({ state: 'cancelled', results: [{ state: 'cancelled' }, { state: 'cancelled' }, { state: 'cancelled' }] });
  const events = vi.mocked(state.options.onActivity).mock.calls.length;
  expect(state.options.cancel).toHaveBeenCalledOnce();
  await Promise.resolve();
  expect(state.options.onActivity).toHaveBeenCalledTimes(events);
  expect(vi.mocked(state.options.onActivity).mock.calls.filter(call => call[0].state === 'cancelled')).toHaveLength(3);
  expect(state.options.stream).toHaveBeenCalledOnce();
});

it('includes approvals in child deadlines and queued time in batch deadlines, cleaning timers', async () => {
  vi.useFakeTimers();
  const state = setup();
  state.options.limits.maxConcurrent = 1;
  state.options.limits.timeoutMs = 500;
  state.options.limits.batchTimeoutMs = 100;
  state.options.stream = vi.fn(async function* () { await new Promise(() => {}); });
  const manager = state.manager();
  const pending = manager.run(args(2));
  await vi.advanceTimersByTimeAsync(100);
  expect((await pending).results.map(result => result.state)).toEqual(['limited', 'limited']);
  expect(vi.getTimerCount()).toBe(0);
  manager.stop();
});

it('expires a pending tool approval at the child deadline', async () => {
  vi.useFakeTimers();
  const state = setup();
  state.options.limits.timeoutMs = 50;
  state.options.limits.batchTimeoutMs = 500;
  state.options.stream = vi.fn(async function* () {
    yield { kind: 'toolCall' as const, value: { id: 'read', type: 'function' as const, function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' } } };
  });
  state.options.invoke = vi.fn(() => new Promise<never>(() => {}));
  const manager = state.manager();
  const pending = manager.run(args());
  await vi.advanceTimersByTimeAsync(50);
  expect((await pending).results[0]).toMatchObject({ state: 'limited', testsRun: false });
  expect(state.options.invoke).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  manager.stop();
});
