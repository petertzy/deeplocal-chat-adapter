import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import type * as vscode from 'vscode';
import { getAgentTools, invokeAgentTool, toolResultsToMessages, verifyResearchSources, type AgentToolOptions } from '../../src/agent-tools';
import { RESEARCH_TOOLS, DEFAULT_SUBAGENT_LIMITS, type ResearchPolicy, type SubagentManagerOptions } from '../../src/subagent-types';
import { runSubagent } from '../../src/subagent-runner';
import type { ChatCompletionRequest, StreamEvent } from '../../src/protocol';

const env = vi.hoisted(() => ({
  folders: [] as vscode.WorkspaceFolder[], files: [] as vscode.Uri[],
  diagnostics: [] as [vscode.Uri, vscode.Diagnostic[]][],
  read: vi.fn(), handleRead: vi.fn(), close: vi.fn(), find: vi.fn(), approve: vi.fn(), effect: vi.fn(), cancel: vi.fn(),
}));

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
const nativeOpen = fs.open.bind(fs);
async function observedOpen(...args: Parameters<typeof fs.open>) {
  const handle = await nativeOpen(...args);
  const read = handle.readFile.bind(handle);
  const close = handle.close.bind(handle);
  handle.readFile = ((options: Parameters<typeof handle.readFile>[0]) => env.handleRead(String(args[0]), () => read(options))) as typeof handle.readFile;
  handle.close = async () => { env.close(); await close(); };
  return handle;
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
  vi.spyOn(fs, 'open').mockImplementation(observedOpen);
  env.handleRead.mockImplementation((_target: string, read: () => Promise<Buffer>) => read());
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
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'success', content: 'needle allowed' });
});

it.each(['src-other/secret.txt', '../secret', 'src/../src/a.txt', 'src\\..\\src/a.txt', '/outside', 'C:\\outside', 'file:///outside'])('rejects path %s without reading it', async target => {
  expect(await invoke('read_file', { path: target })).toMatchObject({ status: 'error' });
  expect(env.read).not.toHaveBeenCalled();
});

