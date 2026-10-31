import type { ChatCompletionRequest, StreamEvent, ToolCall } from './protocol';
import type { AgentToolResult } from './agent-tools';

export const RESEARCH_TOOLS = ['read_file', 'search_workspace', 'list_workspace_files', 'get_diagnostics'] as const;
export type ResearchToolName = typeof RESEARCH_TOOLS[number];

export interface ResearchPolicy {
  tools: readonly ResearchToolName[];
  paths: readonly string[];
}

export interface SubagentTask {
  title: string;
  objective: string;
  context: string;
  paths: string[];
  tools: ResearchToolName[];
}

export interface SubagentLimits {
  enabled: boolean;
  maxConcurrent: number;
  maxTasks: number;
  maxTurns: number;
  timeoutMs: number;
  batchTimeoutMs: number;
  maxOutputTokens: number;
  totalOutputTokens: number;
}

export const DEFAULT_SUBAGENT_LIMITS: SubagentLimits = {
  enabled: false, maxConcurrent: 2, maxTasks: 6, maxTurns: 8,
  timeoutMs: 120000, batchTimeoutMs: 300000,
  maxOutputTokens: 8192, totalOutputTokens: 32768,
};

export type SubagentState = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'limited';
export interface ResearchEvidence {
  observationId: string;
  tool: ResearchToolName;
  path?: string;
  quote: string;
}
export interface ResearchFinding {
  text: string;
  evidence: ResearchEvidence[];
}
export interface SubagentResult {
  id: string;
  title: string;
  state: Exclude<SubagentState, 'queued' | 'running'>;
  findings: ResearchFinding[];
  limitations: string[];
  durationMs: number;
  testsRun: false;
}
export interface SubagentActivity {
  id: string;
  parentRequestId: string;
  title: string;
  state: SubagentState;
  result?: SubagentResult;
}
export interface SubagentBatchResult {
  id: string;
  state: 'completed' | 'partial' | 'failed' | 'cancelled';
  results: SubagentResult[];
}

export interface SubagentManagerOptions {
  requestId: string;
  model: string;
  signal: AbortSignal;
  limits: SubagentLimits;
  maxOutputTokens: number;
  stream: (id: string, request: ChatCompletionRequest) => AsyncIterable<StreamEvent>;
  cancel: (id: string) => void;
  invoke: (task: SubagentTask, call: ToolCall, signal: AbortSignal) => Promise<AgentToolResult>;
  verify?: (task: SubagentTask, signal: AbortSignal) => Promise<void>;
  reserve: (calls: ToolCall[], agentId: string) => void;
  onActivity: (activity: SubagentActivity) => void;
}
