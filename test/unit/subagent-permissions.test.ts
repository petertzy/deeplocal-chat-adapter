import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import * as nodeFs from 'node:fs';
import * as os from 'node:os';
import * as koffi from 'koffi';
import type * as vscode from 'vscode';
import { getAgentTools, invokeAgentTool, toolResultsToMessages, verifyResearchSources, type AgentToolOptions } from '../../src/agent-tools';
import { RESEARCH_TOOLS, DEFAULT_SUBAGENT_LIMITS, type ResearchPolicy, type SubagentManagerOptions } from '../../src/subagent-types';
import { runSubagent } from '../../src/subagent-runner';
import { SubagentManager } from '../../src/subagent-manager';
import type { ChatCompletionRequest, StreamEvent } from '../../src/protocol';

const fs = nodeFs.promises;
type BigIntStats = nodeFs.BigIntStats;

const supportsDescriptorReads = process.platform === 'darwin' || process.platform === 'linux';
const descriptorIt = it.skipIf(!supportsDescriptorReads);
const unsupportedReadError = 'safe descriptor-relative reads are not supported';

const env = vi.hoisted(() => ({
  folders: [] as vscode.WorkspaceFolder[], files: [] as vscode.Uri[],
  diagnostics: [] as [vscode.Uri, vscode.Diagnostic[]][],
  read: vi.fn(), find: vi.fn(), approve: vi.fn(), effect: vi.fn(), cancel: vi.fn(),
}));

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});

vi.mock('koffi', async importOriginal => {
  const actual = await importOriginal<typeof import('koffi')>();
  return { ...actual, load: vi.fn(actual.load) };
});

vi.mock('vscode', () => {
  const uri = (fsPath: string) => ({ fsPath, scheme: 'file', authority: '', toString: () => fsPath });
  return {
    Uri: { joinPath: (base: { fsPath: string }, relative: string) => uri(path.resolve(base.fsPath, relative)) },
    RelativePattern: class { constructor(public base: unknown, public pattern: string) {} },
    CancellationTokenSource: class { token = {}; cancel = env.cancel; dispose() {} },
    workspace: {
      get workspaceFolders() { return env.folders; },
      findFiles: env.find,
      fs: { readFile: env.read, writeFile: env.effect, delete: env.effect },
      openTextDocument: env.effect, applyEdit: env.effect,
    },
    languages: { getDiagnostics: (target?: vscode.Uri) => target ? env.diagnostics.find(([uri]) => uri.fsPath === target.fsPath)?.[1] ?? [] : env.diagnostics },
    window: { showTextDocument: env.effect, showWarningMessage: env.effect },
    commands: { executeCommand: env.effect }, DiagnosticSeverity: { 0: 'Error' },
  };
});

let root: string;
let policy: ResearchPolicy;
const nativeLoad = vi.mocked(koffi.load).getMockImplementation()!;
const nativeReadFile = vi.mocked(nodeFs.readFile).getMockImplementation()! as typeof nodeFs.readFile;
type ReadOptions = { signal?: AbortSignal };
type ReadCallback = (error: NodeJS.ErrnoException | null, bytes: Buffer) => void;
type OpenCall = { parent: number; name: string; flags: number; mode: number };
// Each acquisition has its own token: the OS may reuse a closed descriptor number.
function observeNative(beforeOpen?: (call: OpenCall, open: () => number) => number) {
  const active = new Map<number, object>();
  const acquired: object[] = [], closed: object[] = [];
  const reads = vi.fn();
  const opens = vi.fn();
  vi.mocked(koffi.load).mockImplementation(((...args: Parameters<typeof koffi.load>) => {
    const library = nativeLoad(...args);
    return { func(signature: string) {
      const native = library.func(signature) as (...args: (number | string)[]) => number;
      if (signature === 'int close(int)') return (fd: number) => {
        const token = active.get(fd);
        expect(token, 'close must own a live acquisition').toBeDefined();
        const result = native(fd);
        expect(result).toBe(0);
        active.delete(fd);
        closed.push(token!);
        return result;
      };
      if (signature !== 'int openat(int, const char *, int, int)') return native;
      return (parent: number, name: string, flags: number, mode: number) => {
        opens({ parent, name, flags, mode });
        const open = () => native(parent, name, flags, mode);
        const fd = beforeOpen ? beforeOpen({ parent, name, flags, mode }, open) : open();
        if (fd >= 0) {
          expect(active.has(fd), 'a live descriptor cannot be acquired twice').toBe(false);
          const token = {};
          acquired.push(token);
          active.set(fd, token);
        }
        return fd;
      };
    } } as unknown as ReturnType<typeof koffi.load>;
  }) as typeof koffi.load);
  const read = (fd: number, options: ReadOptions, callback: ReadCallback) => {
    expect(active.has(fd), 'read must use an acquired descriptor').toBe(true);
    reads(fd, options);
    nativeReadFile(fd, options, callback);
  };
  vi.mocked(nodeFs.readFile).mockImplementation(read as typeof nodeFs.readFile);
  return { active, acquired, closed, reads, opens, read, assertClosed() {
    expect(acquired.length).toBeGreaterThan(0);
    expect(active.size).toBe(0);
    expect(closed).toHaveLength(acquired.length);
    expect(new Set(closed).size).toBe(acquired.length);
  } };
}
function uri(relative: string): vscode.Uri {
  return { fsPath: path.resolve(root, relative), scheme: 'file', authority: '' } as vscode.Uri;
}
function invoke(name: string, args: Record<string, unknown> = {}, options: AgentToolOptions = {}) {
  return invokeAgentTool('test', name, JSON.stringify(args), { researchPolicy: policy, approvalMode: 'full', approve: env.approve, ...options });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  // macOS commonly exposes its temporary directory through /var while Node's
  // filesystem APIs return /private/var. Keep fixtures canonical so the
  // substitution hooks exercise the exact path opened by the implementation.
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'deeplocal-research-')));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'src-other'));
  await fs.writeFile(path.join(root, 'src/a.txt'), 'needle allowed');
  await fs.writeFile(path.join(root, 'src/b.txt'), 'needle second');
  await fs.writeFile(path.join(root, 'src-other/secret.txt'), 'needle secret');
  env.folders = [{ name: 'test', index: 0, uri: uri('.') }];
  env.files = [uri('src/a.txt'), uri('src-other/secret.txt'), uri('src/b.txt')];
  env.diagnostics = env.files.map(target => [target, [{ severity: 0, message: target.fsPath.includes('secret') ? 'secret diagnostic' : 'allowed diagnostic', range: { start: { line: 0, character: 0 } } } as vscode.Diagnostic]]);
  env.read.mockImplementation((target: vscode.Uri) => fs.readFile(target.fsPath));
  env.find.mockImplementation(async () => env.files);
  env.approve.mockResolvedValue(true);
  policy = { tools: RESEARCH_TOOLS, paths: ['src'] };
});

afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it.each(['full', 'safe', 'every', 'ask'] as const)('denies forbidden direct tool calls before approval/effects in %s mode', async approvalMode => {
  for (const name of ['write_file', 'create_file', 'replace_in_file', 'delete_file', 'run_command', 'get_selection', 'get_active_file', 'get_workspace_summary', 'open_file', 'discover_verification_commands', 'invented']) {
    expect(await invoke(name, { path: 'src/a.txt', command: 'node', args: [] }, { approvalMode })).toMatchObject({ status: 'error', content: expect.stringContaining('Research policy does not permit') });
  }
  expect(env.approve).not.toHaveBeenCalled();
  expect(env.effect).not.toHaveBeenCalled();
  expect(env.read).not.toHaveBeenCalled();
});

it('advertises only the policy intersection and enforces omitted read tools', async () => {
  policy = { tools: ['read_file'], paths: ['src/a.txt'] };
  expect(getAgentTools(policy).map(tool => tool.function.name)).toEqual(['read_file']);
  expect(await invoke('search_workspace', { query: 'needle' })).toMatchObject({ status: 'error' });
  expect(await invoke('read_file', { path: 'src/b.txt' })).toMatchObject({ status: 'error' });
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject(supportsDescriptorReads
    ? { status: 'success', content: 'needle allowed' }
    : { status: 'error', content: expect.stringContaining(unsupportedReadError) });
});

it.each(['src-other/secret.txt', '../secret', 'src/../src/a.txt', 'src\\..\\src/a.txt', '/outside', 'C:\\outside', 'file:///outside'])('rejects path %s without reading it', async target => {
  expect(await invoke('read_file', { path: target })).toMatchObject({ status: 'error' });
  expect(env.read).not.toHaveBeenCalled();
});

it('filters discovery, search reads, and diagnostics to segment-bounded scope', async () => {
  expect((await invoke('list_workspace_files')).content).toBe('src/a.txt\nsrc/b.txt');
  const search = await invoke('search_workspace', { query: 'needle' });
  if (supportsDescriptorReads) expect(search.content).toBe('src/a.txt:1: needle allowed\nsrc/b.txt:1: needle second');
  else {
    expect(search.researchSources).toEqual([]);
    expect(search.content).not.toContain('needle');
  }
  expect(env.read).not.toHaveBeenCalled();
  const diagnostics = await invoke('get_diagnostics');
  expect(diagnostics.content).toContain('allowed diagnostic');
  expect(diagnostics.content).not.toContain('secret');
  expect(await invoke('get_diagnostics', { path: 'src-other/secret.txt' })).toMatchObject({ status: 'error' });
  expect(env.find.mock.calls[0][1]).toBe('**/{node_modules,.git,dist,out}/**');
});

it('discloses capped discovery before scope filtering without claiming universal absence', async () => {
  env.find.mockImplementation(async (_pattern, _exclude, limit: number) =>
    Array.from({ length: limit }, () => uri('src-other/secret.txt')));
  const list = await invoke('list_workspace_files', { maxResults: 1 });
  const listWarning = 'Discovery inspected only the first 1 workspace candidates; scoped files may be unscanned.';
  expect(list.content).toBe(`${listWarning}\n(no files among inspected candidates)`);
  expect(list.researchLimitations).toEqual([listWarning]);
  const search = await invoke('search_workspace', { query: 'needle' });
  const searchWarning = 'Discovery inspected only the first 500 workspace candidates; scoped files may be unscanned.';
  expect(search.content).toBe(`${searchWarning}\n(no matches among inspected candidates)`);
  expect(search.researchLimitations).toEqual([searchWarning]);
  expect(search.researchSources).toEqual([]);
  expect(env.read).not.toHaveBeenCalled();
  expect(JSON.stringify(toolResultsToMessages([list, search]))).not.toContain('researchLimitations');
});

