import * as vscode from 'vscode';

export interface DeepLocalConfig {
  baseUrl: string;
  apiKey: string;
  requestTimeout: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  enableToolCalling: boolean;
  injectSystemPrompt: boolean;
  agentMaxTurns: number;
  logLevel: 'debug' | 'info' | 'warning' | 'error' | 'off';
}

export function getConfig(): DeepLocalConfig {
  const config = vscode.workspace.getConfiguration('deeplocal');

  return {
    baseUrl: normalizeBaseUrl(config.get<string>('baseUrl', 'http://127.0.0.1:14567/v1')),
    apiKey: config.get<string>('apiKey', ''),
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
