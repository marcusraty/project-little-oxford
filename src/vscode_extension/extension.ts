// little-oxford — VS Code extension entry point.
//
// Orchestration only. State lives in ExtensionState; commands in commands.ts;
// audit pipeline in audit_setup.ts; model watcher in model_watcher_setup.ts.

import * as vscode from 'vscode';
import * as path from 'node:path';
import { ensureDiagramDir } from '../diagram/storage';
import { disposePanel, showPanel } from './panel';
import { createStatusBar } from './statusbar';
import { installRecorder, uninstallRecorder } from '../diagnostics';
import { fileSink } from '../diagnostics/sinks/file_sink';
import { outputSink } from '../diagnostics/sinks/output_sink';
import { isMonitorRunning } from './monitor';
import { RuleEditorProvider } from './rule_editor';
import { MONITOR_HEARTBEAT_POLL_MS } from './timing';
import type { AuditEngine } from './audit_engine';
import { ExtensionState } from './extension_state';
import { registerCommands, registerAuditViewCommands } from './commands';
import { setupAuditPipeline } from './audit_setup';
import { setupModelWatcher } from './model_watcher_setup';

let extState: ExtensionState | undefined;

// Test/integration access — the audit engine for assertions or other hooks.
export function getAuditEngine(): AuditEngine | undefined {
  return extState?.auditEngine;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const state = new ExtensionState();
  extState = state;

  const channel = vscode.window.createOutputChannel('little-oxford');
  context.subscriptions.push(channel);
  state.setOutputChannel(channel);
  state.log('Extension activating...');

  if (__DEBUG__) {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (root) {
      const r = installRecorder();
      r.use(fileSink(path.join(root, '.oxford/debug.log')));
      r.use(outputSink(state.log));
      r.emit('host', 'extension-activate', { root });
    }
  }

  // Custom rule editor
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(
      RuleEditorProvider.viewType,
      new RuleEditorProvider(),
      { supportsMultipleEditorsPerDocument: false },
    ),
  );

  registerCommands(context, state);
  createStatusBar(context);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    state.log('No workspace folder open');
    return;
  }

  await ensureDiagramDir(root);
  await setupAuditPipeline(context, root, state);
  registerAuditViewCommands(context, state);
  await setupModelWatcher(context, root, state);

  // One-time relocation of the audit view to the bottom panel.
  // Fire-and-forget — must NOT block activation (focus can hang waiting
  // for the view to render). Surface failures via the log instead of
  // letting executeCommand reject silently.
  if (!context.globalState.get('auditViewMoved')) {
    Promise.resolve(vscode.commands.executeCommand('little-oxford.audit.focus'))
      .then(() => vscode.commands.executeCommand('workbench.action.moveView', { viewId: 'little-oxford.audit', destination: 'workbench.panel.output' }))
      .then(() => context.globalState.update('auditViewMoved', true))
      .then(undefined, (e) => state.log(`Audit view relocation failed: ${(e as Error)?.message ?? e}`));
  }

  showPanel(context);

  // Heartbeat polling: monitor.sh writes a heartbeat file every 2s; we
  // poll at 3s so a single missed write still reads as connected.
  const heartbeatInterval = setInterval(async () => {
    const running = await isMonitorRunning(root);
    state.auditView?.updateMonitorStatus(running);
  }, MONITOR_HEARTBEAT_POLL_MS);
  context.subscriptions.push({ dispose: () => clearInterval(heartbeatInterval) });

  state.log(`Extension activated for workspace: ${root}`);
}

export function deactivate(): void {
  extState?.dispose();
  extState = undefined;
  disposePanel();
  if (__DEBUG__) uninstallRecorder();
}