it('filters discovery, search reads, and diagnostics to segment-bounded scope', async () => {
  expect((await invoke('list_workspace_files')).content).toBe('src/a.txt\nsrc/b.txt');
  expect((await invoke('search_workspace', { query: 'needle' })).content).toBe('src/a.txt:1: needle allowed\nsrc/b.txt:1: needle second');
  expect(env.handleRead).not.toHaveBeenCalled();
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

it('honors cancellation before discovery and after the first search read', async () => {
  const controller = new AbortController();
  controller.abort();
  expect(await invoke('search_workspace', { query: 'needle' }, { signal: controller.signal })).toMatchObject({ status: 'error' });
  expect(env.find).not.toHaveBeenCalled();
  const running = new AbortController();
  env.handleRead.mockImplementation(async (_target: string, read: () => Promise<Buffer>) => { const bytes = await read(); running.abort(); return bytes; });
  expect(await invoke('search_workspace', { query: 'needle' }, { signal: running.signal })).toMatchObject({ status: 'success' });
  expect(env.handleRead).not.toHaveBeenCalled();
});

it('passes a cancellation token to discovery and aborts before reading', async () => {
  const controller = new AbortController();
  env.find.mockImplementation(async () => { controller.abort(); return env.files; });
  expect(await invoke('search_workspace', { query: 'needle' }, { signal: controller.signal })).toMatchObject({ status: 'error' });
  expect(env.find.mock.calls[0][3]).toBeDefined();
  expect(env.cancel).toHaveBeenCalledOnce();
  expect(env.read).not.toHaveBeenCalled();
});

it('keeps UTF-8 validation and character limits for restricted reads', async () => {
  expect((await invoke('read_file', { path: 'src/a.txt', maxChars: 6 })).content).toBe('needle\n\n... truncated ...');
  await fs.writeFile(path.join(root, 'src/a.txt'), Buffer.from([0xff]));
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error', content: expect.stringContaining('UTF-8') });
});

it('retains unrestricted tool discovery and read behavior', async () => {
  expect(getAgentTools().some(tool => tool.function.name === 'run_command')).toBe(true);
  expect(await invokeAgentTool('test', 'read_file', JSON.stringify({ path: 'src-other/secret.txt' }), { approvalMode: 'full' })).toMatchObject({ status: 'success', content: 'needle secret' });
});

it('fingerprints the original accessed bytes and verifies unchanged evidence without approvals', async () => {
  const result = await invoke('read_file', { path: 'src/a.txt', maxChars: 6 });
  expect(result.researchSources).toEqual([{ path: 'src/a.txt', digest: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
  expect(JSON.stringify(toolResultsToMessages([result]))).not.toContain('digest');
  await verifyResearchSources(result.researchSources!, { researchPolicy: policy });
  expect(env.approve).not.toHaveBeenCalled();
  await fs.writeFile(path.join(root, 'src/a.txt'), 'needle changed beyond the returned prefix');
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy })).rejects.toThrow('Research evidence changed');
});

it('fingerprints only actually read search sources, including reads without matches', async () => {
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

it('stops evidence verification before reads and between source reads on cancellation', async () => {
  const result = await invoke('search_workspace', { query: 'needle' });
  env.handleRead.mockClear();
  const pre = new AbortController();
  pre.abort();
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy, signal: pre.signal })).rejects.toThrow();
  expect(env.handleRead).not.toHaveBeenCalled();
  const running = new AbortController();
  env.handleRead.mockImplementation(async (_target: string, read: () => Promise<Buffer>) => { const bytes = await read(); running.abort(); return bytes; });
  await expect(verifyResearchSources(result.researchSources!, { researchPolicy: policy, signal: running.signal })).resolves.toBeUndefined();
  expect(env.handleRead).not.toHaveBeenCalled();
});

async function substituteBeforeOpen(kind: 'file' | 'directory', restoreBeforeChecks: boolean): Promise<void> {
  const source = path.join(root, kind === 'file' ? 'src/a.txt' : 'src');
  const saved = path.join(root, 'original');
  const excluded = path.join(root, kind === 'file' ? 'src-other/secret.txt' : 'src-other');
  await fs.writeFile(path.join(root, 'src-other/a.txt'), 'needle secret');
  vi.mocked(fs.open).mockImplementationOnce(async (...args) => {
    await fs.rename(source, saved);
    if (kind === 'file') await fs.link(excluded, source);
    else await fs.symlink(excluded, source, process.platform === 'win32' ? 'junction' : 'dir');
    try { return await observedOpen(...args); }
    finally {
      if (restoreBeforeChecks) {
        await fs.rm(source, { recursive: kind === 'directory', force: true });
        await fs.rename(saved, source);
      }
    }
  });
}

it.each(['read_file', 'search_workspace'] as const)('rejects replacement identity before %s reads any bytes', async tool => {
  env.files = [uri('src/a.txt')];
  await substituteBeforeOpen('file', false);
  const result = await invoke(tool, tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'needle' });
  expect(result.content).not.toContain('needle secret');
  expect(result.researchSources ?? []).toHaveLength(1);
  expect(result.status).toBe('success');
  expect(env.handleRead).not.toHaveBeenCalled();
});

it.each([
  ['read_file', false], ['read_file', true], ['search_workspace', false], ['search_workspace', true],
] as const)('rejects ancestor substitution before %s reads (restored before checks: %s)', async (tool, restore) => {
  env.files = [uri('src/a.txt')];
  await substituteBeforeOpen('directory', restore);
  const result = await invoke(tool, tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'needle' });
  expect(result.content).not.toContain('needle secret');
  expect(result.researchSources ?? []).toHaveLength(1);
  expect(env.handleRead).not.toHaveBeenCalled();
});

it.each(['read_file', 'search_workspace'] as const)('never forwards substituted bytes from %s to a child model request', async tool => {
  env.files = [uri('src/a.txt')];
  await substituteBeforeOpen('directory', true);
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
  const result = await runSubagent({ id: 'child', task, signal: controller.signal, options, reserveOutput: value => value });
  expect(requests).toHaveLength(2);
  expect(JSON.stringify(requests)).not.toContain('needle secret');
  expect(result.state).toBe('completed');
  expect(env.handleRead).not.toHaveBeenCalled();
});

it('keeps the pinned descriptor when a parent replacement is attempted immediately before reading', async () => {
  let replacementBlocked = false;
  env.handleRead.mockImplementationOnce(async (_target: string, read: () => Promise<Buffer>) => {
    try { await fs.rename(path.join(root, 'src'), path.join(root, 'original')); }
    catch (error) {
      if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
      replacementBlocked = true;
      return read(); // Windows can prevent moving the parent while its file is open.
    }
    await fs.writeFile(path.join(root, 'src-other/a.txt'), 'needle secret');
    await fs.symlink(path.join(root, 'src-other'), path.join(root, 'src'), process.platform === 'win32' ? 'junction' : 'dir');
    const bytes = await read();
    expect(bytes.toString()).toBe('needle allowed');
    return bytes;
  });
  const result = await invoke('read_file', { path: 'src/a.txt' });
  expect(result).toMatchObject({ status: 'success', content: 'needle allowed' });
  expect(result.content).not.toContain('needle secret');
  expect(env.close).not.toHaveBeenCalled();
});

