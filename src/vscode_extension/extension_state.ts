// Mutable state owned by the extension's lifecycle. Replaces the
// previous module-level `let auditEngine` / `let ruleEngine` / etc.
// globals so per-activate state can't leak across reload boundaries
// and so callers (tests, helper modules) can opt into accessing it
// through one explicit handle.

import * as vscode from 'vscode';
import type { AuditEngine } from './audit_engine';
import type { RuleEngine } from '../audit/rules';
import type { AuditViewProvider } from './audit_view';

export type LogFn = (msg: string) => void;

export class ExtensionState {
  auditEngine: AuditEngine | undefined;
  ruleEngine: RuleEngine | undefined;
  outputChannel: vscode.OutputChannel | undefined;
  modelWatcher: vscode.FileSystemWatcher | undefined;
  auditView: AuditViewProvider | undefined;

  log: LogFn = () => { /* no-op until outputChannel is set */ };

  setOutputChannel(c: vscode.OutputChannel): void {
    this.outputChannel = c;
    this.log = (msg: string) => c.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  // Single warning if no workspace is open. Returns the workspace root
  // or undefined; callers should early-return on undefined.
  requireWorkspace(): string | undefined {
    const r = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!r) {
      vscode.window.showWarningMessage('little-oxford: open a workspace folder first.');
      return undefined;
    }
    return r;
  }

  dispose(): void {
    this.auditEngine?.dispose();
    this.modelWatcher?.dispose();
  }
}