it('keeps uncapped empty discovery unchanged and reports coverage limits with positive results', async () => {
  env.find.mockResolvedValue([]);
  const emptyList = await invoke('list_workspace_files');
  const emptySearch = await invoke('search_workspace', { query: 'needle' });
  expect(emptyList.content).toBe('(no files)');
  expect(emptySearch.content).toBe('(no matches)');
  expect(emptyList.researchLimitations).toBeUndefined();
  expect(emptySearch.researchLimitations).toBeUndefined();
  env.find.mockResolvedValue([uri('src/a.txt')]);
  const list = await invoke('list_workspace_files', { maxResults: 1 });
  expect(list.content).toMatch(/^Discovery inspected only the first 1 workspace candidates; scoped files may be unscanned\.\nsrc\/a\.txt$/);
  expect(list.researchLimitations).toHaveLength(1);
});

it('rejects linked directories even when the link target is in the workspace', async () => {
  await fs.symlink(path.join(root, 'src-other'), path.join(root, 'src/linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const target = uri('src/linked/secret.txt');
  env.files = [target];
  expect(await invoke('read_file', { path: 'src/linked/secret.txt' })).toMatchObject({ status: 'error', content: expect.stringContaining('symbolic links') });
  expect((await invoke('list_workspace_files')).content).toBe('(no files)');
  expect((await invoke('search_workspace', { query: 'needle' })).content).toBe('(no matches)');
  expect(env.read).not.toHaveBeenCalled();
});

it('rejects a link escaping the pinned root and a file from a different root', async () => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'deeplocal-outside-'));
  try {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'outside secret');
    await fs.symlink(outside, path.join(root, 'src/escape'), process.platform === 'win32' ? 'junction' : 'dir');
    env.files = [uri('src/escape/secret.txt'), { ...uri('src/a.txt'), fsPath: path.join(outside, 'secret.txt') } as vscode.Uri];
    expect(await invoke('read_file', { path: 'src/escape/secret.txt' })).toMatchObject({ status: 'error' });
    expect((await invoke('search_workspace', { query: 'secret' })).content).toBe('(no matches)');
    expect(env.read).not.toHaveBeenCalled();
  } finally {
    await fs.rm(path.join(root, 'src/escape'), { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

it.each(['../', 'src/../src', '/absolute', 'C:\\absolute'])('rejects invalid policy scope %s', async scope => {
  policy = { tools: RESEARCH_TOOLS, paths: [scope] };
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error' });
  expect(await invoke('list_workspace_files')).toMatchObject({ status: 'error' });
  expect(env.read).not.toHaveBeenCalled();
});

it('fails closed for non-file roots and cross-root discovery', async () => {
  env.files = [{ ...uri('src/a.txt'), scheme: 'remote' } as vscode.Uri];
  expect((await invoke('list_workspace_files')).content).toBe('(no files)');
  env.folders = [{ ...env.folders[0], uri: { ...env.folders[0].uri, scheme: 'remote' } as vscode.Uri }];
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error' });
  expect(env.read).not.toHaveBeenCalled();
});

it('honors cancellation before discovery without starting a descriptor read', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await invoke('search_workspace', { query: 'needle' }, { signal: controller.signal })).toMatchObject({ status: 'error' });
  expect(env.find).not.toHaveBeenCalled();
  expect(nodeFs.readFile).not.toHaveBeenCalled();
});

it('passes a cancellation token to discovery and aborts before reading', async () => {
  const controller = new AbortController();
  env.find.mockImplementation(async () => { controller.abort(); return env.files; });
  expect(await invoke('search_workspace', { query: 'needle' }, { signal: controller.signal })).toMatchObject({ status: 'error' });
  expect(env.find.mock.calls[0][3]).toBeDefined();
  expect(env.cancel).toHaveBeenCalledOnce();
  expect(env.read).not.toHaveBeenCalled();
});

descriptorIt('keeps UTF-8 validation and character limits for restricted reads', async () => {
  expect((await invoke('read_file', { path: 'src/a.txt', maxChars: 6 })).content).toBe('needle\n\n... truncated ...');
  await fs.writeFile(path.join(root, 'src/a.txt'), Buffer.from([0xff]));
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error', content: expect.stringContaining('UTF-8') });
});

it('retains unrestricted tool discovery and read behavior', async () => {
  expect(getAgentTools().some(tool => tool.function.name === 'run_command')).toBe(true);
  expect(await invokeAgentTool('test', 'read_file', JSON.stringify({ path: 'src-other/secret.txt' }), { approvalMode: 'full' })).toMatchObject({ status: 'success', content: 'needle secret' });
});

it.skipIf(supportsDescriptorReads)('fails closed for scoped reads and search on unsupported platforms', async () => {
  const read = await invoke('read_file', { path: 'src/a.txt' });
  expect(read).toMatchObject({ status: 'error', content: expect.stringContaining(unsupportedReadError) });
  expect(read.content).not.toContain('needle allowed');
  expect(read.researchSources ?? []).toEqual([]);
  const search = await invoke('search_workspace', { query: 'needle' });
  expect(search.researchSources).toEqual([]);
  expect(search.content).toContain('search coverage is incomplete');
  expect(search.content).not.toContain('needle');
  expect(search.content).not.toContain('secret');
  expect(koffi.load).not.toHaveBeenCalled();
  expect(nodeFs.readFile).not.toHaveBeenCalled();
  expect(env.read).not.toHaveBeenCalled();
});

descriptorIt('fingerprints the original accessed bytes and verifies unchanged evidence without approvals', async () => {
  const result = await invoke('read_file', { path: 'src/a.txt', maxChars: 6 });
  expect(result.researchSources).toEqual([{ path: 'src/a.txt', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(JSON.stringify(toolResultsToMessages([result]))).not.toContain('digest');
  await verifyResearchSources(result.researchSources!, { researchPolicy: policy });
  expect(env.approve).not.toHaveBeenCalled();
  await fs.writeFile(path.join(root, 'src/a.txt'), 'needle changed beyond the returned prefix');
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
});

descriptorIt('fingerprints only actually read search sources, including reads without matches', async () => {
  const result = await invoke('search_workspace', { query: 'missing' });
  expect(result.researchSources?.map(source => source.path)).toEqual(['src/a.txt', 'src/b.txt']);
  await verifyResearchSources(result.researchSources!, { researchPolicy: policy });
  await fs.rm(path.join(root, 'src/b.txt'));
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
});

it('rejects out-of-scope and excessive verification metadata without reading files', async () => {
  await expect(verifyResearchSources([{ path: 'src-other/secret.txt', digest: 'any' }], { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
  await expect(verifyResearchSources(Array.from({ length: 501 }, () => ({ path: 'src/a.txt', digest: 'any' })), { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
  expect(env.read).not.toHaveBeenCalled();
});

descriptorIt.each(['read_file', 'search_workspace', 'verify'] as const)('cancels the actual %s read and settles its callback before closing', async tool => {
  const sources = tool === 'verify' ? (await invoke('search_workspace', { query: 'needle' })).researchSources! : [];
  const observation = observeNative();
  const controller = new AbortController();
  let callbackSettled = false;
  let readToken: object | undefined;
  vi.mocked(nodeFs.readFile).mockImplementation(((fd: number, options: ReadOptions, callback: ReadCallback) => {
    observation.reads(fd, options);
    expect(options.signal).toBe(controller.signal);
    readToken = observation.active.get(fd);
    expect(readToken).toBeDefined();
    options.signal!.addEventListener('abort', () => {
      // An asynchronous callback models a still-pending OS read at abort time.
      setImmediate(() => {
        try {
          expect(observation.active.get(fd)).toBe(readToken);
          expect(observation.closed).not.toContain(readToken);
        } finally {
          callbackSettled = true;
          callback(Object.assign(new Error('read aborted'), { name: 'AbortError', code: 'ABORT_ERR' }), Buffer.alloc(0));
        }
      });
    }, { once: true });
    controller.abort();
    expect(callbackSettled).toBe(false);
    expect(observation.active.get(fd)).toBe(readToken);
  }) as typeof nodeFs.readFile);
  if (tool === 'verify') await expect(verifyResearchSources(sources, { researchPolicy: policy, signal: controller.signal })).rejects.toThrow();
  else {
    const result = await invoke(tool, tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'needle' }, { signal: controller.signal });
    expect(result.status).toBe('error');
    expect(result.researchSources ?? []).toEqual([]);
    expect(result.content).not.toContain('needle allowed');
  }
  expect(callbackSettled).toBe(true);
  expect(observation.reads).toHaveBeenCalledOnce();
  observation.assertClosed();
});

descriptorIt('stops evidence verification before any descriptor read when pre-aborted', async () => {
  const result = await invoke('search_workspace', { query: 'needle' });
  vi.mocked(nodeFs.readFile).mockClear();
  const controller = new AbortController();
  controller.abort();
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy, signal: controller.signal })).rejects.toThrow();
  expect(nodeFs.readFile).not.toHaveBeenCalled();
});

function substituteAtOpen(kind: 'file' | 'directory' | 'root' | 'ancestor', restore: boolean) {
  const source = kind === 'file' ? path.join(root, 'src/a.txt') : kind === 'directory' ? path.join(root, 'src') : root;
  const saved = `${source}-original`;
  const excluded = kind === 'file' ? path.join(root, 'src-other/secret.txt') : kind === 'directory' ? path.join(root, 'src-other') : `${root}-excluded`;
  if (kind === 'root' || kind === 'ancestor') {
    nodeFs.mkdirSync(path.join(excluded, 'src'), { recursive: true });
    nodeFs.writeFileSync(path.join(excluded, 'src/a.txt'), 'needle secret');
  } else nodeFs.writeFileSync(path.join(root, 'src-other/a.txt'), 'needle secret');
  let substitutions = 0;
  const observation = observeNative((call, open) => {
    if (call.name !== path.basename(source) || substitutions) return open();
    substitutions++;
    nodeFs.renameSync(source, saved);
    if (kind === 'file') nodeFs.linkSync(excluded, source);
    else nodeFs.symlinkSync(excluded, source, 'dir');
    try {
      const fd = open();
      if (kind === 'file') {
        expect(fd).toBeGreaterThanOrEqual(0);
        expect(nodeFs.fstatSync(fd, { bigint: true }).ino).toBe(nodeFs.statSync(excluded, { bigint: true }).ino);
      } else {
        expect(call.flags & nodeFs.constants.O_NOFOLLOW).not.toBe(0);
        expect(fd).toBe(-1);
      }
      return fd;
    } finally {
      if (restore) {
        nodeFs.unlinkSync(source);
        nodeFs.renameSync(saved, source);
      }
    }
  });
  return { observation, get substitutions() { return substitutions; }, cleanup() {
    if (!restore && substitutions) { nodeFs.unlinkSync(source); nodeFs.renameSync(saved, source); }
    if (kind === 'root' || kind === 'ancestor') nodeFs.rmSync(excluded, { recursive: true, force: true });
  } };
}

function freezeDirectoryTimes() {
  const originalLstat = fs.lstat.bind(fs);
  const times = new Map<string, { ctimeNs: bigint; mtimeNs: bigint }>();
  let checks = 0;
  vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
    const stat = await originalLstat(target, options);
    if (!stat.isDirectory()) return stat;
    checks++;
    const key = String(target);
    if (!times.has(key)) times.set(key, { ctimeNs: (stat as BigIntStats).ctimeNs, mtimeNs: (stat as BigIntStats).mtimeNs });
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, times.get(key));
  }) as typeof fs.lstat);
  return () => checks;
}

descriptorIt.each(['read_file', 'search_workspace'] as const)('rejects substituted file identities before %s reads', async tool => {
  env.files = [uri('src/a.txt')];
  const fixture = substituteAtOpen('file', true);
  try {
    const result = await invoke(tool, tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'needle' });
    expect(fixture.substitutions).toBe(1);
    expect(result.content).not.toContain('needle secret');
    expect(result.researchSources ?? []).toEqual([]);
    if (tool === 'read_file') expect(result.status).toBe('error');
    expect(fixture.observation.reads).not.toHaveBeenCalled();
    fixture.observation.assertClosed();
  } finally { fixture.cleanup(); }
});

descriptorIt.each([
  ['read_file', 'directory', false], ['read_file', 'directory', true],
  ['search_workspace', 'directory', false], ['search_workspace', 'directory', true],
  ['read_file', 'root', true], ['search_workspace', 'root', true],
  ['read_file', 'ancestor', true], ['search_workspace', 'ancestor', true],
] as const)('rejects %s %s substitutions with unchanged directory timestamps (restore: %s)', async (tool, kind, restore) => {
  env.files = [uri('src/a.txt')];
  if (kind === 'ancestor') {
    env.folders = [{ ...env.folders[0], uri: uri('src') }];
    policy = { tools: RESEARCH_TOOLS, paths: ['a.txt'] };
  }
  const timestampChecks = freezeDirectoryTimes();
  const fixture = substituteAtOpen(kind, restore);
  try {
    const result = await invoke(tool, tool === 'read_file' ? { path: kind === 'ancestor' ? 'a.txt' : 'src/a.txt' } : { query: 'needle' });
    expect(fixture.substitutions).toBe(1);
    expect(timestampChecks()).toBeGreaterThan(0);
    expect(result.content).not.toContain('needle secret');
    expect(result.researchSources ?? []).toEqual([]);
    expect(fixture.observation.reads).not.toHaveBeenCalled();
    fixture.observation.assertClosed();
  } finally { fixture.cleanup(); }
});

descriptorIt.each(['read_file', 'search_workspace'] as const)('never forwards substituted bytes from %s to a child request', async tool => {
  env.files = [uri('src/a.txt')];
  const fixture = substituteAtOpen('root', true);
  const requests: ChatCompletionRequest[] = [];
  const controller = new AbortController();
  const task = { title: 'Inspect scoped source', objective: 'Inspect source', context: '', tools: [tool], paths: ['src'] };
  const options: SubagentManagerOptions = {
    requestId: 'root', model: 'test', signal: controller.signal, limits: { ...DEFAULT_SUBAGENT_LIMITS, enabled: true }, maxOutputTokens: 2048,
    stream: async function* (_id, request): AsyncGenerator<StreamEvent> {
      requests.push(structuredClone(request));
      yield { kind: 'toolCall', value: { id: String(requests.length), type: 'function', function: {
        name: requests.length === 1 ? tool : 'submit_research',
        arguments: JSON.stringify(requests.length === 1 ? tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'needle' } : { findings: [], limitations: [] }),
      } } };
    },
    invoke: (_task, call, signal) => invokeAgentTool(call.id, call.function.name, call.function.arguments,
      { signal, approvalMode: 'full', researchPolicy: policy }),
    cancel: vi.fn(), reserve: vi.fn(), onActivity: vi.fn(),
  };
  try {
    const result = await runSubagent({ id: 'child', task, signal: controller.signal, options, reserveOutput: value => value });
    expect(fixture.substitutions).toBe(1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(requests)).not.toContain('needle secret');
    expect(result.state).toBe('completed');
    expect(fixture.observation.reads).not.toHaveBeenCalled();
    fixture.observation.assertClosed();
  } finally { fixture.cleanup(); }
});

