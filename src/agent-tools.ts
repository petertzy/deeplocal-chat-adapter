import * as vscode from 'vscode';
import * as path from 'path';
import { constants as fsConstants, promises as fs, type BigIntStats } from 'fs';
import { fstat, readFile as readDescriptor } from 'node:fs';
import * as koffi from 'koffi';
import { createHash } from 'crypto';
import type { ResearchPolicy, SubagentBatchResult } from './subagent-types';
import { ChatMessage, ChatTool } from './protocol';
import { parseToolInput } from './tool-input';
import { ApprovalMode } from './config';
import { isInWorkspace, requireWorkspaceFolder, workspaceRelativePath } from './agent-workspace';
import { findNewDuplicateImports, isTypeScriptPath } from './import-validation';
import { beginEditValidation, DiagnosticObservation, EditValidation } from './edit-validation';
import { executeCommand, commandSucceeded, CommandResult } from './command-runner';
import { discoverProjectVerification, isUnsafeVerificationScript, type ProjectPackageManifest } from './project-verification';

// Upper bounds for caller-supplied limits; defaults sit below these.
const MAX_TEXT_CHARS = 60000;
const MAX_RESULT_COUNT = 500;

export interface AgentToolResult {
  callId: string;
  name: string;
  content: string;
  status: 'success' | 'error' | 'declined';
  command?: CommandResult;
  edit?: { path: string; saved: true; diagnostics?: DiagnosticObservation };
  research?: SubagentBatchResult;
  /** Host-only fingerprints; never included in tool messages sent to the model. */
  researchSources?: Array<{ path: string; digest: string }>;
  /** Host-only coverage warnings retained independently of model-visible output. */
  researchLimitations?: string[];
}

export interface AgentToolOptions {
  signal?: AbortSignal;
  workspaceFolder?: vscode.WorkspaceFolder;
  approve?: (message: string, preview?: () => Promise<void>) => Promise<boolean>;
  approvalMode?: ApprovalMode;
  researchPolicy?: ResearchPolicy;
}

interface FileChangeOutcome {
  content: string;
  status: 'success' | 'error';
  saved: true;
  edit: NonNullable<AgentToolResult['edit']>;
}

type ResearchSource = NonNullable<AgentToolResult['researchSources']>[number];
interface WorkspaceResearchOutcome {
  content: string;
  status: 'success';
  researchSources?: ResearchSource[];
  researchLimitations?: string[];
  saved?: false;
  edit?: never;
}
type WorkspaceToolOutcome = string | (FileChangeOutcome & { researchSources?: never; researchLimitations?: never }) | WorkspaceResearchOutcome;

export function getAgentTools(policy?: ResearchPolicy): ChatTool[] {
  const tools: ChatTool[] = [
    {
      type: 'function',
      function: {
        name: 'delete_file',
        description: 'Move a single workspace file to the trash ONLY when the user explicitly asks to delete it. Supports a deletion diff. Never deletes directories.',
        parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
      },
    },
    {
      type: 'function',
      function: {
        name: 'create_file',
        description: 'Create a NEW workspace file at the specified path. Never overwrites an existing file. Use this when asked to create a file.',
        parameters: { type: 'object', required: ['path', 'content'], properties: {
          path: { type: 'string' }, content: { type: 'string' },
        } },
      },
    },
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
        description: 'Create or replace a workspace text file. Permission behavior follows the selected approval mode.',
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
        description: 'Replace an exact text fragment in a workspace file. Permission behavior follows the selected approval mode.',
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
        name: 'discover_verification_commands',
        description: 'Inspect project manifests and configuration to discover existing, relevant lint, type-check, build, and test commands. This tool only reports candidates; it never executes them. Respects deeplocal.verificationPreferences and reports missing or unsafe checks.',
        parameters: { type: 'object', properties: {} },
      },
    },
    {
      type: 'function',
      function: {
        name: 'run_command',
        description: 'Run a command in the workspace. Returns JSON with separate stdout/stderr, exitCode or signal, durationMs, error and timeout/cancellation/output-limit/truncation flags, including on failure. Permission behavior follows the selected approval mode.',
        parameters: {
          type: 'object',
          required: ['command', 'args'],
          properties: {
            command: { type: 'string' },
            args: { type: 'array', items: { type: 'string' } },
            verification: { type: 'boolean', description: 'Declare this exact command as a required verification check. Failed checks remain required until verified.' },
          },
        },
      },
    },
  ];
  return policy ? tools.filter(tool => researchToolAllowed(tool.function.name, policy)) : tools;
}

