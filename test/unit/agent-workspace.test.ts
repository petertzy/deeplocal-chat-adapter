import { beforeEach, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import * as path from 'node:path';
import { isInWorkspace, requireWorkspaceFolder, workspaceLabel, workspaceRelativePath } from '../../src/agent-workspace';

const env = vi.hoisted(() => ({ folders: [] as vscode.WorkspaceFolder[] }));
vi.mock('vscode', () => ({ workspace: { get workspaceFolders() { return env.folders; } } }));
const folder = (directory: string, scheme = 'file', authority = '') => ({
  name: 'same', index: 0, uri: { fsPath: path.resolve(directory), scheme, authority },
} as vscode.WorkspaceFolder);
beforeEach(() => { env.folders = [folder('/one'), folder('/two')]; });

it('selects the only folder automatically and never guesses between several roots', () => {
  expect(() => requireWorkspaceFolder()).toThrow('Choose a workspace folder');
  env.folders.pop();
  expect(requireWorkspaceFolder()).toBe(env.folders[0]);
  env.folders = [];
  expect(() => requireWorkspaceFolder()).toThrow('No workspace folder');
});

it('identifies roots by URI rather than duplicate names or array indices', () => {
  const selected = env.folders[1];
  env.folders.reverse();
  expect(requireWorkspaceFolder(selected)).toBe(selected);
  expect(workspaceLabel(selected)).toContain(path.resolve('/two'));
});

it('refuses a removed pinned folder rather than silently selecting the remaining root', () => {
  const selected = env.folders.pop()!;
  expect(() => requireWorkspaceFolder(selected)).toThrow('removed');
});

it('uses segment boundaries and URI scheme/authority for confinement', () => {
  const root = env.folders[0];
  expect(isInWorkspace(folder('/one/child').uri, root)).toBe(true);
  expect(isInWorkspace(folder('/one/..allowed').uri, root)).toBe(true);
  expect(isInWorkspace(folder('/one-other/file').uri, root)).toBe(false);
  expect(isInWorkspace(folder('/two').uri, root)).toBe(false);
  expect(isInWorkspace(folder('/one/file', 'untitled').uri, root)).toBe(false);
  expect(isInWorkspace(folder('/one/file', 'file', 'another-host').uri, root)).toBe(false);
});

it('reports paths relative to the selected parent even when another workspace is nested inside it', () => {
  const parent = folder('/parent');
  const child = folder('/parent/nested');
  env.folders = [parent, child];
  expect(workspaceRelativePath(folder('/parent/nested/same.txt').uri, parent)).toBe('nested/same.txt');
  expect(workspaceRelativePath(folder('/parent/nested/same.txt').uri, child)).toBe('same.txt');
});