descriptorIt('uses the pinned file descriptor if its parent is replaced just before reading', async () => {
  const observation = observeNative();
  let replaced = false;
  vi.mocked(nodeFs.readFile).mockImplementation(((fd: number, options: ReadOptions, callback: ReadCallback) => {
    nodeFs.renameSync(path.join(root, 'src'), path.join(root, 'original'));
    nodeFs.symlinkSync(path.join(root, 'src-other'), path.join(root, 'src'), 'dir');
    replaced = true;
    observation.read(fd, options, (error, bytes) => {
      expect(bytes.toString()).toBe('needle allowed');
      callback(error, bytes);
    });
  }) as typeof nodeFs.readFile);
  const result = await invoke('read_file', { path: 'src/a.txt' });
  expect(replaced).toBe(true);
  expect(result).toMatchObject({ status: 'success', content: 'needle allowed' });
  expect(result.content).not.toContain('needle secret');
  expect(observation.reads).toHaveBeenCalledOnce();
  observation.assertClosed();
});

descriptorIt('closes acquired descriptors when the real descriptor read reports failure', async () => {
  const observation = observeNative();
  const intercepted = vi.fn();
  vi.mocked(nodeFs.readFile).mockImplementation(((fd: number, _options: ReadOptions, callback: ReadCallback) => {
    expect(observation.active.has(fd)).toBe(true);
    intercepted();
    callback(new Error('synthetic read failure'), Buffer.alloc(0));
  }) as typeof nodeFs.readFile);
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error', content: expect.stringContaining('synthetic read failure') });
  expect(intercepted).toHaveBeenCalledOnce();
  observation.assertClosed();
});