export async function invokeAgentTool(callId: string, name: string, rawArguments: string, options: AgentToolOptions = {}): Promise<AgentToolResult> {
  let outcome: WorkspaceToolOutcome | undefined;
  try {
    if (options.researchPolicy && !researchToolAllowed(name, options.researchPolicy)) {
      throw new Error(`Research policy does not permit tool: ${name}`);
    }
    if (name !== 'run_command') options.signal?.throwIfAborted();
    const args = parseToolInput(rawArguments);
    if (options.approvalMode === 'ask') {
      return result(callId, name, 'Ask-only mode does not permit agent operations. Explain the proposed action instead.', 'declined');
    }
    // Capture once, before any approval or other await.
    const folder = requireWorkspaceFolder(options.workspaceFolder);
    options = { ...options, workspaceFolder: folder };
    // Commands retain their cancellation/partial-output result rather than
    // losing it to the generic post-tool abort check. Validate launch below.
    if (name === 'run_command') return await runCommand(callId, args, options);
    if (options.approvalMode === 'every' && !isActionTool(name)) {
      const approved = await approveIfNeeded(name, args, `Allow tool: ${name}`, options);
      options.signal?.throwIfAborted();
      if (!approved) return result(callId, name, 'User declined tool execution. Do not retry without new instructions.', 'declined');
    }
    requireWorkspaceFolder(folder);
    outcome = await invokeWorkspaceTool(name, args, options, folder);
    options.signal?.throwIfAborted();
    requireWorkspaceFolder(folder);
    return typeof outcome === 'string'
      ? result(callId, name, outcome)
      : { ...result(callId, name, outcome.content, outcome.status), edit: outcome.edit,
        ...(outcome.researchSources ? { researchSources: outcome.researchSources } : {}),
        ...(outcome.researchLimitations ? { researchLimitations: outcome.researchLimitations } : {}) };
  } catch (error) {
    if (outcome && typeof outcome !== 'string' && outcome.saved) {
      return { ...result(callId, name, `${outcome.content}\nTask interrupted after saving: ${messageOf(error)}. The saved change remains; read the file before making further edits.`, 'error'), edit: outcome.edit };
    }
    return result(callId, name, `Tool error: ${messageOf(error)}`, 'error');
  }
}

