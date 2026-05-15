import * as vscode from 'vscode';
import { reloadRules } from './commands';
import type { ExtensionState } from './extension_state';
import type { AuditViewProvider } from './audit_view';

const DEBOUNCE_MS = 250;

export function setupRulesWatcher(
  context: vscode.ExtensionContext,
  state: ExtensionState,
  root: string,
  auditView: AuditViewProvider,
): void {
  const pattern = new vscode.RelativePattern(root, '.oxford/rules/*.json');
  const watcher = vscode.workspace.createFileSystemWatcher(pattern);

  let timer: ReturnType<typeof setTimeout> | undefined;

  const trigger = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        await reloadRules(state, root);
        const count = state.ruleEngine?.getRules().length ?? 0;
        auditView.notifyRulesReloaded(count);
        await auditView.refreshInitState();
      } catch (e) {
        state.log(`Rules reload failed: ${(e as Error)?.message ?? e}`);
      }
    }, DEBOUNCE_MS);
  };

  watcher.onDidChange(trigger);
  watcher.onDidCreate(trigger);
  watcher.onDidDelete(trigger);

  const monitorWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(root, '.oxford/monitor.sh'),
  );
  const refreshInit = (): void => { void auditView.refreshInitState(); };
  monitorWatcher.onDidCreate(refreshInit);
  monitorWatcher.onDidDelete(refreshInit);

  context.subscriptions.push(watcher);
  context.subscriptions.push(monitorWatcher);
  context.subscriptions.push({
    dispose: () => { if (timer) { clearTimeout(timer); timer = undefined; } },
  });
}
