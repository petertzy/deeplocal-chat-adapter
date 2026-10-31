import { expect, it } from 'vitest';
import { TaskEvidence } from '../../src/task-evidence';
import { subagentLimits } from '../../src/config';
import { DEFAULT_SUBAGENT_LIMITS, SubagentBatchResult } from '../../src/subagent-types';
import type { ToolCall } from '../../src/protocol';

const call = (id: string): ToolCall => ({ id, type: 'function', function: { name: 'delegate_research', arguments: '{}' } });

it('namespaces child IDs while preserving the shared task call ceiling', () => {
  const evidence = new TaskEvidence();
  evidence.reserve([call('same')]);
  evidence.reserve([call('same')], 'child-1');
  evidence.reserve([call('same')], 'child-2');
  expect(() => evidence.reserve([call('same')], 'child-1')).toThrow('Duplicate');
  for (let index = 0; index < 125; index++) evidence.reserve([call(String(index))], 'other');
  expect(() => evidence.reserve([call('excess')], 'another-child')).toThrow('limit');
});

it('reserves a whole call group atomically when a duplicate is rejected', () => {
  const evidence = new TaskEvidence();
  expect(() => evidence.reserve([call('one'), call('one')], 'child')).toThrow('Duplicate');
  expect(() => evidence.reserve([call('one')], 'child')).not.toThrow();
});

it('retains host-attributed research without turning findings into verified checks', () => {
  const evidence = new TaskEvidence();
  const research: SubagentBatchResult = { id: 'batch', state: 'partial', results: [{
    id: 'child', title: 'Inspect tests', state: 'completed', durationMs: 5, testsRun: false,
    findings: [{ text: 'A test exists.', evidence: [{ observationId: 'obs-1', tool: 'read_file', path: 'test.ts', quote: 'it(' }] }],
    limitations: ['Another child failed.'],
  }] };
  evidence.record(call('delegate'), { callId: 'delegate', name: 'delegate_research', content: JSON.stringify(research), status: 'error', research });
  research.results[0].title = 'changed caller data';
  const report = evidence.report(JSON.stringify({ checks: [], nextSteps: '' }));
  expect(report.verification).toBe('unverified');
  expect(report.checks).toEqual([]);
  expect(report.research?.[0].results[0]).toMatchObject({ title: 'Inspect tests', testsRun: false });
  report.research![0].results[0].title = 'changed report';
  expect(evidence.report().research?.[0].results[0].title).toBe('Inspect tests');
});

it('defaults research to disabled and normalizes every resource setting', () => {
  expect(subagentLimits((_key, fallback) => fallback)).toEqual(DEFAULT_SUBAGENT_LIMITS);
  const values: Record<string, unknown> = { enabled: true, maxConcurrent: 999, maxTasks: 0,
    maxTurns: 2.9, timeoutMs: NaN, batchTimeoutMs: -2, maxOutputTokens: 'bad', totalOutputTokens: Infinity };
  expect(subagentLimits(key => values[key])).toEqual({ ...DEFAULT_SUBAGENT_LIMITS,
    enabled: true, maxConcurrent: 4, maxTasks: 1, maxTurns: 2, batchTimeoutMs: 1000 });
  expect(subagentLimits(() => 'true').enabled).toBe(false);
});