async function invokeWorkspaceTool(name: string, args: Record<string, unknown>, options: AgentToolOptions, folder: vscode.WorkspaceFolder): Promise<WorkspaceToolOutcome> {
  if (options.researchPolicy) return invokeResearchTool(name, args, options, folder);
  switch (name) {
    case 'get_workspace_summary':
      return await getWorkspaceSummary(folder);
    case 'discover_verification_commands':
      return await getProjectVerificationCommands(folder);
    case 'get_active_file':
      return getActiveFile(folder);
    case 'get_selection':
      return getSelection(args, folder);
    case 'get_diagnostics':
      return getDiagnostics(args, folder);
    case 'open_file':
      return await openFile(args, folder);
    case 'list_workspace_files':
      return await listWorkspaceFiles(args, folder);
    case 'read_file':
      return await readFile(args, folder);
    case 'search_workspace':
      return await searchWorkspace(args, folder);
    case 'write_file':
      return await writeFile(args, options);
    case 'create_file':
      return await writeFile(args, options, true);
    case 'delete_file':
      return await deleteFile(args, options);
    case 'replace_in_file':
      return await replaceInFile(args, options);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function isActionTool(name: string): boolean {
  return ['write_file', 'create_file', 'replace_in_file', 'delete_file', 'run_command'].includes(name);
}

// This check is independent of approval mode and tool advertisement: a model can
// submit arbitrary tool names directly, including names absent from its schema.
function researchToolAllowed(name: string, policy: ResearchPolicy): boolean {
  return ['read_file', 'search_workspace', 'list_workspace_files', 'get_diagnostics'].includes(name)
    && policy.tools.some(tool => tool === name);
}

function researchPath(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.includes('\0')
    || path.isAbsolute(input) || path.win32.isAbsolute(input) || /[:*?{}[\]]/.test(input)) {
    throw new Error('Research requires an explicit workspace-relative path.');
  }
  const parts = input.replace(/\\/g, '/').split('/');
  if (parts.includes('..')) throw new Error('Research paths must not contain traversal.');
  return parts.filter(part => part && part !== '.').join('/');
}

function containedPath(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

interface ResearchPathSnapshot {
  target: string;
  root: string;
  entries: Array<{ path: string; stat: BigIntStats }>;
}

const descriptorRead = (fd: number): Promise<Buffer> => new Promise((resolve, reject) => {
  readDescriptor(fd, (error, bytes) => error ? reject(error) : resolve(bytes));
});
const descriptorStat = (fd: number): Promise<BigIntStats> => new Promise((resolve, reject) => {
  fstat(fd, { bigint: true }, (error, stat) => error ? reject(error) : resolve(stat));
});

/**
 * POSIX lacks a race-free path API in Node. Resolve each segment from an
 * already-open directory descriptor so a rename, link, or junction cannot
 * redirect a later segment lookup outside the trusted workspace directory.
 */
function posixDescriptorApi(): { openat: (parent: number, name: string, flags: number, mode: number) => number; close: (fd: number) => number } {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('Scoped research is unavailable on this platform because safe descriptor-relative reads are not supported.');
  }
  const library = koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6');
  return {
    openat: library.func('int openat(int, const char *, int, int)') as (parent: number, name: string, flags: number, mode: number) => number,
    close: library.func('int close(int)') as (fd: number) => number,
  };
}

async function readPinnedResearchBytes(snapshot: ResearchPathSnapshot, options: AgentToolOptions): Promise<Buffer> {
  const api = posixDescriptorApi();
  const directoryFlags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
  const fileFlags = fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK;
  let current = api.openat(-100, snapshot.root, directoryFlags, 0); // AT_FDCWD
  if (current < 0) throw new Error('Research workspace could not be opened safely.');
  try {
    if (!sameResearchIdentity(snapshot.entries.find(entry => entry.path === snapshot.root)!.stat, await descriptorStat(current))) {
      throw new Error('Research workspace changed before a safe read could begin.');
    }
    const relative = path.relative(snapshot.root, snapshot.target);
    const parts = relative.split(path.sep).filter(Boolean);
    let resolved = snapshot.root;
    for (let index = 0; index < parts.length; index++) {
      options.signal?.throwIfAborted();
      const next = api.openat(current, parts[index], index === parts.length - 1 ? fileFlags : directoryFlags, 0);
      if (next < 0) throw new Error('Research path changed during safe descriptor traversal; no file content was returned.');
      api.close(current);
      current = next;
      resolved = path.join(resolved, parts[index]);
      const expected = snapshot.entries.find(entry => entry.path === resolved);
      if (!expected || !sameResearchIdentity(expected.stat, await descriptorStat(current))) {
        throw new Error('Research path changed during safe descriptor traversal; no file content was returned.');
      }
    }
    const opened = await descriptorStat(current);
    if (!opened.isFile()) throw new Error('Research source is not a regular file.');
    const bytes = await descriptorRead(current);
    options.signal?.throwIfAborted();
    if (!sameResearchFile(opened, await descriptorStat(current))) throw new Error('Research file changed while reading; no file content was returned.');
    return bytes;
  } finally {
    if (current >= 0) api.close(current);
  }
}

class ResearchSnapshotChanged extends Error {}

function sameResearchIdentity(before: BigIntStats, after: BigIntStats): boolean {
  // Numeric Stats lose precision for Windows file IDs. Missing identities fail closed.
  return before.ino > 0n && after.ino > 0n && before.dev === after.dev && before.ino === after.ino
    && before.mode === after.mode && before.birthtimeNs === after.birthtimeNs;
}

function sameResearchFile(before: BigIntStats, after: BigIntStats): boolean {
  return sameResearchIdentity(before, after) && after.isFile() && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

async function verifyResearchPath(snapshot: ResearchPathSnapshot, folder: vscode.WorkspaceFolder, options: AgentToolOptions, capturing = false): Promise<void> {
  let metadataChanged = false;
  for (const entry of snapshot.entries) {
    options.signal?.throwIfAborted();
    const current = await fs.lstat(entry.path, { bigint: true });
    options.signal?.throwIfAborted();
    if (current.isSymbolicLink() || !sameResearchIdentity(entry.stat, current)) {
      throw new Error('Research path changed during access; no file content was returned.');
    }
    // Prevent an ancestor swap from poisoning the initial target identity. Once
    // a descriptor matches that stable identity, later renames cannot redirect it.
    metadataChanged ||= capturing && entry.stat.ctimeNs !== current.ctimeNs;
  }
  if (path.relative(snapshot.root, await fs.realpath(folder.uri.fsPath)) !== ''
    || path.relative(snapshot.target, await fs.realpath(snapshot.target)) !== '') {
    throw new Error('Research path changed during access; no file content was returned.');
  }
  options.signal?.throwIfAborted();
  requireWorkspaceFolder(folder);
  // Classify changes only after checking every identity and canonical path, so
  // a changed ancestor inode can never be mistaken for retryable metadata churn.
  if (metadataChanged) throw new ResearchSnapshotChanged('Research path changed while establishing file identity; no file content was returned.');
}

/** Capture identities from the volume root, including ancestors above the workspace. */
async function requireResearchPath(uri: vscode.Uri, folder: vscode.WorkspaceFolder, options: AgentToolOptions): Promise<ResearchPathSnapshot> {
  options.signal?.throwIfAborted();
  requireWorkspaceFolder(folder);
  if (folder.uri.scheme !== 'file' || uri.scheme !== 'file' || !isInWorkspace(uri, folder)) {
    throw new Error('Research cannot establish local workspace scope for this path.');
  }
  const root = await fs.realpath(folder.uri.fsPath);
  const rootIdentity = await fs.lstat(root, { bigint: true });
  for (let attempt = 0; ; attempt++) {
    try { return await captureResearchPath(uri, folder, options, root, rootIdentity); }
    catch (error) {
      // Shared ancestors can change when unrelated files are created. Recapture
      // at most twice, before any open/read; identity substitutions never retry.
      if (!(error instanceof ResearchSnapshotChanged) || attempt === 2) throw error;
    }
  }
}

async function captureResearchPath(uri: vscode.Uri, folder: vscode.WorkspaceFolder, options: AgentToolOptions, root: string, rootIdentity: BigIntStats): Promise<ResearchPathSnapshot> {
  options.signal?.throwIfAborted();
  requireWorkspaceFolder(folder);
  if (folder.uri.scheme !== 'file' || uri.scheme !== 'file' || !isInWorkspace(uri, folder)) {
    throw new Error('Research cannot establish local workspace scope for this path.');
  }
  const scopes = options.researchPolicy!.paths.map(researchPath);
  if (!scopes.some(scope => containedPath(path.resolve(folder.uri.fsPath, scope), uri.fsPath))) {
    throw new Error('Path is outside the research scope.');
  }
  if (path.relative(root, await fs.realpath(folder.uri.fsPath)) !== '') {
    throw new Error('Research workspace changed while establishing file identity.');
  }
  options.signal?.throwIfAborted();
  const target = path.resolve(root, path.relative(folder.uri.fsPath, uri.fsPath));
  const volume = path.parse(target).root;
  let current = volume;
  const entries: ResearchPathSnapshot['entries'] = [];
  for (const part of ['', ...path.relative(volume, target).split(path.sep).filter(Boolean)]) {
    current = part ? path.join(current, part) : current;
    const stat = await fs.lstat(current, { bigint: true });
    options.signal?.throwIfAborted();
    if (stat.isSymbolicLink()) throw new Error('Research does not permit symbolic links.');
    if (stat.ino <= 0n || stat.ctimeNs <= 0n || (!stat.isDirectory() && current !== target)) throw new Error('Research cannot establish file identity for this path.');
    if (path.relative(root, current) === '' && !sameResearchIdentity(rootIdentity, stat)) {
      throw new Error('Research workspace identity changed while establishing file identity.');
    }
    entries.push({ path: current, stat });
  }
  const actual = await fs.realpath(uri.fsPath);
  options.signal?.throwIfAborted();
  const expected = path.resolve(root, path.relative(folder.uri.fsPath, uri.fsPath));
  if (!containedPath(root, actual) || path.relative(expected, actual) !== '') {
    throw new Error('Path escapes the research workspace or resolves through a symbolic link.');
  }
  const snapshot = { root, target, entries };
  // Bracket the target snapshot with ancestor checks before opening it.
  await verifyResearchPath(snapshot, folder, options, true);
  return snapshot;
}

/** Pin the validated identity before reading through one descriptor, including freshness checks. */
async function readResearchBytes(uri: vscode.Uri, folder: vscode.WorkspaceFolder, options: AgentToolOptions): Promise<Buffer> {
  const snapshot = await requireResearchPath(uri, folder, options);
  const expected = snapshot.entries[snapshot.entries.length - 1].stat;
  if (!expected.isFile()) throw new Error('Research source is not a regular file.');
  options.signal?.throwIfAborted();
  return readPinnedResearchBytes(snapshot, options);
}

async function researchFiles(args: Record<string, unknown>, folder: vscode.WorkspaceFolder, options: AgentToolOptions, limit: number): Promise<{ files: vscode.Uri[]; limited: boolean }> {
  options.signal?.throwIfAborted();
  // Validate the entire policy even when discovery returns no files.
  options.researchPolicy!.paths.forEach(researchPath);
  if (folder.uri.scheme !== 'file') throw new Error('Research requires a local workspace folder.');
  const cancellation = options.signal ? new vscode.CancellationTokenSource() : undefined;
  const cancel = () => cancellation?.cancel();
  options.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern : '**/*';
    const candidates = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), '**/{node_modules,.git,dist,out}/**', limit, cancellation?.token);
    options.signal?.throwIfAborted();
    const files: vscode.Uri[] = [];
    for (const uri of candidates) {
      options.signal?.throwIfAborted();
      try {
        await requireResearchPath(uri, folder, options);
        files.push(uri);
      } catch {
        options.signal?.throwIfAborted();
        // Discovery can include excluded roots, inaccessible files, and links.
      }
    }
    return { files, limited: candidates.length >= limit };
  } finally {
    options.signal?.removeEventListener('abort', cancel);
    cancellation?.dispose();
  }
}

