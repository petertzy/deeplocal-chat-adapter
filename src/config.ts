import { DEFAULT_SUBAGENT_LIMITS, SubagentLimits } from './subagent-types';

export interface DeepLocalConfig {
  backend: 'local' | 'remote';
  apiMode?: 'chat-completions' | 'responses';
  reasoningSummary?: 'off' | 'auto';
  baseUrl: string;
  apiKey: string;
  model: string;
  requestTimeout: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  enableToolCalling: boolean;
  injectSystemPrompt: boolean;
  agentMaxTurns: number;
  agentMaxRepairIterations?: number;
  subagents?: SubagentLimits;
  approvalMode?: ApprovalMode;
  logLevel: 'debug' | 'info' | 'warning' | 'error' | 'off';
}

export type ApprovalMode = 'every' | 'safe' | 'full' | 'ask';

export function getConfig(remoteApiKey = ''): DeepLocalConfig {
  // Keep VS Code access behind a runtime require so pure client tests do not
  // need to load the VS Code module.
  const vscode = require('vscode') as typeof import('vscode');
  const config = vscode.workspace.getConfiguration('deeplocal');

  const backend = config.get<'local' | 'remote'>('backend', 'local');
  return {
    backend,
    apiMode: config.get<'chat-completions' | 'responses'>(backend === 'remote' ? 'remote.apiMode' : 'apiMode', 'chat-completions'),
    reasoningSummary: config.get<'off' | 'auto'>('reasoningSummary', 'auto'),
    baseUrl: normalizeBaseUrl(config.get<string>(backend === 'remote' ? 'remote.baseUrl' : 'baseUrl', backend === 'remote' ? 'https://api.openai.com/v1' : 'http://127.0.0.1:14567/v1')),
    apiKey: backend === 'remote' ? remoteApiKey : config.get<string>('apiKey', ''),
    model: config.get<string>('remote.model', ''),
    requestTimeout: config.get<number>('requestTimeout', 120000),
    maxInputTokens: config.get<number>('maxInputTokens', 131072),
    maxOutputTokens: config.get<number>('maxOutputTokens', 16384),
    enableToolCalling: config.get<boolean>('enableToolCalling', true),
    injectSystemPrompt: config.get<boolean>('injectSystemPrompt', true),
    // A high guard prevents runaway tool loops while keeping normal tasks
    // effectively unbounded from a user's perspective.
    agentMaxTurns: Math.max(1, Math.min(1000, config.get<number>('agentMaxTurns', 100))),
    agentMaxRepairIterations: normalizeRepairIterations(config.get<unknown>('agentMaxRepairIterations', 3)),
    subagents: subagentLimits((key, fallback) => config.get<unknown>(`subagents.${key}`, fallback)),
    approvalMode: config.get<ApprovalMode>('approvalMode', 'safe'),
    logLevel: config.get<DeepLocalConfig['logLevel']>('logLevel', 'info'),
  };
}

export function subagentLimits(read: (key: string, fallback: unknown) => unknown): SubagentLimits {
  const integer = (key: keyof SubagentLimits, minimum: number, maximum: number): number => {
    const value = read(key, DEFAULT_SUBAGENT_LIMITS[key]);
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(minimum, Math.min(maximum, Math.floor(value)))
      : DEFAULT_SUBAGENT_LIMITS[key] as number;
  };
  return {
    enabled: read('enabled', false) === true,
    maxConcurrent: integer('maxConcurrent', 1, 4),
    maxTasks: integer('maxTasks', 1, 16),
    maxTurns: integer('maxTurns', 1, 20),
    timeoutMs: integer('timeoutMs', 1000, 600000),
    batchTimeoutMs: integer('batchTimeoutMs', 1000, 900000),
    maxOutputTokens: integer('maxOutputTokens', 128, 32768),
    totalOutputTokens: integer('totalOutputTokens', 128, 131072),
  };
}

function normalizeRepairIterations(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(0, Math.min(20, Math.floor(value)))
    : 3;
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim() || 'http://127.0.0.1:14567/v1';
  return trimmed.replace(/\/+$/, '');
}
