import * as vscode from 'vscode';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { ChatMessage, ChatTool } from './protocol';

const execFileAsync = promisify(execFile);

export interface AgentToolResult {
  callId: string;
  name: string;
  content: string;
}

export function getAgentTools(): ChatTool[] {
  return [
    {
      type: 'function',
      function: {
        name: 'get_workspace_summary',
        description: 'Summarize the current workspace: root path, folders, package scripts, and common project files.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_active_file',
        description: 'Get the path, language, and selected text summary for the active editor file.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_selection',
        description: 'Read the currently selected text in the active editor.',
        parameters: { type: 'object', properties: { maxChars: { type: 'number' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'get_diagnostics',
        description: 'Read VS Code diagnostics for the workspace or a specific file.',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string' },
            maxResults: { type: 'number' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'open_file',
        description: 'Open a workspace file in the editor.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: { path: { type: 'string' } },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'list_workspace_files',
        description: 'List files in the current VS Code workspace.',
        parameters: {
          type: 'object',
          properties: {
            pattern: { type: 'string', description: 'Optional glob pattern, for example **/*.ts.' },
            maxResults: { type: 'number', description: 'Maximum number of files to return.' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: 'Read a UTF-8 text file from the current workspace.',
        parameters: {
          type: 'object',
          required: ['path'],
          properties: {
            path: { type: 'string' },
            maxChars: { type: 'number' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'search_workspace',
        description: 'Search text in workspace files.',
        parameters: {
          type: 'object',
          required: ['query'],
          properties: {
            query: { type: 'string' },
            maxResults: { type: 'number' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Create or replace a workspace text file. The user will be asked before changes are applied.',
        parameters: {
          type: 'object',
          required: ['path', 'content'],
          properties: {
            path: { type: 'string' },
            content: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'replace_in_file',
        description: 'Replace an exact text fragment in a workspace file. The user will be asked before changes are applied.',
        parameters: {
          type: 'object',
          required: ['path', 'oldText', 'newText'],
          properties: {
            path: { type: 'string' },
            oldText: { type: 'string' },
            newText: { type: 'string' },
          },
        },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a command in the workspace. Use mainly for tests, builds, and diagnostics. The user will be asked first.',
        parameters: {
          type: 'object',
          required: ['command', 'args'],
          properties: {
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
          },
        },
      },
    },
  ];
}

export async function invokeAgentTool(callId: string, name: string, rawArguments: string): Promise<AgentToolResult> {
  const args = parseArgs(rawArguments);

  try {
    switch (name) {
      case 'get_workspace_summary':
        return result(callId, name, await getWorkspaceSummary());
      case 'get_active_file':
        return result(callId, name, getActiveFile());
      case 'get_selection':
        return result(callId, name, getSelection(args));
      case 'get_diagnostics':
        return result(callId, name, getDiagnostics(args));
      case 'open_file':
        return result(callId, name, await openFile(args));
      case 'list_workspace_files':
        return result(callId, name, await listWorkspaceFiles(args));
      case 'read_file':
        return result(callId, name, await readFile(args));
      case 'search_workspace':
        return result(callId, name, await searchWorkspace(args));
      case 'write_file':
        return result(callId, name, await writeFile(args));
      case 'replace_in_file':
        return result(callId, name, await replaceInFile(args));
      case 'run_command':
        return result(callId, name, await runCommand(args));
      default:
        return result(callId, name, `Unknown tool: ${name}`);
    }
  } catch (error) {
    return result(callId, name, `Tool error: ${messageOf(error)}`);
  }
}

async function getWorkspaceSummary(): Promise<string> {
  const folder = workspaceFolder();
  const files = await vscode.workspace.findFiles('{package.json,tsconfig.json,pyproject.toml,requirements.txt,Cargo.toml,go.mod,README.md}', '**/{node_modules,.git,dist,out}/**', 20);
  const lines = [
    `Workspace: ${folder.name}`,
    `Root: ${folder.uri.fsPath}`,
    '',
    'Project files:',
    ...(files.length ? files.map((file) => `- ${vscode.workspace.asRelativePath(file)}`) : ['- none found']),
  ];

  const packageJson = files.find((file) => vscode.workspace.asRelativePath(file) === 'package.json');
  if (packageJson) {
    try {
      const raw = new TextDecoder().decode(await vscode.workspace.fs.readFile(packageJson));
      const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
      const scripts = Object.keys(parsed.scripts ?? {});
      lines.push('', 'npm scripts:', ...(scripts.length ? scripts.map((script) => `- ${script}`) : ['- none']));
    } catch {
      lines.push('', 'npm scripts: unable to parse package.json');
    }
  }

  return lines.join('\n');
}

function getActiveFile(): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return 'No active editor.';
  }
  const relative = vscode.workspace.asRelativePath(editor.document.uri);
  const selection = editor.selection.isEmpty
    ? 'No selection.'
    : `Selection lines ${editor.selection.start.line + 1}-${editor.selection.end.line + 1}.`;
  return [
    `Path: ${relative}`,
    `Language: ${editor.document.languageId}`,
    `Dirty: ${editor.document.isDirty}`,
    selection,
  ].join('\n');
}

function getSelection(args: Record<string, unknown>): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return 'No active editor.';
  }
  if (editor.selection.isEmpty) {
    return 'No selected text.';
  }
  return truncate(editor.document.getText(editor.selection), positiveNumber(args.maxChars, 20000));
}

function getDiagnostics(args: Record<string, unknown>): string {
  const maxResults = positiveNumber(args.maxResults, 80);
  const target = typeof args.path === 'string' && args.path.trim()
    ? resolveWorkspacePath(args.path)
    : undefined;
  const entries = target
    ? [[target, vscode.languages.getDiagnostics(target)] as const]
    : vscode.languages.getDiagnostics();
  const lines: string[] = [];

  for (const [uri, diagnostics] of entries) {
    for (const diagnostic of diagnostics) {
      if (lines.length >= maxResults) {
        break;
      }
      const severity = vscode.DiagnosticSeverity[diagnostic.severity];
      lines.push(`${vscode.workspace.asRelativePath(uri)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${severity}: ${diagnostic.message}`);
    }
  }

  return lines.join('\n') || '(no diagnostics)';
}

async function openFile(args: Record<string, unknown>): Promise<string> {
  const uri = resolveWorkspacePath(args.path);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return `Opened ${vscode.workspace.asRelativePath(uri)}.`;
}

export function toolResultsToMessages(toolCalls: AgentToolResult[]): ChatMessage[] {
  return toolCalls.map((tool) => ({
    role: 'tool',
    tool_call_id: tool.callId,
    content: tool.content,
  }));
}

function workspaceFolder(): vscode.WorkspaceFolder {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    throw new Error('No workspace folder is open.');
  }
  return folder;
}

function resolveWorkspacePath(input: unknown): vscode.Uri {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A workspace-relative path is required.');
  }

  const folder = workspaceFolder();
  const relative = input.replace(/^\/+/, '');
  const uri = vscode.Uri.joinPath(folder.uri, relative);
  const root = folder.uri.fsPath;
  const resolved = uri.fsPath;

  if (path.relative(root, resolved).startsWith('..')) {
    throw new Error('Path escapes the workspace.');
  }

  return uri;
}

async function listWorkspaceFiles(args: Record<string, unknown>): Promise<string> {
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern : '**/*';
  const maxResults = positiveNumber(args.maxResults, 200);
  const files = await vscode.workspace.findFiles(pattern, '**/{node_modules,.git,dist,out}/**', maxResults);
  return files.map((file) => vscode.workspace.asRelativePath(file)).join('\n') || '(no files)';
}

async function readFile(args: Record<string, unknown>): Promise<string> {
  const uri = resolveWorkspacePath(args.path);
  const bytes = await vscode.workspace.fs.readFile(uri);
  const text = new TextDecoder().decode(bytes);
  return truncate(text, positiveNumber(args.maxChars, 30000));
}

async function searchWorkspace(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new Error('query is required.');
  }

  const maxResults = positiveNumber(args.maxResults, 80);
  const files = await vscode.workspace.findFiles('**/*', '**/{node_modules,.git,dist,out}/**', 500);
  const hits: string[] = [];

  for (const file of files) {
    if (hits.length >= maxResults) {
      break;
    }

    let text = '';
    try {
      text = new TextDecoder().decode(await vscode.workspace.fs.readFile(file));
    } catch {
      continue;
    }

    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && hits.length < maxResults; index += 1) {
      if (lines[index].includes(query)) {
        hits.push(`${vscode.workspace.asRelativePath(file)}:${index + 1}: ${lines[index].trim()}`);
      }
    }
  }

  return hits.join('\n') || '(no matches)';
}

async function writeFile(args: Record<string, unknown>): Promise<string> {
  const uri = resolveWorkspacePath(args.path);
  const content = String(args.content ?? '');
  const ok = await confirm(`Apply DeepLocal write to ${vscode.workspace.asRelativePath(uri)}?`);
  if (!ok) {
    return 'User declined file write.';
  }

  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content));
  const document = await vscode.workspace.openTextDocument(uri);
  await document.save();
  return `Wrote ${content.length} characters to ${vscode.workspace.asRelativePath(uri)}.`;
}

async function replaceInFile(args: Record<string, unknown>): Promise<string> {
  const uri = resolveWorkspacePath(args.path);
  const oldText = String(args.oldText ?? '');
  const newText = String(args.newText ?? '');

  if (!oldText) {
    throw new Error('oldText is required.');
  }

  const original = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  if (!original.includes(oldText)) {
    return 'oldText was not found; no changes applied.';
  }

  const ok = await confirm(`Apply DeepLocal replacement in ${vscode.workspace.asRelativePath(uri)}?`);
  if (!ok) {
    return 'User declined file replacement.';
  }

  const updated = original.replace(oldText, newText);
  await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(updated));
  const document = await vscode.workspace.openTextDocument(uri);
  await document.save();
  return `Updated ${vscode.workspace.asRelativePath(uri)}.`;
}

async function runCommand(args: Record<string, unknown>): Promise<string> {
  const command = String(args.command ?? '').trim();
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (!command) {
    throw new Error('command is required.');
  }

  const ok = await confirm(`Run command: ${command} ${commandArgs.join(' ')}?`);
  if (!ok) {
    return 'User declined command execution.';
  }

  const folder = workspaceFolder();
  const { stdout, stderr } = await execFileAsync(command, commandArgs, {
    cwd: folder.uri.fsPath,
    timeout: 120000,
    maxBuffer: 1024 * 1024,
  });
  return truncate([stdout, stderr].filter(Boolean).join('\n'), 30000) || '(command completed with no output)';
}

function result(callId: string, name: string, content: string): AgentToolResult {
  return { callId, name, content };
}

function parseArgs(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n\n... truncated ...` : text;
}

async function confirm(message: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Apply');
  return choice === 'Apply';
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