async function invokeResearchTool(name: string, args: Record<string, unknown>, options: AgentToolOptions, folder: vscode.WorkspaceFolder): Promise<WorkspaceToolOutcome> {
  if (name === 'read_file') {
    const relative = researchPath(args.path) || '.';
    const uri = resolveWorkspacePath(relative, folder);
    const bytes = await readResearchBytes(uri, folder, options);
    const content = decodeFileText(bytes, workspaceRelativePath(uri, folder));
    return { content: truncate(content, boundedNumber(args.maxChars, 30000, MAX_TEXT_CHARS)), status: 'success',
      researchSources: [{ path: workspaceRelativePath(uri, folder), digest: researchDigest(bytes) }] };
  }
  const maxResults = boundedNumber(args.maxResults, name === 'list_workspace_files' ? 200 : 80, MAX_RESULT_COUNT);
  if (name === 'list_workspace_files') {
    const { files, limited } = await researchFiles(args, folder, options, maxResults);
    const content = files.map(file => workspaceRelativePath(file, folder)).join('\n')
      || (limited ? '(no files among inspected candidates)' : '(no files)');
    if (!limited) return content;
    const warning = researchDiscoveryWarning(maxResults);
    return { content: `${warning}\n${content}`, status: 'success', researchLimitations: [warning] };
  }
  if (name === 'get_diagnostics') {
    const target = typeof args.path === 'string' && args.path.trim()
      ? resolveWorkspacePath(researchPath(args.path) || '.', folder) : undefined;
    if (target) await requireResearchPath(target, folder, options);
    const entries = target ? [[target, vscode.languages.getDiagnostics(target)] as const] : vscode.languages.getDiagnostics();
    const lines: string[] = [];
    for (const [uri, diagnostics] of entries) {
      options.signal?.throwIfAborted();
      if (lines.length >= maxResults) break;
      try { await requireResearchPath(uri, folder, options); } catch {
        options.signal?.throwIfAborted();
        continue;
      }
      for (const diagnostic of diagnostics) {
        options.signal?.throwIfAborted();
        if (lines.length >= maxResults) break;
        lines.push(`${workspaceRelativePath(uri, folder)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${vscode.DiagnosticSeverity[diagnostic.severity]}: ${diagnostic.message}`);
      }
    }
    return lines.join('\n') || '(no diagnostics)';
  }
  const query = String(args.query ?? '').trim();
  if (!query) throw new Error('query is required.');
  const { files, limited } = await researchFiles({}, folder, options, 500);
  const hits: string[] = [];
  const sources: ResearchSource[] = [];
  let skipped = 0;
  for (const file of files) {
    options.signal?.throwIfAborted();
    if (hits.length >= maxResults) break;
    let text: string;
    try {
      const bytes = await readResearchBytes(file, folder, options);
      options.signal?.throwIfAborted();
      sources.push({ path: workspaceRelativePath(file, folder), digest: researchDigest(bytes) });
      if (bytes.includes(0)) continue;
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      options.signal?.throwIfAborted();
      skipped++;
      continue;
    }
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length && hits.length < maxResults; index++) {
      options.signal?.throwIfAborted();
      if (lines[index].includes(query)) hits.push(`${workspaceRelativePath(file, folder)}:${index + 1}: ${lines[index].trim()}`);
    }
  }
  const content = hits.join('\n') || (limited ? '(no matches among inspected candidates)' : '(no matches)');
  const warnings = [
    ...(limited ? [researchDiscoveryWarning(500)] : []),
    ...(skipped ? [`Skipped ${skipped} research source(s) that could not be read safely as UTF-8 text; search coverage is incomplete.`] : []),
  ];
  return { content: truncate([...warnings, content].join('\n'), MAX_TEXT_CHARS), status: 'success', researchSources: sources,
    ...(warnings.length ? { researchLimitations: warnings } : {}) };
}

