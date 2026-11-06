import type { AgentToolResult } from './agent-tools';
import type { ChatTool, ToolCall } from './protocol';
import { commandSucceeded } from './command-runner';
import { boundedCommandText, redactCommandOutput } from './command-output';
import { parseToolInput } from './tool-input';
import type { DiagnosticObservation } from './edit-validation';
import { createHash } from 'node:crypto';
import type { SubagentBatchResult } from './subagent-types';

export type CheckState = 'passed' | 'failed' | 'incomplete' | 'stale' | 'blocked' | 'skipped' | 'not_run';
export interface RepairCheck {
  key: string;
  command: string;
  args: string[];
  state: CheckState;
  generation: number;
  attemptId?: string;
  fingerprint?: string;
  blocked: boolean;
}
export interface RepairState {
  generation: number;
  mutated: boolean;
  checks: RepairCheck[];
  diagnosticErrors: boolean;
}
interface Declaration { command: string; args: string[]; notRun?: 'blocked' | 'skipped'; reasons: string[] }
interface Attempt {
  id: string;
  tool: string;
  state: CheckState;
  detail: string;
  command?: string;
  exitCode?: number | null;
  signal?: string | null;
  timedOut?: boolean;
  cancelled?: boolean;
  truncated?: boolean;
  outputLimitExceeded?: boolean;
  durationMs?: number;
  saved?: boolean;
  diagnostics?: DiagnosticObservation;
}
export interface CompletionReport {
  research?: SubagentBatchResult[];
  verification: 'checks_passed' | 'failed' | 'unverified' | 'interrupted';
  scope: 'Declared commands only; task completeness is not established.';
  notRecorded: 'A requested build, lint or test absent from the recorded attempts is not_run. Undeclared attempts retain their actual outcomes below.';
  checks: Array<{ command: string; state: CheckState; attempts: string[] }>;
  attempts: Attempt[];
  unverifiedModelText: {
    source: 'model';
    verified: false;
    notice: 'Suggestions and stated reasons are not completion evidence.';
    nextSteps: string;
    checkReasons: Array<{ command: string; text: string }>;
  };
  limitation?: string;
}
const clean = (value: string, budget = 1000) => boundedCommandText(redactCommandOutput(value), budget).text;
const commandKey = (command: string, args: string[]) => JSON.stringify([command.trim(), args]);
const displayCommand = (command: string, args: string[]) => {
  const joined = args.join(' ');
  return clean(JSON.stringify([command, ...(redactCommandOutput(joined) === joined ? args : ['[sensitive arguments redacted]'])]));
};
const mutations = new Set(['create_file', 'write_file', 'replace_in_file', 'delete_file']);
// These digests stay task-local; raw denied arguments are never retained here.
const canonicalInput = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalInput)
  : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalInput(item)])) : value;
const deniedKey = (call: ToolCall): string | undefined => {
  try {
    const input = parseToolInput(call.function.arguments);
    const identity = call.function.name === 'run_command'
      ? [String(input.command ?? '').trim(), Array.isArray(input.args) ? input.args.map(String) : []]
      : canonicalInput(input);
    return createHash('sha256').update(JSON.stringify([call.function.name, identity])).digest('hex');
  } catch { return; }
};

export function completionTool(): ChatTool {
  return { type: 'function', function: {
    name: 'submit_completion',
    description: 'Finish an Agent task with evidence, as the only tool call in the turn. List every requested or declared verification command, including checks not run. The host computes states from actual outcomes; never invent results. No free-form success summary. nextSteps is an actionable suggestion in the user’s conversational language, not a verification claim; use an empty string when none is needed.',
    parameters: { type: 'object', additionalProperties: false, required: ['checks', 'nextSteps'], properties: {
      checks: { type: 'array', maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['command', 'args'], properties: {
        command: { type: 'string', minLength: 1, maxLength: 512 }, args: { type: 'array', maxItems: 128, items: { type: 'string' } },
        callId: { type: 'string', description: 'Optional observed call ID for this exact command, from this task only.' },
        notRun: { type: 'string', enum: ['blocked', 'skipped'] }, reason: { type: 'string', maxLength: 1000 },
      } } }, nextSteps: { type: 'string', maxLength: 2000 },
    } },
  } };
}