descriptorIt.each(['load', 'bind'] as const)(
  'fails closed with a descriptive error when native descriptor APIs cannot %s', async failure => {
    const fail = () => { throw new Error('synthetic native API failure'); };
    if (failure === 'load') vi.mocked(koffi.load).mockImplementationOnce(fail);
    else vi.mocked(koffi.load).mockReturnValueOnce({ func: fail } as unknown as ReturnType<typeof koffi.load>);
    const result = await invoke('read_file', { path: 'src/a.txt' });
    expect(result).toMatchObject({
      status: 'error', content: expect.stringContaining('native descriptor-relative filesystem API could not be loaded'),
    });
    expect(result.content).not.toContain('needle allowed');
    expect(result.researchSources ?? []).toEqual([]);
    expect(koffi.load).toHaveBeenCalledOnce();
    },
);

it.each([
  ['read_file', false], ['list_workspace_files', false], ['list_workspace_files', true],
  ['search_workspace', false], ['search_workspace', true],
] as const)('rejects workspace aliases clearly for %s (empty discovery: %s)', async (tool, empty) => {
  const alias = `${root}-alias`;
  await fs.symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  env.folders = [{ name: 'alias', index: 0, uri: { ...uri('.'), fsPath: alias } as vscode.Uri }];
  env.files = empty ? [] : [{ ...uri('src/a.txt'), fsPath: path.join(alias, 'src/a.txt') } as vscode.Uri];
  try {
    const observation = observeNative();
    const result = await invoke(tool, tool === 'read_file' ? { path: 'src/a.txt' } : tool === 'search_workspace' ? { query: 'needle' } : {});
    expect(result.status).toBe('error');
    expect(result.content).toMatch(/symbolic link|canonical/i);
    expect(result.researchSources ?? []).toEqual([]);
    expect(observation.reads).not.toHaveBeenCalled();
    if (supportsDescriptorReads) observation.assertClosed();
  } finally { await fs.unlink(alias); }
});