it('reads through the descriptor-relative path rather than the mocked path reader', async () => {
  env.handleRead.mockImplementationOnce(async () => { throw new Error('synthetic read failure'); });
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'success', content: 'needle allowed' });
  expect(env.handleRead).not.toHaveBeenCalled();
});

it.each(['read_file', 'search_workspace'] as const)('rejects poisoned target metadata during %s snapshot capture', async tool => {
  env.files = [uri('src/a.txt')];
  await substituteBeforeOpen('directory', true);
  const originalLstat = fs.lstat.bind(fs);
  vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
    if (String(target) !== uri('src/a.txt').fsPath) return originalLstat(target, options);
    const source = path.join(root, 'src');
    const saved = path.join(root, 'original');
    await fs.rename(source, saved);
    await fs.symlink(path.join(root, 'src-other'), source, process.platform === 'win32' ? 'junction' : 'dir');
    try { return await originalLstat(target, options); }
    finally {
      await fs.rm(source, { recursive: true, force: true });
      await fs.rename(saved, source);
    }
  }) as typeof fs.lstat);
  const result = await invoke(tool, tool === 'read_file' ? { path: 'src/a.txt' } : { query: 'needle' });
  expect(result.content).not.toContain('needle secret');
  expect(result.researchSources ?? []).toEqual([]);
  expect(fs.open).not.toHaveBeenCalled();
  expect(env.handleRead).not.toHaveBeenCalled();
});

it('recaptures a transient directory metadata change before opening a file', async () => {
  const originalLstat = fs.lstat.bind(fs);
  let changed = false;
  vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
    const stat = await originalLstat(target, options);
    if (!changed && String(target) === uri('src/a.txt').fsPath) {
      changed = true;
      await fs.mkdir(path.join(root, 'unrelated'));
    }
    return stat;
  }) as typeof fs.lstat);
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'success', content: 'needle allowed' });
  expect(changed).toBe(true);
  expect(fs.open).not.toHaveBeenCalled();
  expect(env.handleRead).not.toHaveBeenCalled();
});

it('bounds snapshot recapture without reading when a directory keeps changing', async () => {
  const originalLstat = fs.lstat.bind(fs);
  let changes = 0;
  vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
    const stat = await originalLstat(target, options);
    if (String(target) === uri('src/a.txt').fsPath) await fs.mkdir(path.join(root, `unrelated-${++changes}`));
    return stat;
  }) as typeof fs.lstat);
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error' });
  expect(changes).toBe(6); // Three captures, each checking the target twice.
  expect(fs.open).not.toHaveBeenCalled();
  expect(env.handleRead).not.toHaveBeenCalled();
});

it('retains the initial canonical root across snapshot recaptures', async () => {
  const originalLstat = fs.lstat.bind(fs);
  const originalRealpath = fs.realpath.bind(fs);
  let redirected = false;
  let rootChecks = 0;
  vi.spyOn(fs, 'lstat').mockImplementation((async (target: Parameters<typeof fs.lstat>[0], options: Parameters<typeof fs.lstat>[1]) => {
    const stat = await originalLstat(target, options);
    if (!redirected && String(target) === uri('src/a.txt').fsPath) {
      await fs.mkdir(path.join(root, 'unrelated'));
      redirected = true;
    }
    return stat;
  }) as typeof fs.lstat);
  vi.spyOn(fs, 'realpath').mockImplementation((async (target: Parameters<typeof fs.realpath>[0], ...args: unknown[]) => {
    if (String(target) === root && ++rootChecks > 3 && redirected) return path.join(root, 'src-other');
    return originalRealpath(target, ...args as []);
  }) as typeof fs.realpath);
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'error', content: expect.stringContaining('workspace changed') });
  expect(fs.open).not.toHaveBeenCalled();
});

it('permits unrelated directory activity once a trusted descriptor is pinned', async () => {
  env.handleRead.mockImplementationOnce(async (_target: string, read: () => Promise<Buffer>) => {
    await fs.mkdir(path.join(root, 'unrelated'));
    return read();
  });
  expect(await invoke('read_file', { path: 'src/a.txt' })).toMatchObject({ status: 'success', content: 'needle allowed' });
  expect(env.close).not.toHaveBeenCalled();
});