function researchDiscoveryWarning(limit: number): string {
  return `Discovery inspected only the first ${limit} workspace candidates; scoped files may be unscanned.`;
}

function researchDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Revalidate previously observed file evidence without invoking model tools or approvals. */
export async function verifyResearchSources(sources: readonly ResearchSource[], options: {
  signal?: AbortSignal;
  workspaceFolder?: vscode.WorkspaceFolder;
  researchPolicy: ResearchPolicy;
}): Promise<void> {
  options.signal?.throwIfAborted();
  if (sources.length > MAX_RESULT_COUNT) throw new Error('Research evidence changed or cannot be verified.');
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  for (const source of sources) {
    options.signal?.throwIfAborted();
    try {
      const target = resolveWorkspacePath(researchPath(source.path) || '.', folder);
      const bytes = await readResearchBytes(target, folder, options);
      options.signal?.throwIfAborted();
      if (researchDigest(bytes) !== source.digest) throw new Error('Fingerprint mismatch.');
    } catch {
      options.signal?.throwIfAborted();
      throw new Error('Research evidence changed or cannot be verified.');
    }
  }
}

function needsApproval(name: string, args: Record<string, unknown>, mode: ApprovalMode | undefined): boolean {
  if (mode === 'full') return false;
  if (mode === 'every' || mode === undefined) return true;
  if (name === 'delete_file') return true;
  if (name === 'run_command') return unsafeCommand(String(args.command ?? ''), Array.isArray(args.args) ? args.args.map(String) : []);
  if (['write_file', 'create_file', 'replace_in_file'].includes(name)) return sensitivePath(String(args.path ?? ''));
  return false;
}

function sensitivePath(value: string): boolean {
  const path = value.toLowerCase();
  return /(^|\/)(\.env(?:\..*)?|.*credential.*|.*secret.*|.*token.*|.*key.*|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|\.git\/.*|settings\.json)$/.test(path);
}

function unsafeCommand(command: string, args: string[]): boolean {
  const value = `${command} ${args.join(' ')}`.toLowerCase();
  return /\b(rm|rmdir|del|format|shutdown|reboot|sudo|chmod|chown|curl|wget|ssh|scp|git)\b|\b(install|publish|push|commit|reset|clean|checkout|delete|remove|drop|truncate|deploy|release|migrate|destroy)\b|\b(terraform\s+apply|kubectl\s+delete|docker\s+push)\b/.test(value);
}

async function approveIfNeeded(name: string, args: Record<string, unknown>, message: string, options: AgentToolOptions, preview?: () => Promise<void>): Promise<boolean> {
  options.signal?.throwIfAborted();
  requireWorkspaceFolder(options.workspaceFolder);
  if (!needsApproval(name, args, options.approvalMode)) return true;
  return options.approve ? options.approve(message, preview) : confirm(message);
}

async function getWorkspaceSummary(folder: vscode.WorkspaceFolder): Promise<string> {
  const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '{package.json,tsconfig.json,pyproject.toml,requirements.txt,Cargo.toml,go.mod,README.md}'), '**/{node_modules,.git,dist,out}/**', 20)).filter(file => isInWorkspace(file, folder));
  const lines = [
    `Workspace: ${folder.name}`,
    `Root: ${folder.uri.fsPath}`,
    '',
    'Project files:',
    ...(files.length ? files.map((file) => `- ${workspaceRelativePath(file, folder)}`) : ['- none found']),
  ];

  const packageJson = files.find((file) => workspaceRelativePath(file, folder) === 'package.json');
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

