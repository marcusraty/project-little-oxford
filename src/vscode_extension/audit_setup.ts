// Wires the audit pipeline: AuditEngine + RuleEngine + sinks +
// ModelDiffTracker. Previously inline in extension.ts:activate().

import * as vscode from 'vscode';
import * as path from 'node:path';
import { AuditEngine } from './audit_engine';
import { loadRules, RuleEngine } from '../audit/rules';
import { ALL_DEFAULT_RULES } from '../audit/default_rules';
import { AuditViewProvider } from './audit_view';
import { writeMonitorMessage } from './monitor';
import { ModelDiffTracker } from './model_diff_tracker';
import { updateStatusBarAudit } from './statusbar';
import type { ToolUseContent } from '../audit/types';
import { MonitorSink, PanelSink, StatusBarSink, ActivitySink, dispatchToSinks, type RuleSink } from '../audit/sinks';
import { setupRulesWatcher } from './rules_watcher_setup';
import type { ExtensionState } from './extension_state';

export async function setupAuditPipeline(
  context: vscode.ExtensionContext,
  root: string,
  state: ExtensionState,
): Promise<void> {
  // Rule engine
  state.ruleEngine = new RuleEngine();
  const userRules = await loadRules(root);
  state.ruleEngine.setRules(userRules.length > 0 ? userRules : ALL_DEFAULT_RULES);
  state.log(`Loaded ${state.ruleEngine.getRules().length} audit rules`);

  // Audit panel
  const auditView = new AuditViewProvider();
  auditView.setRoot(root);
  state.auditView = auditView;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AuditViewProvider.viewType, auditView),
  );

  setupRulesWatcher(context, state, root, auditView);
  auditView.notifyRulesReloaded(state.ruleEngine.getRules().length);

  // Audit engine
  const auditEnabled = vscode.workspace.getConfiguration('little-oxford').get<boolean>('audit.enabled', true);
  state.auditEngine = new AuditEngine(root, state.log);
  auditView.setJsonlDir(state.auditEngine.getJsonlDir());
  auditView.setRuleEngine(state.ruleEngine);
  state.log('Audit engine ready — history loads on panel open');

  const modelTracker = new ModelDiffTracker(root, state.ruleEngine);
  await modelTracker.init();
  state.ruleEngine.setAnchorMap(state.auditEngine.getAnchorMap());

  const sinks: RuleSink[] = [
    new MonitorSink(root, writeMonitorMessage),
    new PanelSink((m) => auditView.pushRuleMatch(m)),
    new StatusBarSink((w, e) => updateStatusBarAudit(w, e)),
    new ActivitySink(root),
  ];

  state.auditEngine.onAuditEvent(async (entry) => {
    // Fire-and-forget UI update; surface rejections instead of letting
    // them become unhandled. Don't await — rule processing shouldn't
    // block on the webview round-trip.
    auditView.pushEvent(entry).catch((e) => {
      state.log(`auditView.pushEvent failed: ${(e as Error)?.message ?? e}`);
    });
    if (!state.ruleEngine) return;

    const result = state.ruleEngine.processEntry(entry);

    if (result.isCompactBoundary) state.log('Context compacted — cleared files-in-context set');
    for (const m of result.ruleMatches) state.log(`Rule ${m.rule.id} (${m.rule.name}): ${m.matchedText}`);

    if (entry.kind === 'tool_use') {
      const tc = entry.content as unknown as ToolUseContent;
      if ((tc.tool_name === 'Edit' || tc.tool_name === 'Write') && tc.input) {
        const fp = (tc.input as Record<string, unknown>).file_path as string;
        if (fp && fp.endsWith(path.join('.oxford', 'model.json'))) {
          const changes = await modelTracker.check();
          if (changes) {
            result.modelChanges = changes;
            for (const u of changes.unverified) state.log(`Unverified model update: ${u.id} (missing read of ${u.missingFile})`);
          }
        }
      }
    }

    await dispatchToSinks(sinks, result);
  });

  state.auditEngine.onConversationId((id, session) => {
    state.log(`Conversation ID: ${id} (session: ${session})`);
  });

  state.auditEngine.onSessionStarted((file) => {
    state.log(`Session started: ${file}`);
    state.ruleEngine?.clearContext();
    const sessions = state.auditEngine!.getSessions();
    const s = sessions.find((ss) => ss.id === file);
    if (s) auditView.addSession(s.id, s.title, s.transcriptPath);
  });

  state.auditEngine.onSessionTitle((file, title) => {
    state.log(`Session title: ${title} (${file})`);
    auditView.updateSessionTitle(file, title);
  });

  if (auditEnabled) {
    await state.auditEngine.start();
    state.log('Audit engine started');
  } else {
    state.log('Audit engine disabled by setting');
  }

  vscode.workspace.onDidChangeConfiguration((e) => {
    if (!e.affectsConfiguration('little-oxford.audit.enabled')) return;
    const enabled = vscode.workspace.getConfiguration('little-oxford').get<boolean>('audit.enabled', true);
    if (enabled && state.auditEngine) {
      void state.auditEngine.start();
      state.log('Audit engine enabled');
    } else if (!enabled && state.auditEngine) {
      state.auditEngine.dispose();
      state.log('Audit engine disabled');
    }
  });
}