descriptorIt('permits unrelated directory activity with bounded admission work', async () => {
  let activity = 0;
  const originalLstat = fs.lstat.bind(fs);
  const metadata = vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
    const stat = await originalLstat(target, options);
    if (String(target) === path.join(root, 'src/a.txt')) {
      await fs.writeFile(path.join(root, `unrelated-${activity++}`), 'activity');
    }
    return stat;
  }) as typeof fs.lstat);
  const observation = observeNative();
  const result = await invoke('read_file', { path: 'src/a.txt' });
  expect(activity).toBeGreaterThan(0);
  expect(result).toMatchObject({ status: 'success', content: 'needle allowed' });
  const depth = path.resolve(root, 'src/a.txt').split(path.sep).filter(Boolean).length;
  expect(metadata.mock.calls.length).toBeLessThan(10 * (depth + 1));
  expect(observation.opens.mock.calls.length).toBeLessThan(4 * (depth + 1));
  expect(observation.reads).toHaveBeenCalledOnce();
  observation.assertClosed();
});

function denyAssignedMetadata(code: 'EACCES' | 'ENOENT') {
  const originalLstat = fs.lstat.bind(fs);
  const denied = vi.fn();
  vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
    if (String(target) === path.join(root, 'src/a.txt')) {
      denied();
      throw Object.assign(new Error('synthetic assigned candidate failure'), { code });
    }
    return originalLstat(target, options);
  }) as typeof fs.lstat);
  return denied;
}

