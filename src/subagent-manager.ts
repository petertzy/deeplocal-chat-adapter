import { randomUUID } from 'crypto';
import type { ChatTool } from './protocol';
import { RESEARCH_TOOLS, type SubagentBatchResult, type SubagentManagerOptions, type SubagentResult, type SubagentTask } from './subagent-types';
import { ResearchLimitError, runSubagent } from './subagent-runner';

export function delegationTool(): ChatTool {
  return { type: 'function', function: { name: 'delegate_research', description: 'Delegate bounded, isolated read-only research. Workers cannot edit files or run tests; cite returned evidence and limitations.', parameters: {
    type: 'object', additionalProperties: false, required: ['tasks'], properties: { tasks: { type: 'array', minItems: 1, maxItems: 16, items: {
      type: 'object', additionalProperties: false, required: ['title', 'objective', 'context', 'paths', 'tools'], properties: {
        title: { type: 'string', minLength: 1, maxLength: 100 }, objective: { type: 'string', minLength: 1, maxLength: 2000 },
        context: { type: 'string', maxLength: 12000 }, paths: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string' } },
        tools: { type: 'array', minItems: 1, uniqueItems: true, items: { type: 'string', enum: [...RESEARCH_TOOLS] } },
      },
    } } },
  } } };
}

function validate(raw: string): SubagentTask[] {
  if (Buffer.byteLength(raw, 'utf8') > 100000) throw new Error('Delegation arguments are too large.');
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error('Invalid delegation JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'tasks')) throw new Error('Expected only tasks.');
  const tasks = (value as { tasks?: unknown }).tasks;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('Expected nonempty research tasks.');
  return tasks.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['title', 'objective', 'context', 'paths', 'tools'].includes(key))) throw new Error('Invalid research task properties.');
    const task = item as SubagentTask;
    if (typeof task.title !== 'string' || !task.title.trim() || task.title.length > 100
      || typeof task.objective !== 'string' || !task.objective.trim() || task.objective.length > 2000
      || typeof task.context !== 'string' || Buffer.byteLength(task.context, 'utf8') > 12000
      || !Array.isArray(task.paths) || task.paths.length < 1 || task.paths.length > 20
      || !Array.isArray(task.tools) || !task.tools.length || task.tools.some(tool => !RESEARCH_TOOLS.includes(tool))
      || new Set(task.tools).size !== task.tools.length) throw new Error('Invalid research task bounds.');
    const paths = task.paths.map(path => {
      if (typeof path !== 'string' || !path || path.length > 2000 || path.includes('\0') || /[:*?{}[\]]/.test(path)) throw new Error('Invalid research path.');
      const normalized = path.replace(/\\/g, '/').replace(/\/$/, '');
      if (!normalized || normalized.startsWith('/') || normalized.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Research paths must be normalized relative paths.');
      return normalized;
    });
    return { title: task.title, objective: task.objective, context: task.context, paths, tools: [...task.tools] };
  });
}

export class SubagentManager {
  private usedTasks = 0;
  private outputRemaining: number;
  private stopped = false;
  private readonly controllers = new Set<AbortController>();
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private readonly parentAbort: () => void;

  constructor(private readonly options: SubagentManagerOptions) {
    if (Object.entries(options.limits).some(([key, value]) => key !== 'enabled' && (!Number.isInteger(value) || Number(value) < 1))
      || !Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < 1) throw new Error('Invalid research limits.');
    this.outputRemaining = options.limits.totalOutputTokens;
    this.parentAbort = () => this.stop();
    options.signal.addEventListener('abort', this.parentAbort, { once: true });
    if (options.signal.aborted) this.stop();
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.options.signal.removeEventListener('abort', this.parentAbort);
    for (const controller of this.controllers) controller.abort(new Error('Research cancelled by parent.'));
    for (const launch of this.queue.splice(0)) launch();
  }

  async run(rawArguments: string): Promise<SubagentBatchResult> {
    const { options } = this;
    if (!options.limits.enabled) throw new Error('Parallel research is disabled.');
    const tasks = validate(rawArguments);
    if (tasks.length > options.limits.maxTasks - this.usedTasks) throw new Error('Research task quota exceeded.');
    this.usedTasks += tasks.length;
    const batchId = `${options.requestId}:batch:${randomUUID()}`;
    const batchController = new AbortController();
    this.controllers.add(batchController);
    if (this.stopped) batchController.abort(new Error('Research cancelled by parent.'));
    const deadline = setTimeout(() => batchController.abort(new ResearchLimitError('Research batch deadline reached.')), options.limits.batchTimeoutMs);
    try {
      const pending = tasks.map((task, index) => new Promise<SubagentResult>(resolve => {
        const id = `${batchId}:child:${index + 1}`;
        const queuedAt = Date.now();
        const controller = new AbortController();
        this.controllers.add(controller);
        const abort = () => controller.abort(batchController.signal.reason);
        batchController.signal.addEventListener('abort', abort, { once: true });
        if (batchController.signal.aborted) abort();
        const emit = (state: 'queued' | 'running' | SubagentResult['state'], result?: SubagentResult) => {
          if (!this.stopped || result) options.onActivity({ id, parentRequestId: options.requestId, title: task.title, state, ...(result ? { result } : {}) });
        };
        let launched = false;
        let settled = false;
        const finish = (result: SubagentResult) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', cancelledQueued);
          batchController.signal.removeEventListener('abort', abort);
          this.controllers.delete(controller);
          emit(result.state, result);
          resolve(result);
        };
        const cancelledQueued = () => {
          if (!launched) {
            const position = this.queue.indexOf(launch);
            if (position >= 0) this.queue.splice(position, 1);
            finish({ id, title: task.title, state: controller.signal.reason instanceof ResearchLimitError ? 'limited' : 'cancelled', findings: [], limitations: [String(controller.signal.reason instanceof Error ? controller.signal.reason.message : 'Research cancelled.')], durationMs: Date.now() - queuedAt, testsRun: false });
          }
        };
        const launch = () => {
          if (settled) return;
          if (controller.signal.aborted) { cancelledQueued(); return; }
          launched = true;
          this.active++;
          emit('running');
          const childDeadline = setTimeout(() => controller.abort(new ResearchLimitError('Research child deadline reached.')), options.limits.timeoutMs);
          void runSubagent({ id, task, signal: controller.signal, options, reserveOutput: requested => {
            const reserved = Math.max(0, Math.min(requested, this.outputRemaining));
            this.outputRemaining -= reserved;
            return reserved;
          } }).then(finish).finally(() => {
            clearTimeout(childDeadline);
            this.active--;
            this.drain();
          });
        };
        emit('queued');
        controller.signal.addEventListener('abort', cancelledQueued, { once: true });
        if (controller.signal.aborted) cancelledQueued();
        else this.queue.push(launch);
      }));
      this.drain();
      const results = await Promise.all(pending);
      const completed = results.filter(result => result.state === 'completed').length;
      return { id: batchId, state: this.stopped ? 'cancelled' : completed === results.length ? 'completed' : completed ? 'partial' : 'failed', results };
    } finally {
      clearTimeout(deadline);
      this.controllers.delete(batchController);
    }
  }

  private drain(): void {
    while (this.active < this.options.limits.maxConcurrent && this.queue.length) this.queue.shift()!();
  }
}
