// Project Viewer — filesystem watcher on .viewer/model.json.
//
// Watches model.json for any change. The watcher fires whenever the user
// edits the file by hand, or another tool overwrites it, or it's created
// or deleted. We invoke the `onChange` callback on every event so the
// panel can re-render — no manual refresh needed.

import * as vscode from 'vscode';

let watcher: vscode.FileSystemWatcher | undefined;

export function startWatcher(root: string, onChange: () => void): void {
  if (watcher) return;
  const pattern = new vscode.RelativePattern(root, '.viewer/model.json');
  watcher = vscode.workspace.createFileSystemWatcher(pattern);
  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  watcher.onDidDelete(onChange);
}

export function disposeWatcher(): void {
  watcher?.dispose();
  watcher = undefined;
}
