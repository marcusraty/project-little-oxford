// Watches .oxford/model*.json files and re-renders the diagram on
// change. Debounced to absorb VS Code's known double-fire on the
// file-system watcher API.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { triggerRerender } from './panel';
import { MODEL_WATCHER_DEBOUNCE_MS } from './timing';
import type { ExtensionState } from './extension_state';

export async function setupModelWatcher(
  context: vscode.ExtensionContext,
  root: string,
  state: ExtensionState,
): Promise<void> {
  const pattern = new vscode.RelativePattern(root, '.oxford/model*.json');
  state.modelWatcher = vscode.workspace.createFileSystemWatcher(pattern);

  let modelDebounce: ReturnType<typeof setTimeout> | undefined;
  const debouncedRerender = (): void => {
    if (modelDebounce) clearTimeout(modelDebounce);
    modelDebounce = setTimeout(() => {
      modelDebounce = undefined;
      state.log('Model/layout changed — re-rendering');
      void state.auditEngine?.rebuildAnchorMap();
      void triggerRerender();
      vscode.commands.executeCommand('setContext', 'little-oxford.hasModel', true);
    }, MODEL_WATCHER_DEBOUNCE_MS);
  };

  state.modelWatcher.onDidChange(debouncedRerender);
  state.modelWatcher.onDidCreate(debouncedRerender);
  state.modelWatcher.onDidDelete(debouncedRerender);
  context.subscriptions.push(state.modelWatcher);
  context.subscriptions.push({ dispose: () => {
    if (modelDebounce) { clearTimeout(modelDebounce); modelDebounce = undefined; }
  } });

  const modelExists = await fsp.access(path.join(root, '.oxford', 'model.json')).then(() => true).catch(() => false);
  vscode.commands.executeCommand('setContext', 'little-oxford.hasModel', modelExists);
}