async function unsafeDelegatedPackageScript(command: string, args: string[], folder: vscode.WorkspaceFolder): Promise<boolean> {
  const executable = command.split(/[\\/]/).at(-1)!.toLowerCase().replace(/\.(?:cmd|exe|bat)$/i, '');
  // Shell wrappers can hide both the package manager and its target directory.
  // Ask rather than treating their opaque command text as a safe executable.
  if (['cmd', 'powershell', 'pwsh', 'sh', 'bash', 'zsh', 'fish'].includes(executable)) return true;
  if (!['npm', 'pnpm', 'yarn'].includes(executable)) return false;
  let directory = folder.uri;
  const invocation: string[] = [];
  const directoryFlags = ['--prefix', '--dir', '--cwd', '-C'];
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--') break;
    const flag = directoryFlags.find(value => argument === value || argument.startsWith(value + '='));
    if (flag) {
      const target = argument.startsWith(flag + '=') ? argument.slice(flag.length + 1) : args[++index];
      if (!target) return true;
      directory = vscode.Uri.file(path.resolve(folder.uri.fsPath, target));
    } else if (!['--silent', '-s'].includes(argument)) invocation.push(argument);
  }
  if (!isInWorkspace(directory, folder)) return true;
  if (invocation.length === 1 && ['--version', '-v', '--help', '-h'].includes(invocation[0])) return false;
  const script = ['run', 'run-script'].includes(invocation[0]) ? invocation[1]
    : executable !== 'npm' || ['test', 'start', 'stop', 'restart'].includes(invocation[0]) ? invocation[0] : undefined;
  // Unknown invocations (install, exec, unsupported options, etc.) need approval.
  if (!script || script.startsWith('-')) return true;
  try {
    const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(directory, 'package.json'));
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { scripts?: Record<string, unknown> };
    const scripts = Object.fromEntries(Object.entries(manifest.scripts ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    if (!Object.prototype.hasOwnProperty.call(scripts, script)) return true;
    return isUnsafeVerificationScript(script, scripts[script], scripts);
  } catch {
    return true;
  }
}

async function getProjectVerificationCommands(folder: vscode.WorkspaceFolder): Promise<string> {
  const candidates = (await vscode.workspace.findFiles(
    new vscode.RelativePattern(folder, '**/{package.json,pyproject.toml,pytest.ini,mypy.ini,tox.ini,setup.cfg,Cargo.toml,go.mod,composer.json,pom.xml,build.gradle,build.gradle.kts,gradlew,gradlew.bat,Makefile,package-lock.json,pnpm-lock.yaml,yarn.lock}'),
    '**/{node_modules,.git,dist,out,vendor,target}/**',
    100,
  )).filter(file => isInWorkspace(file, folder));
  const files: Record<string, string> = {};
  const manifests: ProjectPackageManifest[] = [];
  for (const file of candidates) {
    const relative = workspaceRelativePath(file, folder);
    try {
      const content = new TextDecoder('utf-8', { fatal: true }).decode(await vscode.workspace.fs.readFile(file));
      files[relative] = content;
      if (path.posix.basename(relative) === 'package.json') {
        const parsed = JSON.parse(content) as { scripts?: Record<string, unknown> };
        manifests.push({ path: relative, scripts: parsed.scripts ?? {} });
      }
    } catch {
      // Skip malformed or unreadable metadata; do not guess its scripts.
    }
  }
  const preferences = vscode.workspace.getConfiguration('deeplocal', folder.uri).get<string[]>('verificationPreferences', []);
  return JSON.stringify(discoverProjectVerification(manifests, files, preferences), null, 2);
}

function getActiveFile(folder: vscode.WorkspaceFolder): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return 'No active editor.';
  }
  if (!isInWorkspace(editor.document.uri, folder)) return 'The active editor is outside the selected workspace folder.';
  const relative = workspaceRelativePath(editor.document.uri, folder);
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

function getSelection(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): string {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return 'No active editor.';
  }
  if (!isInWorkspace(editor.document.uri, folder)) return 'The active editor is outside the selected workspace folder.';
  if (editor.selection.isEmpty) {
    return 'No selected text.';
  }
  return truncate(editor.document.getText(editor.selection), boundedNumber(args.maxChars, 20000, MAX_TEXT_CHARS));
}

function getDiagnostics(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): string {
  const maxResults = boundedNumber(args.maxResults, 80, MAX_RESULT_COUNT);
  const target = typeof args.path === 'string' && args.path.trim()
    ? resolveWorkspacePath(args.path, folder)
    : undefined;
  const entries = target
    ? [[target, vscode.languages.getDiagnostics(target)] as const]
    : vscode.languages.getDiagnostics();
  const lines: string[] = [];

  for (const [uri, diagnostics] of entries) {
    if (!isInWorkspace(uri, folder)) continue;
    for (const diagnostic of diagnostics) {
      if (lines.length >= maxResults) {
        break;
      }
      const severity = vscode.DiagnosticSeverity[diagnostic.severity];
      lines.push(`${workspaceRelativePath(uri, folder)}:${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${severity}: ${diagnostic.message}`);
    }
  }

  return lines.join('\n') || '(no diagnostics)';
}

async function openFile(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): Promise<string> {
  const uri = resolveWorkspacePath(args.path, folder);
  const document = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(document, { preview: false });
  return `Opened ${workspaceRelativePath(uri, folder)}.`;
}

export function toolResultsToMessages(toolCalls: AgentToolResult[]): ChatMessage[] {
  return toolCalls.map((tool) => ({
    role: 'tool',
    tool_call_id: tool.callId,
    content: tool.content,
  }));
}

function resolveWorkspacePath(input: unknown, folder: vscode.WorkspaceFolder): vscode.Uri {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('A workspace-relative path is required.');
  }

  if (path.isAbsolute(input) || path.win32.isAbsolute(input) || /^[a-z][a-z0-9+.-]*:/i.test(input)) {
    throw new Error('A workspace-relative path is required.');
  }
  const uri = vscode.Uri.joinPath(folder.uri, input);

  if (!isInWorkspace(uri, folder)) {
    throw new Error('Path escapes the workspace.');
  }

  return uri;
}

