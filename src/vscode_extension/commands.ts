// All `little-oxford.*` command registrations.
//
// Previously inline inside extension.ts:activate(). Pulled out so:
//   - activate() reads as orchestration, not bookkeeping
//   - the set of commands is in one obvious file
//   - command handlers can be tested in isolation later if desired
//
// Every handler reads runtime state through `state` (ExtensionState),
// not module globals.

import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { loadRules } from '../audit/rules';
import { ALL_DEFAULT_RULES } from '../audit/default_rules';
import { showPanel } from './panel';
import { HELP_COMMAND_ID, helpMenuItems } from './help';
import { initializeProject, getInitState } from './initialize';
import { MONITOR_COPY_TEXT } from './monitor';
import type { ExtensionState } from './extension_state';

export async function reloadRules(state: ExtensionState, root: string): Promise<void> {
  if (!state.ruleEngine) return;
  const fileRules = await loadRules(root);
  state.ruleEngine.setRules(fileRules.length > 0 ? fileRules : ALL_DEFAULT_RULES);
  state.log(`Loaded ${state.ruleEngine.getRules().length} rules from ${fileRules.length > 0 ? 'files' : 'defaults'}`);
}

export function registerCommands(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('little-oxford.show', () => showPanel(context)),

    vscode.commands.registerCommand(HELP_COMMAND_ID, async () => {
      const items = helpMenuItems();
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'How can we help?' });
      if (!pick) return;
      void vscode.env.openExternal(vscode.Uri.parse(pick.url));
    }),

    vscode.commands.registerCommand('little-oxford.pillMenu', async () => {
      const items = [
        { label: '$(symbol-class) Open diagram', command: 'little-oxford.show' },
        { label: '$(question) Get help', command: 'little-oxford.openHelp' },
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'little-oxford' });
      if (!pick) return;
      await vscode.commands.executeCommand(pick.command);
    }),

    vscode.commands.registerCommand('little-oxford.listSessions', async () => {
      if (!state.auditEngine) return;
      const jsonlDir = state.auditEngine.getJsonlDir();
      let files: string[];
      try {
        files = (await fsp.readdir(jsonlDir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        vscode.window.showWarningMessage('little-oxford: No Claude Code sessions found for this project.');
        return;
      }
      if (files.length === 0) {
        vscode.window.showWarningMessage('little-oxford: No Claude Code sessions found.');
        return;
      }
      const stats = await Promise.all(files.map(async (f) => {
        const fp = path.join(jsonlDir, f);
        const stat = await fsp.stat(fp);
        return { file: f, path: fp, mtime: stat.mtimeMs, id: f.replace('.jsonl', '') };
      }));
      stats.sort((a, b) => b.mtime - a.mtime);
      const items = stats.map((s) => ({
        label: s.id,
        description: new Date(s.mtime).toLocaleString(),
        detail: s.path,
      }));
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Select a session to connect' });
      if (pick && state.auditEngine) {
        const s = stats.find((st) => st.id === pick.label)!;
        state.auditEngine.registerSession(s.id, s.path);
        await state.auditEngine.processSession(s.id);
        vscode.window.showInformationMessage(`little-oxford: Connected to session ${s.id}`);
      }
    }),

    vscode.commands.registerCommand('little-oxford.pullAllLogs', async () => {
      if (!state.auditEngine) return;
      const engine = state.auditEngine;
      const jsonlDir = engine.getJsonlDir();
      let files: string[];
      try {
        files = (await fsp.readdir(jsonlDir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        vscode.window.showWarningMessage('little-oxford: No Claude Code sessions found.');
        return;
      }
      const existing = new Set(engine.getSessions().map((s) => s.id));
      const missing = files.filter((f) => !existing.has(f.replace('.jsonl', '')));
      if (missing.length === 0) {
        vscode.window.showInformationMessage('little-oxford: All sessions already processed.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'little-oxford: Processing sessions...' },
        async (progress) => {
          for (let i = 0; i < missing.length; i++) {
            const f = missing[i];
            const id = f.replace('.jsonl', '');
            progress.report({ message: `${i + 1}/${missing.length}`, increment: 100 / missing.length });
            engine.registerSession(id, path.join(jsonlDir, f));
            await engine.processSession(id);
          }
        },
      );
      vscode.window.showInformationMessage(`little-oxford: Processed ${missing.length} session(s).`);
    }),

    vscode.commands.registerCommand('little-oxford.importRules', async () => {
      const root = state.requireWorkspace();
      if (!root) return;
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        filters: { 'Audit Rules': ['json'] },
        title: 'Import audit rules into settings',
      });
      if (!uris || uris.length === 0) return;
      const rulesDir = path.join(root, '.oxford', 'rules');
      await fsp.mkdir(rulesDir, { recursive: true });
      let imported = 0;
      for (const uri of uris) {
        try {
          const content = await fsp.readFile(uri.fsPath, 'utf8');
          JSON.parse(content);
          const dest = path.join(rulesDir, path.basename(uri.fsPath));
          await fsp.copyFile(uri.fsPath, dest);
          imported++;
        } catch {
          vscode.window.showWarningMessage(`little-oxford: ${path.basename(uri.fsPath)} is not a valid rules file.`);
        }
      }
      await reloadRules(state, root);
      vscode.window.showInformationMessage(`little-oxford: Imported ${imported} rule file(s).`);
    }),

    vscode.commands.registerCommand('little-oxford.initialize', async () => {
      const root = state.requireWorkspace();
      if (!root) return;
      await initializeProject(root);
      await reloadRules(state, root);
      state.auditView?.refreshInitState();
      vscode.window.showInformationMessage('little-oxford: Audit engine initialized.');
    }),

    vscode.commands.registerCommand('little-oxford.getInitState', async () => {
      const root = state.requireWorkspace();
      if (!root) return { initialized: false, hasMonitor: false, hasRules: false };
      return getInitState(root);
    }),

    vscode.commands.registerCommand('little-oxford._testCopyMonitorMessage', async () => {
      const root = state.requireWorkspace();
      if (!root) return;
      const s = await getInitState(root);
      if (!s.initialized) return;
      await vscode.env.clipboard.writeText(MONITOR_COPY_TEXT);
    }),

    vscode.commands.registerCommand('little-oxford.bootstrap', async () => {
      const root = state.requireWorkspace();
      if (!root) return;
      const modelPath = path.join(root, '.oxford', 'model.json');
      try {
        await fsp.access(modelPath);
        const overwrite = await vscode.window.showWarningMessage(
          'little-oxford: model.json already exists. Overwrite with starter?',
          'Overwrite', 'Cancel',
        );
        if (overwrite !== 'Overwrite') return;
      } catch { /* doesn't exist, proceed */ }
      const starter = {
        components: {
          app: {
            kind: 'module',
            label: path.basename(root),
            description: 'Main application. Edit this diagram in .oxford/model.json or run your bootstrap agent.',
            parent: null,
          },
        },
        relationships: {},
        rules: { component_styles: { module: { symbol: 'rectangle', color: '#0ea5e9' } } },
        overrides: {},
        _notes: 'Starter diagram. Run bootstrap agent for full architecture.',
      };
      await fsp.mkdir(path.join(root, '.oxford'), { recursive: true });
      await fsp.writeFile(modelPath, JSON.stringify(starter, null, 2) + '\n', 'utf8');
      vscode.window.showInformationMessage('little-oxford: Starter diagram created.');
    }),
  );

  for (const ruleFile of ['behavioral', 'companion']) {
    context.subscriptions.push(
      vscode.commands.registerCommand(`little-oxford.openRuleFile.${ruleFile}`, async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root) return;
        const fp = path.join(root, '.oxford', 'rules', `${ruleFile}.json`);
        const uri = vscode.Uri.file(fp);
        try {
          await vscode.commands.executeCommand('vscode.openWith', uri, 'little-oxford.ruleEditor');
        } catch {
          await vscode.window.showTextDocument(uri);
        }
      }),
    );
  }
}

// Audit-view-specific commands (test-only introspection + reload). The
// audit view doesn't exist until the workspace pipeline is set up, so
// these register after the audit view is constructed rather than alongside
// the global commands.
export function registerAuditViewCommands(
  context: vscode.ExtensionContext,
  state: ExtensionState,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('little-oxford.reloadAuditHistory', async () => {
      await state.auditView?.reload();
    }),
    vscode.commands.registerCommand('little-oxford.getAuditEventCounts', () => {
      return state.auditView?.getEventCounts() ?? {};
    }),
    vscode.commands.registerCommand('little-oxford.getRuleCount', () => {
      return state.ruleEngine ? state.ruleEngine.getRules().length : 0;
    }),
    // D8: deliberately narrow shape; VS Code integration tests rely on
    // these exact fields. Add new commands rather than fields.
    vscode.commands.registerCommand('little-oxford.getRuleDetails', (id: string) => {
      if (!state.ruleEngine) return undefined;
      const rule = state.ruleEngine.getRules().find((r) => r.id === id);
      if (!rule) return undefined;
      return { id: rule.id, name: rule.name, hook: rule.hook, message: rule.message, order: rule.order, action: rule.action, severity: rule.severity };
    }),
  );
}