/** One send, one pinned workspace. Never reconstructed from model text or old history. */
export class TaskEvidence {
  private readonly observed: Array<{ key?: string; generation: number; fact: Attempt; executed: boolean; blocked: boolean; fingerprint?: string }> = [];
  private readonly known = new Map<string, Declaration>();
  private readonly denied = new Set<string>();
  private declarationOverflow = false;
  private generation = 0;
  private readonly ids = new Set<string>();
  private readonly research: SubagentBatchResult[] = [];

  reserve(calls: ToolCall[], agentId = ''): void {
    if (calls.length > 32 || this.ids.size + calls.length > 128) throw new Error('Task tool-call limit reached; verification is incomplete.');
    const pending = new Set<string>();
    for (const call of calls) {
      const id = JSON.stringify([agentId, call.id]);
      if (!call.id || this.ids.has(id) || pending.has(id)) throw new Error('Duplicate or missing task tool-call ID; verification is incomplete.');
      pending.add(id);
    }
    for (const id of pending) this.ids.add(id);
  }

  record(call: ToolCall, result: AgentToolResult, executed = true): void {
    if (executed && call.function.name === 'delegate_research' && result.research && this.research.length < 16) {
      this.research.push(structuredClone(result.research));
    }
    if (executed && result.status === 'declined') {
      const key = deniedKey(call);
      if (key) this.denied.add(key);
    }
    const mutating = mutations.has(call.function.name);
    // A failed write may have applied unsaved changes. Conservatively invalidate
    // earlier checks even when its tool cannot confirm a successful save.
    if (mutating && executed && result.status !== 'declined') this.generation++;
    const fact: Attempt = { id: call.id, tool: call.function.name,
      state: !executed ? 'not_run' : result.status === 'declined' ? 'blocked' : result.status === 'error' ? 'failed' : 'passed',
      detail: clean(result.content, 700),
    };
    let key: string | undefined;
    let fingerprint: string | undefined;
    let blocked = executed && result.status === 'declined';
    if (call.function.name === 'run_command') {
      // A host failure without structured process evidence did not produce a
      // repairable command diagnostic (for example, workspace/startup failure).
      blocked ||= executed && result.status === 'error' && !result.command;
      try {
        const args = parseToolInput(call.function.arguments);
        const executable = String(args.command ?? '').trim();
        const argv = Array.isArray(args.args) ? args.args.map(String) : [];
        key = commandKey(executable, argv);
        fact.command = displayCommand(executable, argv);
        if (args.verification === true) {
          if (!executable || executable.length > 512 || argv.length > 128 || JSON.stringify(argv).length > 20000
            || (!this.known.has(key) && this.known.size >= 20)) this.declarationOverflow = true;
          else if (!this.known.has(key)) this.known.set(key, { command: executable, args: [...argv], reasons: [] });
        }
      } catch { /* Malformed tool input is still a recorded failed attempt. */ }
      const command = result.command;
      if (command && executed) {
        blocked ||= !!command.error;
        const normalize = (text: string) => redactCommandOutput(text).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trimEnd();
        fingerprint = createHash('sha256').update(JSON.stringify({
          stdout: normalize(command.stdout), stderr: normalize(command.stderr), exitCode: command.exitCode,
          signal: command.signal, error: command.error ? { code: normalize(command.error.code), message: normalize(command.error.message) } : null,
          timedOut: command.timedOut, cancelled: command.cancelled, truncated: command.truncated, outputLimitExceeded: command.outputLimitExceeded,
        })).digest('hex');
        fact.state = command.error || (command.exitCode !== null && command.exitCode !== 0) ? 'failed'
          : !commandSucceeded(command) || command.truncated ? 'incomplete' : result.status === 'success' ? 'passed' : 'incomplete';
        Object.assign(fact, { exitCode: command.exitCode, signal: command.signal, timedOut: command.timedOut,
          cancelled: command.cancelled, truncated: command.truncated, outputLimitExceeded: command.outputLimitExceeded, durationMs: command.durationMs });
        fact.detail = JSON.stringify({ stdout: clean(command.stdout, 700), stderr: clean(command.stderr, 700),
          error: command.error ? { code: clean(command.error.code), message: clean(command.error.message) } : null });
      } else if (fact.state === 'passed') fact.state = 'incomplete';
    }
    if (result.edit) {
      fact.saved = result.edit.saved;
      fact.diagnostics = result.edit.diagnostics ? { ...result.edit.diagnostics } : undefined;
      // Editor diagnostics are observations, never a passed build/test.
      if (fact.state === 'passed') fact.state = 'incomplete';
    }
    this.observed.push({ key, generation: this.generation, fact, executed, blocked, fingerprint });
  }