async function listWorkspaceFiles(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): Promise<string> {
  const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern : '**/*';
  const maxResults = boundedNumber(args.maxResults, 200, MAX_RESULT_COUNT);
  const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), '**/{node_modules,.git,dist,out}/**', maxResults)).filter(file => isInWorkspace(file, folder));
  return files.map((file) => workspaceRelativePath(file, folder)).join('\n') || '(no files)';
}

function decodeFileText(bytes: Uint8Array, relative: string): string {
  const unsupportedMessage = `Cannot read ${relative}: binary or unsupported file (expected UTF-8 text).`;
  if (bytes.includes(0)) {
    throw new Error(unsupportedMessage);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(unsupportedMessage);
  }
  return text;
}

async function readFile(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): Promise<string> {
  const uri = resolveWorkspacePath(args.path, folder);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return truncate(decodeFileText(bytes, workspaceRelativePath(uri, folder)), boundedNumber(args.maxChars, 30000, MAX_TEXT_CHARS));
}

async function searchWorkspace(args: Record<string, unknown>, folder: vscode.WorkspaceFolder): Promise<string> {
  const query = String(args.query ?? '').trim();
  if (!query) {
    throw new Error('query is required.');
  }

  const maxResults = boundedNumber(args.maxResults, 80, MAX_RESULT_COUNT);
  const files = (await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '**/{node_modules,.git,dist,out}/**', 500)).filter(file => isInWorkspace(file, folder));
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
        hits.push(`${workspaceRelativePath(file, folder)}:${index + 1}: ${lines[index].trim()}`);
      }
    }
  }

  return hits.join('\n') || '(no matches)';
}

async function writeFile(args: Record<string, unknown>, options: AgentToolOptions, createOnly = false): Promise<WorkspaceToolOutcome> {
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  const uri = resolveWorkspacePath(args.path, folder);
  if (typeof args.content !== 'string') throw new Error('content must be a string.');
  let exists = true;
  try { await vscode.workspace.fs.stat(uri); } catch (error) {
    if ((error as { code?: string }).code !== 'FileNotFound') throw error;
    exists = false;
  }
  if (createOnly && exists) throw new Error('File already exists; choose a new path or explicitly edit the existing file.');
  const document = exists ? await vscode.workspace.openTextDocument(uri) : undefined;
  return applyFileChange(uri, document, args.content, options);
}

async function replaceInFile(args: Record<string, unknown>, options: AgentToolOptions): Promise<WorkspaceToolOutcome> {
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  const uri = resolveWorkspacePath(args.path, folder);
  const oldText = String(args.oldText ?? '');
  const newText = String(args.newText ?? '');

  if (!oldText) {
    throw new Error('oldText is required.');
  }

  const document = await vscode.workspace.openTextDocument(uri);
  const original = document.getText();
  if (!original.includes(oldText)) {
    throw new Error('oldText was not found; no changes applied.');
  }

  if (original.indexOf(oldText) !== original.lastIndexOf(oldText)) throw new Error('oldText matches multiple locations; provide more context.');
  return applyFileChange(uri, document, original.replace(oldText, newText), options);
}

async function deleteFile(args: Record<string, unknown>, options: AgentToolOptions): Promise<string> {
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  const uri = resolveWorkspacePath(args.path, folder);
  const stat = await vscode.workspace.fs.stat(uri);
  if (stat.type & vscode.FileType.Directory) throw new Error('delete_file only supports individual files, not directories.');
  const document = await vscode.workspace.openTextDocument(uri);
  if (document.isDirty) throw new Error('File has unsaved changes. Save or discard them before requesting deletion.');
  const version = document.version;
  const label = workspaceRelativePath(uri, folder);
  const scheme = `deeplocal-delete-${Math.random().toString(36).slice(2)}`;
  const before = vscode.Uri.parse(`${scheme}:/before/${encodeURIComponent(label)}`);
  const after = vscode.Uri.parse(`${scheme}:/after/${encodeURIComponent(label)}`);
  const original = document.getText();
  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: target => target.toString() === before.toString() ? original : '',
  });
  try {
    const message = `Delete ${label} (move to trash)`;
    const preview = async () => { await vscode.commands.executeCommand('vscode.diff', before, after, `Delete ${label}`, { preview: true }); };
    const approved = await approveIfNeeded('delete_file', args, message, options, preview);
    options.signal?.throwIfAborted();
    requireWorkspaceFolder(options.workspaceFolder);
    if (!approved) return 'User declined file deletion. Do not retry without new instructions.';
    if (document.version !== version || document.isDirty) throw new Error('File changed during review; request deletion again after reviewing it.');
    await vscode.workspace.fs.delete(uri, { recursive: false, useTrash: true });
    return `Moved ${label} to the trash.`;
  } finally {
    provider.dispose();
  }
}