it.each(['EACCES', 'ENOENT'] as const)('reports assigned discovery failures (%s) while retaining available files', async code => {
  const denied = denyAssignedMetadata(code);
  const list = await invoke('list_workspace_files');
  expect(denied).toHaveBeenCalled();
  expect(list.content).toContain('src/b.txt');
  expect(list.content).not.toContain('src/a.txt');
  expect(list.content).not.toContain('secret');
  expect(list.researchLimitations?.join(' ')).toMatch(/incomplete/);
  if (supportsDescriptorReads) {
    const search = await invoke('search_workspace', { query: 'needle' });
    expect(search.content).toContain('src/b.txt:1: needle second');
    expect(search.researchSources?.map(source => source.path)).toEqual(['src/b.txt']);
    expect(search.researchLimitations?.join(' ')).toMatch(/incomplete/);
  }
});

it.each(['list_workspace_files', 'search_workspace'] as const)('marks empty %s incomplete when assigned metadata is unavailable', async tool => {
  env.files = [uri('src/a.txt'), uri('src-other/secret.txt')];
  const denied = denyAssignedMetadata('ENOENT');
  const result = await invoke(tool, tool === 'search_workspace' ? { query: 'needle' } : {});
  expect(denied).toHaveBeenCalled();
  expect(result.researchLimitations?.join(' ')).toMatch(/incomplete/);
  expect(result.content).not.toBe(tool === 'search_workspace' ? '(no matches)' : '(no files)');
  expect(result.content).not.toContain('secret');
  expect(result.researchSources ?? []).toEqual([]);
});

it('reports candidate caps and failed inspections together while retaining positive discovery', async () => {
  env.find.mockResolvedValue([uri('src/a.txt'), uri('src/b.txt')]);
  const denied = denyAssignedMetadata('EACCES');
  const result = await invoke('list_workspace_files', { maxResults: 2 });
  expect(denied).toHaveBeenCalled();
  expect(result.content).toContain('src/b.txt');
  expect(result.researchLimitations).toHaveLength(2);
  expect(result.researchLimitations?.join(' ')).toContain('first 2');
  expect(result.researchLimitations?.join(' ')).toContain('incomplete');
});

it('omits intentional scope and link exclusions without reporting unavailable assigned candidates', async () => {
  await fs.symlink(path.join(root, 'src-other'), path.join(root, 'src/link'), process.platform === 'win32' ? 'junction' : 'dir');
  env.files = [uri('src-other/secret.txt'), uri('src/link/secret.txt')];
  const list = await invoke('list_workspace_files');
  expect(list.content).toBe('(no files)');
  expect(list.researchLimitations).toBeUndefined();
  expect(list.content).not.toContain('secret');
});

descriptorIt('reports assigned candidate identity changes during discovery as incomplete coverage', async () => {
  env.files = [uri('src/a.txt')];
  const fixture = substituteAtOpen('file', true);
  try {
    const result = await invoke('list_workspace_files');
    expect(fixture.substitutions).toBe(1);
    expect(result.researchLimitations?.join(' ')).toMatch(/incomplete/);
    expect(result.content).not.toContain('needle secret');
    expect(fixture.observation.reads).not.toHaveBeenCalled();
    fixture.observation.assertClosed();
  } finally { fixture.cleanup(); }
});

descriptorIt.each(['read_file', 'search_workspace'] as const)('aborts Node buffering in the actual %s descriptor read', async tool => {
  await fs.writeFile(path.join(root, 'src/a.txt'), Buffer.alloc(2 * 1024 * 1024, 'x'));
  const observation = observeNative();
  const controller = new AbortController();
  let abortedCallback = false;
  vi.mocked(nodeFs.readFile).mockImplementation(((fd: number, options: ReadOptions, callback: ReadCallback) => {
    observation.reads(fd, options);
    const token = observation.active.get(fd);
    expect(token).toBeDefined();
    expect(options.signal).toBe(controller.signal);
    nativeReadFile(fd, options, (error, bytes) => {
      try {
        expect(options.signal!.aborted).toBe(true);
        // Node 22/24 discard the abort error for caller-owned descriptors;
        // zero buffered bytes still proves the real read stopped on the signal.
        if (error) expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
        expect(bytes?.length ?? 0).toBe(0);
        expect(observation.active.get(fd)).toBe(token);
      } finally {
        abortedCallback = true;
        callback(error, bytes);
      }
    });
    controller.abort();
    expect(observation.active.get(fd)).toBe(token);
  }) as typeof nodeFs.readFile);
  const result = await invoke(tool, tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'needle' }, { signal: controller.signal });
  expect(abortedCallback).toBe(true);
  expect(observation.reads).toHaveBeenCalledOnce();
  expect(result.status).toBe('error');
  expect(result.researchSources ?? []).toEqual([]);
  observation.assertClosed();
});