  commandRetryBlock(call: ToolCall): string | undefined {
    const denied = deniedKey(call);
    if (denied && this.denied.has(denied)) return 'This exact tool action was declined earlier in this task. Do not retry without new user instructions.';
    if (call.function.name !== 'run_command') return;
    let key: string;
    let declared = false;
    try {
      const input = parseToolInput(call.function.arguments);
      key = commandKey(String(input.command ?? '').trim(), Array.isArray(input.args) ? input.args.map(String) : []);
      declared = input.verification === true;
    } catch { return; }
    const attempts = this.observed.filter(attempt => attempt.executed && attempt.key === key);
    if (attempts.some(attempt => attempt.fact.state === 'blocked')) return 'This exact command was declined earlier in this task. Do not retry without new user instructions.';
    const latest = attempts.at(-1);
    if ((this.known.has(key) || declared) && latest?.generation === this.generation
      && ['failed', 'incomplete'].includes(latest.fact.state)) return 'This verification command already failed or produced incomplete evidence in the current workspace generation. Inspect the evidence and make a relevant repair before retrying.';
  }

  repairState(): RepairState {
    const checks = [...this.known].map(([key, check]): RepairCheck => {
      const latest = this.observed.filter(attempt => attempt.executed && attempt.key === key).at(-1);
      return { key, command: check.command, args: [...check.args],
        state: latest ? latest.generation !== this.generation ? 'stale' : latest.fact.state : check.notRun ?? 'not_run',
        generation: latest?.generation ?? this.generation, blocked: latest?.blocked ?? false,
        ...(latest ? { attemptId: latest.fact.id, fingerprint: latest.fingerprint } : {}),
      };
    });
    const diagnostics = this.observed.filter(attempt => attempt.executed && attempt.fact.saved && attempt.fact.diagnostics).at(-1)?.fact.diagnostics;
    return { generation: this.generation, mutated: this.generation > 0, checks,
      // Current successful verification supersedes the earlier best-effort editor
      // snapshot, which may have been captured while the edit was still settling.
      diagnosticErrors: !checks.length || !checks.every(check => check.state === 'passed')
        ? (diagnostics?.newErrors ?? 0) > 0 || (diagnostics?.remainingErrors ?? 0) > 0 : false };
  }

