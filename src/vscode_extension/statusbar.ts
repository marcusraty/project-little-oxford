// Project Viewer — status bar item ("the pill").
//
// The status bar is the strip along the bottom edge of the VS Code window.
// We put one item on it: a clickable pill that shows the current component
// count and opens the diagram when clicked.

import * as vscode from 'vscode';
import { readDiagram } from '../diagram/storage';

let statusBar: vscode.StatusBarItem | undefined;

// Right-aligned, priority 100 (higher priority = further left within the
// right group). Pushed onto context.subscriptions so VS Code disposes it
// automatically on extension unload.
export function createStatusBar(context: vscode.ExtensionContext): void {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'projectViewer.show';
  statusBar.tooltip = 'Project Viewer — click to open';
  context.subscriptions.push(statusBar);
  void updateStatusBar();
}

// Updates the text shown in the pill. Called on activation and after every
// render. The `$(graph)` syntax is VS Code's way of embedding a Codicon
// icon inline — see https://code.visualstudio.com/api/references/icons-in-labels
//
// Both args are optional: if `componentCount` is omitted, we read the
// diagram from disk to figure it out (used on activation, before any
// render has happened).
export async function updateStatusBar(componentCount?: number, warningCount?: number): Promise<void> {
  if (!statusBar) return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    // No folder open in VS Code → nothing for us to show. Hide the pill
    // so we don't clutter the status bar with an inert item.
    statusBar.hide();
    return;
  }
  if (componentCount === undefined) {
    const d = await readDiagram(root);
    componentCount = d ? Object.keys(d.components ?? {}).length : 0;
  }
  let text = `$(graph) Project Viewer: ${componentCount}`;
  if (warningCount && warningCount > 0) {
    text += ` · ${warningCount} ⚠`;
  }
  statusBar.text = text;
  statusBar.show();
}
