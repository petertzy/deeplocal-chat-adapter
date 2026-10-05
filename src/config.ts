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
  logLevel: 'debug' | 'info' | 'warning' | 'error' | 'off';
}

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
    agentMaxTurns: config.get<number>('agentMaxTurns', 8),
    logLevel: config.get<DeepLocalConfig['logLevel']>('logLevel', 'info'),
  };
}

function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim() || 'http://127.0.0.1:14567/v1';
  return trimmed.replace(/\/+$/, '');
}