  report(raw?: string, interruption?: string): CompletionReport {
    const input = raw === undefined ? { checks: [], nextSteps: '' } : parseToolInput(raw);
    if (Object.keys(input).some(key => !['checks', 'nextSteps'].includes(key)) || !Array.isArray(input.checks) || input.checks.length > 20
      || typeof input.nextSteps !== 'string' || input.nextSteps.length > 2000) throw new Error('Invalid completion: expected checks and nextSteps.');
    const seen = new Set<string>();
    const declarations = input.checks.map(value => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid completion check.');
      const check = value as Record<string, unknown>;
      if (Object.keys(check).some(key => !['command', 'args', 'callId', 'notRun', 'reason'].includes(key))
        || typeof check.command !== 'string' || !check.command.trim() || check.command.length > 512
        || !Array.isArray(check.args) || check.args.length > 128 || !check.args.every(arg => typeof arg === 'string')
        || JSON.stringify(check.args).length > 20000 || (check.callId !== undefined && typeof check.callId !== 'string')
        || (check.notRun !== undefined && (typeof check.notRun !== 'string' || !['blocked', 'skipped'].includes(check.notRun)))
        || (check.reason !== undefined && (typeof check.reason !== 'string' || check.reason.length > 1000))) throw new Error('Invalid completion check fields.');
      const key = commandKey(check.command, check.args);
      if (seen.has(key)) throw new Error('Duplicate completion check.');
      seen.add(key);
      const attempts = this.observed.filter(attempt => attempt.key === key);
      if (check.callId !== undefined && !attempts.some(attempt => attempt.fact.id === check.callId)) throw new Error('Completion references no matching command in this task.');
      return { key, command: check.command.trim(), args: [...check.args] as string[],
        notRun: check.notRun as 'blocked' | 'skipped' | undefined, reason: check.reason as string | undefined };
    });
    // Validate the complete submission before changing the monotonic declaration set.
    if (new Set([...this.known.keys(), ...declarations.map(check => check.key)]).size > 20) throw new Error('Task verification declaration limit reached; verification is incomplete.');
    for (const check of declarations) {
      const previous = this.known.get(check.key);
      const reasons = [...(previous?.reasons ?? [])];
      if (check.reason && !reasons.includes(clean(check.reason))) reasons.push(clean(check.reason));
      this.known.set(check.key, { command: check.command, args: check.args, notRun: check.notRun ?? previous?.notRun, reasons: reasons.slice(-128) });
    }
    const checkReasons = [...this.known.values()].flatMap(check => check.reasons.map(text => ({ command: displayCommand(check.command, check.args), text })));
    const checks = this.repairState().checks.map(check => ({ command: displayCommand(check.command, check.args), state: check.state,
      attempts: this.observed.filter(attempt => attempt.key === check.key).map(attempt => attempt.fact.id) }));
    const facts = this.observed.map(({ fact }) => ({ ...fact, ...(fact.diagnostics ? { diagnostics: { ...fact.diagnostics } } : {}) }));
    // No declaration can remove/relabel a failed attempt. checks_passed is scoped
    // to the named commands; the full attempt history is always retained below.
    const verification = interruption ? 'interrupted' : checks.some(check => check.state === 'failed') ? 'failed'
      : !this.declarationOverflow && checks.length && checks.every(check => check.state === 'passed') ? 'checks_passed' : 'unverified';
    return { verification, scope: 'Declared commands only; task completeness is not established.',
      ...(this.research.length ? { research: structuredClone(this.research) } : {}),
      notRecorded: 'A requested build, lint or test absent from the recorded attempts is not_run. Undeclared attempts retain their actual outcomes below.', checks, attempts: facts,
      // Model prose is preserved for usefulness, but its provenance/trust label
      // must travel with it through display, copy, history and restoration.
      unverifiedModelText: { source: 'model', verified: false, notice: 'Suggestions and stated reasons are not completion evidence.',
        nextSteps: clean(input.nextSteps, 2200), checkReasons },
      ...(interruption ? { limitation: clean(interruption) } : this.declarationOverflow ? { limitation: 'Task verification declaration limit reached; verification is incomplete.' } : raw === undefined ? { limitation: 'No structured completion was submitted; model success claims were not accepted.' } : {}),
    };
  }
}

export function formatCompletion(report: CompletionReport): string {
  return JSON.stringify(report, null, 2);
}