descriptorIt.each(['read_file', 'search_workspace'] as const)('rejects poisoned target metadata during %s admission', async tool => {
  env.files = [uri('src/a.txt')];
  await fs.writeFile(path.join(root, 'src-other/a.txt'), 'needle secret');
  const originalLstat = fs.lstat.bind(fs);
  let poisoned = 0;
  vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
    if (String(target) !== path.join(root, 'src/a.txt') || poisoned) return originalLstat(target, options);
    poisoned++;
    const source = path.join(root, 'src');
    const saved = path.join(root, 'original');
    await fs.rename(source, saved);
    await fs.symlink(path.join(root, 'src-other'), source, 'dir');
    try { return await originalLstat(target, options); }
    finally { await fs.unlink(source); await fs.rename(saved, source); }
  }) as typeof fs.lstat);
  const observation = observeNative();
  const result = await invoke(tool, tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'needle' });
  expect(poisoned).toBe(1);
  expect(result.content).not.toContain('needle secret');
  expect(result.researchSources ?? []).toEqual([]);
  expect(observation.reads).not.toHaveBeenCalled();
  observation.assertClosed();
});

descriptorIt.each(['stop', 'child deadline', 'batch deadline'] as const)('propagates manager %s to the pending native read and waits for descriptor cleanup', async cancellation => {
  // Fake only the manager's deadline timers; native filesystem callbacks stay real.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const observation = observeNative();
  const parent = new AbortController();
  let started!: () => void;
  const readStarted = new Promise<void>(resolve => { started = resolve; });
  let callbackSettled = false;
  let descriptorSignal: AbortSignal | undefined;
  let pendingTool: ReturnType<typeof invokeAgentTool> | undefined;
  vi.mocked(nodeFs.readFile).mockImplementation(((fd: number, options: ReadOptions, callback: ReadCallback) => {
    observation.reads(fd, options);
    descriptorSignal = options.signal;
    expect(descriptorSignal).toBeDefined();
    expect(descriptorSignal).not.toBe(parent.signal);
    expect(descriptorSignal!.aborted).toBe(false);
    const token = observation.active.get(fd);
    expect(token).toBeDefined();
    nativeReadFile(fd, options, (error, bytes) => {
      try {
        expect(descriptorSignal!.aborted).toBe(true);
        // Caller-owned fd reads can lose AbortError in Node 22/24. They must
        // still stop buffering; the tool's signal check rejects the result.
        if (error) expect(error).toMatchObject({ name: 'AbortError', code: 'ABORT_ERR' });
        expect(bytes?.length ?? 0).toBe(0);
        expect(observation.active.get(fd)).toBe(token);
        expect(observation.closed).not.toContain(token);
      } finally {
        callbackSettled = true;
        callback(error, bytes);
      }
    });
    started();
  }) as typeof nodeFs.readFile);
  const stream = vi.fn(async function* (): AsyncGenerator<StreamEvent> {
    yield { kind: 'toolCall', value: { id: 'search', type: 'function', function: { name: 'search_workspace', arguments: '{"query":"needle"}' } } };
  });
  const options: SubagentManagerOptions = {
    requestId: 'root', model: 'test', signal: parent.signal,
    limits: { ...DEFAULT_SUBAGENT_LIMITS, enabled: true, timeoutMs: cancellation === 'child deadline' ? 50 : 500,
      batchTimeoutMs: cancellation === 'batch deadline' ? 50 : 1000 },
    maxOutputTokens: 2048, stream,
    invoke: (_task, call, signal) => {
      pendingTool = invokeAgentTool(call.id, call.function.name, call.function.arguments,
        { signal, approvalMode: 'full', researchPolicy: policy });
      return pendingTool;
    },
    cancel: vi.fn(), reserve: vi.fn(), onActivity: vi.fn(),
  };
  const manager = new SubagentManager(options);
  try {
    const pendingBatch = manager.run(JSON.stringify({ tasks: [{ title: 'Inspect sources', objective: 'Search assigned sources', context: '', paths: ['src'], tools: ['search_workspace'] }] }));
    await readStarted;
    // Abort synchronously before Node can advance to its next read callback.
    if (cancellation === 'stop') manager.stop();
    else vi.advanceTimersByTime(50);
    expect(descriptorSignal!.aborted).toBe(true);
    expect(callbackSettled).toBe(false);
    const batch = await pendingBatch;
    expect(batch.results[0]).toMatchObject({ state: cancellation === 'stop' ? 'cancelled' : 'limited', findings: [], testsRun: false });
    // Child cancellation is prompt; the underlying tool still owns fd until Node settles.
    const tool = await pendingTool!;
    expect(callbackSettled).toBe(true);
    expect(tool.status).toBe('error');
    expect(tool.researchSources ?? []).toEqual([]);
    expect(tool.content).not.toContain('needle allowed');
    expect(observation.reads).toHaveBeenCalledOnce();
    expect(stream).toHaveBeenCalledOnce();
    observation.assertClosed();
  } finally {
    manager.stop();
    vi.useRealTimers();
  }
});
