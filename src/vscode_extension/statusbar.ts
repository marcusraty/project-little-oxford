// little-oxford — status bar item ("the pill").

import * as vscode from 'vscode';
import { readDiagram } from '../diagram/storage';

let statusBar: vscode.StatusBarItem | undefined;
let currentAuditWarnings = 0;
let currentAuditErrors = 0;

export function createStatusBar(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'little-oxford.pillMenu';
  statusBar.tooltip = 'little-oxford — click for diagram, help, etc.';
  context.subscriptions.push(statusBar);

  void updateStatusBar();
}

export async function updateStatusBar(componentCount?: number, warningCount?: number): Promise<void> {
  if (!statusBar) return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    statusBar.hide();
    return;
  }
  if (componentCount === undefined) {
    const d = await readDiagram(root);
    componentCount = d ? Object.keys(d.components ?? {}).length : 0;
  }
  rebuildText(componentCount, warningCount ?? 0);
}

export function updateStatusBarAudit(warnings: number, errors: number): void {
  currentAuditWarnings = warnings;
  currentAuditErrors = errors;
  if (statusBar) rebuildText();
}

let lastComponentCount = 0;
let lastWarningCount = 0;

function rebuildText(componentCount?: number, warningCount?: number): void {
  if (!statusBar) return;
  if (componentCount !== undefined) lastComponentCount = componentCount;
  if (warningCount !== undefined) lastWarningCount = warningCount;

  statusBar.text = 'little-oxford';
  const totalAlerts = currentAuditWarnings + currentAuditErrors;
  statusBar.tooltip = [
    `little-oxford: ${lastComponentCount} components`,
    lastWarningCount > 0 ? `${lastWarningCount} diagram warnings` : null,
    totalAlerts > 0 ? `${totalAlerts} audit alerts (${currentAuditErrors} errors)` : null,
  ].filter(Boolean).join('\n');

  statusBar.backgroundColor = currentAuditErrors > 0
    ? new vscode.ThemeColor('statusBarItem.errorBackground')
    : undefined;

  statusBar.show();
}
