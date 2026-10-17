import * as vscode from 'vscode';
import * as path from 'path';

export function sameWorkspace(a: vscode.WorkspaceFolder, b: vscode.WorkspaceFolder): boolean {
  return a.uri.scheme === b.uri.scheme && a.uri.authority === b.uri.authority && a.uri.fsPath === b.uri.fsPath;
}

/** An explicit folder stays pinned; a removed folder must never fall back to another root. */
export function requireWorkspaceFolder(selected?: vscode.WorkspaceFolder): vscode.WorkspaceFolder {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (selected) {
    if (!folders.some(folder => sameWorkspace(folder, selected))) {
      throw new Error('The selected workspace folder was removed. Select a folder before starting another task.');
    }
    return selected;
  }
  if (!folders.length) throw new Error('No workspace folder is open.');
  if (folders.length !== 1) throw new Error('Choose a workspace folder before starting an agent task.');
  return folders[0];
}

export function isInWorkspace(uri: vscode.Uri, folder: vscode.WorkspaceFolder): boolean {
  if (uri.scheme !== folder.uri.scheme || uri.authority !== folder.uri.authority) return false;
  const relative = path.relative(folder.uri.fsPath, uri.fsPath);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function workspaceLabel(folder: vscode.WorkspaceFolder): string {
  const duplicates = vscode.workspace.workspaceFolders?.filter(candidate => candidate.name === folder.name).length ?? 0;
  return duplicates > 1 ? `${folder.name} (${folder.uri.fsPath})` : folder.name;
}

export function workspaceRelativePath(uri: vscode.Uri, folder: vscode.WorkspaceFolder): string {
  return path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/');
}
