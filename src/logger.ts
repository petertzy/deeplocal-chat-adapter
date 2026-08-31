import * as vscode from 'vscode';
import { getConfig } from './config';

type Level = 'debug' | 'info' | 'warning' | 'error';

const levels: Record<Level | 'off', number> = {
  debug: 10,
  info: 20,
  warning: 30,
  error: 40,
  off: 99,
};

export class Logger {
  constructor(private readonly output: vscode.OutputChannel) {}

  debug(message: string): void {
    this.write('debug', message);
  }

  info(message: string): void {
    this.write('info', message);
  }

  warning(message: string): void {
    this.write('warning', message);
  }

  error(message: string): void {
    this.write('error', message);
  }

  private write(level: Level, message: string): void {
    if (levels[level] < levels[getConfig().logLevel]) {
      return;
    }

    this.output.appendLine(`[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}`);
  }
}
