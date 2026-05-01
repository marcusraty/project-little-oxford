// Project Viewer — VS Code extension entry point.
//
// What's running where:
//   - This file runs in the **extension host** — a Node.js process VS Code
//     spawns when our extension activates. It has full Node APIs (fs, path).
//   - The diagram is drawn by a **webview** — a sandboxed Chromium iframe
//     inside an editor tab. Its source is webview.ts, compiled to
//     dist/webview.js by esbuild.
//   - These run in different processes and can't share JS objects. They
//     talk by passing JSON-serializable messages (`postMessage`).
//
// File layout (this folder):
//   extension.ts    activate() / deactivate() lifecycle hooks (this file)
//   panel.ts        webview panel: HTML shell, IPC, rerender, drag-pin
//   statusbar.ts    the bottom-right pill
//   watcher.ts      fs watcher on .viewer/model.json
//   webview.ts      browser-side code (drag, click, SVG injection)
//
// activate() runs once, when VS Code decides to load us. We asked for that
// to happen on startup via `activationEvents: ["onStartupFinished"]` in
// package.json. `context.subscriptions` is a cleanup list — anything we
// `push` here gets disposed automatically when the extension is unloaded.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { diagramExists, ensureDiagramDir } from '../diagram/storage';
import { disposePanel, showPanel, watchConfigurationChanges } from './panel';
import { createStatusBar } from './statusbar';
import { disposeWatcher } from './watcher';
import { installRecorder, uninstallRecorder } from '../diagnostics';
import { fileSink } from '../diagnostics/sinks/file_sink';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Diagnostics: only wired in debug builds. The `__DEBUG__` constant is
  // injected by esbuild and folds to `false` in prod, so the dynamic
  // imports inside this branch and their transitive deps (file sink,
  // RealRecorder) become tree-shakeable.
  if (__DEBUG__) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      const r = installRecorder();
      r.use(fileSink(path.join(root, '.viewer/in-progress/drag.log')));
      r.emit('host', 'extension-activated', { root });
    }
  }

  // Register a command. Commands are named handlers (here, "projectViewer.show")
  // that the user can invoke from the Command Palette, a keybinding, or
  // — as we wire up below — by clicking the status bar item.
  context.subscriptions.push(
    vscode.commands.registerCommand('projectViewer.show', () => showPanel(context)),
  );

  // Re-render when the user toggles the layout preset (or any other
  // projectViewer.* setting later). Push the disposable into
  // context.subscriptions so VS Code unhooks it on deactivate.
  context.subscriptions.push(watchConfigurationChanges());

  createStatusBar(context);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    await ensureDiagramDir(root);
    // If a diagram already exists in this workspace, auto-open it on
    // load so the user doesn't have to click anything.
    if (await diagramExists(root)) {
      showPanel(context);
    }
  }
}

// deactivate() is the counterpart to activate(). VS Code calls it when the
// extension is unloaded (usually only when VS Code is shutting down or the
// extension is reinstalled). Anything we registered via `context.subscriptions`
// is auto-disposed; we just clean up things we manage manually.
export function deactivate(): void {
  disposeWatcher();
  disposePanel();
  if (__DEBUG__) uninstallRecorder();
}