async function applyFileChange(uri: vscode.Uri, document: vscode.TextDocument | undefined, content: string, options: AgentToolOptions): Promise<WorkspaceToolOutcome> {
  const folder = requireWorkspaceFolder(options.workspaceFolder);
  const label = workspaceRelativePath(uri, folder);
  if (document?.isDirty) throw new Error('File has unsaved changes. Save or discard them before requesting an agent edit.');
  const version = document?.version;
  const original = document?.getText() ?? '';
  const typeScript = isTypeScriptPath(label);
  if (typeScript) {
    const conflicts = findNewDuplicateImports(label, original, content);
    if (conflicts.length) {
      const details = conflicts.slice(0, 80).map(conflict => `${conflict.name}: ${conflict.locations.map(location => `${label}:${location.line}:${location.character}`).join(', ')}`);
      throw new Error(`No change applied: new or worsened duplicate import bindings.\n${truncate(details.join('\n'), 30000)}${conflicts.length > 80 ? '\n... additional conflicts omitted ...' : ''}\nRead the existing imports and symbol usages, then modify the existing declaration instead of adding a conflicting import.`);
    }
  }
  const scheme = `deeplocal-preview-${Math.random().toString(36).slice(2)}`;
  const before = vscode.Uri.parse(`${scheme}:/before/${encodeURIComponent(label)}`);
  const after = vscode.Uri.parse(`${scheme}:/after/${encodeURIComponent(label)}`);
  const provider = vscode.workspace.registerTextDocumentContentProvider(scheme, {
    provideTextDocumentContent: (target) => target.toString() === before.toString() ? original : content,
  });
  let validation: EditValidation | undefined;
  let savedMessage: string | undefined;
  let report: Awaited<ReturnType<EditValidation['finish']>> | undefined;
  try {
    const preview = async () => { await vscode.commands.executeCommand('vscode.diff', before, after, `${document ? 'Edit' : 'Create'} ${label}`, { preview: true }); };
    const message = `${document ? 'Edit' : 'Create'} ${label} (${content.split('\n').length} lines)`;
    const approved = await approveIfNeeded(document ? 'write_file' : 'create_file', { path: label }, message, options, preview);
    options.signal?.throwIfAborted();
    requireWorkspaceFolder(options.workspaceFolder);
    if (!approved) return 'User declined file change. Do not retry this action without new instructions.';
    if (document && (document.version !== version || document.isDirty)) throw new Error('File changed during review; read it again before editing.');
    const edit = new vscode.WorkspaceEdit();
    if (document) edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(original.length)), content);
    else {
      edit.createFile(uri, { overwrite: false, ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), content);
    }
    options.signal?.throwIfAborted();
    requireWorkspaceFolder(options.workspaceFolder);
    if (typeScript) validation = beginEditValidation(folder, uri, options.signal);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the file change.');
    const saved = await vscode.workspace.openTextDocument(uri);
    if (!await saved.save()) throw new Error('File change applied but could not be saved.');
    savedMessage = `${document ? 'Updated' : 'Created'} ${label}.`;
    report = await validation?.finish(saved);
    if (!options.signal?.aborted) await vscode.window.showTextDocument(saved, { preview: false, preserveFocus: true });
    return { content: `${savedMessage}${report ? `\n${report.content}` : ''}`, status: report?.status ?? 'success', saved: true,
      edit: { path: label, saved: true, diagnostics: report?.diagnostics } };
  } catch (error) {
    if (savedMessage) {
      return { content: `${savedMessage}\n${report?.content ?? 'Edit saved and retained.'}\n${report ? 'Editor display' : 'Verification or editor display'} did not finish: ${messageOf(error)}. Read the file and run relevant checks before claiming success.`, status: 'error', saved: true,
        edit: { path: label, saved: true, diagnostics: report?.diagnostics } };
    }
    throw error;
  } finally {
    validation?.dispose();
    provider.dispose();
  }
}

async function runCommand(callId: string, args: Record<string, unknown>, options: AgentToolOptions): Promise<AgentToolResult> {
  if (args.verification !== undefined && typeof args.verification !== 'boolean') throw new Error('verification must be a boolean.');
  const command = String(args.command ?? '').trim();
  const commandArgs = Array.isArray(args.args) ? args.args.map(String) : [];
  if (!command) {
    throw new Error('command is required.');
  }

  const folder = requireWorkspaceFolder(options.workspaceFolder);
  if (folder.uri.scheme !== 'file') throw new Error('Commands require a local workspace folder.');
  if (options.signal?.aborted) {
    const stopped = await executeCommand(command, commandArgs, folder.uri.fsPath, options.signal);
    return { ...result(callId, 'run_command', JSON.stringify(stopped), 'error'), command: stopped };
  }
  const delegatedUnsafe = options.approvalMode === 'safe' && await unsafeDelegatedPackageScript(command, commandArgs, folder);
  options.signal?.throwIfAborted();
  requireWorkspaceFolder(folder);
  const message = `Run command: ${command} ${commandArgs.join(' ')}?`;
  const ok = delegatedUnsafe
    ? (options.approve ? await options.approve(`${message}\nThe package command or shell wrapper is unsafe or could not be inspected safely.`, undefined) : await confirm(`${message}\nThe package command or shell wrapper is unsafe or could not be inspected safely.`))
    : await approveIfNeeded('run_command', args, message, options);
  options.signal?.throwIfAborted();
  if (!ok) {
    return result(callId, 'run_command', 'User declined command execution.');
  }

  requireWorkspaceFolder(folder);
  const commandResult = await executeCommand(command, commandArgs, folder.uri.fsPath, options.signal);
  return { ...result(callId, 'run_command', JSON.stringify(commandResult, null, 2), commandSucceeded(commandResult) ? 'success' : 'error'), command: commandResult };
}

function result(callId: string, name: string, content: string, status: AgentToolResult['status'] = 'success'): AgentToolResult {
  return { callId, name, content, status: content.startsWith('User declined ') ? 'declined' : status };
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Caller-supplied limits may be smaller than the cap but never larger. */
function boundedNumber(value: unknown, fallback: number, max: number): number {
  return Math.min(positiveNumber(value, fallback), max);
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
