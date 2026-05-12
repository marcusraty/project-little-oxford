// AuditViewProvider — host-side glue for the audit panel webview.
//
// Provider class only. HTML/CSS/JS template lives in audit_view_html.ts;
// per-event format helpers live in audit_view_format.ts.

import * as vscode from 'vscode';
import * as path from 'node:path';
import type { AuditEntry } from '../audit/types';
import type { RuleMatch } from '../audit/rules';
import { recorder } from '../diagnostics';
import { tailLines } from '../audit/tail_lines';
import { isPathWithin } from '../audit/path_safety';
import { buildHtml } from './audit_view_html';
import { toWebviewEvent, toWebviewEventSync, timeAgo, type WebviewEvent } from './audit_view_format';
import { MONITOR_COPY_TEXT } from './monitor';

// Re-export buildHtml so existing tests that import it from this module
// keep working without churn.
export { buildHtml } from './audit_view_html';

interface SessionInfo {
  id: string;
  title: string;
  transcriptPath: string;
  lastEventTime: number;
}

export class AuditViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'little-oxford.audit';

  private view: vscode.WebviewView | undefined;
  private sessions: Map<string, SessionInfo> = new Map();
  private ruleMatches: Map<string, RuleMatch> = new Map();
  private eventCounts: Record<string, number> = {};
  private root: string | undefined;
  private jsonlDir: string | undefined;
  private ruleEngine: { evaluate(entry: AuditEntry): RuleMatch[] } | undefined;
  // AV3: buffer messages that arrive before the webview is ready.
  private pendingMessages: unknown[] = [];
  // Serializes reload() so concurrent panel re-opens don't double-count
  // eventCounts (each reload resets to {} then re-populates).
  private reloadInFlight: Promise<void> | undefined;
  // Survives webview re-attach (panel close/reopen) so the rules-status
  // chip stays visible across panel lifecycle.
  private lastRulesReload: { timestamp: number; count: number } | undefined;

  setRoot(root: string): void { this.root = root; }
  setJsonlDir(dir: string): void { this.jsonlDir = dir; }
  setRuleEngine(engine: { evaluate(entry: AuditEntry): RuleMatch[] }): void { this.ruleEngine = engine; }
  getEventCounts(): Record<string, number> { return { ...this.eventCounts }; }

  async reload(): Promise<void> {
    if (this.reloadInFlight) return this.reloadInFlight;
    this.reloadInFlight = (async () => {
      try {
        this.eventCounts = {};
        this.ruleMatches.clear();
        const events = await this.readFromFile();
        const ruleMatchData = this.buildRuleMatchData();
        if (__DEBUG__) {
          const initKinds: Record<string, number> = {};
          for (const ev of events) initKinds[ev.kind] = (initKinds[ev.kind] ?? 0) + 1;
          recorder.emit('host', 'audit-view-init', { eventCount: events.length, initKinds, sessionCount: this.sessions.size });
        }
        this.postToWebview({ type: 'init', events, sessions: this.getSessionList(), jsonlDir: this.jsonlDir, ruleMatches: ruleMatchData });
      } finally {
        this.reloadInFlight = undefined;
      }
    })();
    return this.reloadInFlight;
  }

  private async readFromFile(): Promise<WebviewEvent[]> {
    if (!this.root) return [];
    const histPath = path.join(this.root, '.oxford', 'audit.jsonl');
    const ring = await tailLines(histPath, 1000);

    const events: WebviewEvent[] = [];
    for (const line of ring) {
      try {
        const entry = JSON.parse(line) as AuditEntry;
        this.eventCounts[entry.kind] = (this.eventCounts[entry.kind] ?? 0) + 1;
        events.push(toWebviewEventSync(entry));
        if (this.ruleEngine) {
          for (const match of this.ruleEngine.evaluate(entry)) {
            this.ruleMatches.set(match.entry.id, match);
          }
        }
      } catch { /* skip malformed */ }
    }
    return events;
  }

  async pushEvent(entry: AuditEntry): Promise<void> {
    const ev = await toWebviewEvent(entry);
    this.eventCounts[entry.kind] = (this.eventCounts[entry.kind] ?? 0) + 1;
    if (__DEBUG__) recorder.emit('host', 'audit-push', { kind: entry.kind, id: entry.id.slice(0, 12) });

    const sess = this.sessions.get(entry.session_id);
    if (sess) sess.lastEventTime = Date.now();

    this.postToWebview({ type: 'event', event: ev });
  }

  updateMonitorStatus(running: boolean): void {
    this.postToWebview({ type: 'monitor-status', running });
  }

  notifyRulesReloaded(count: number, timestamp: number = Date.now()): void {
    this.lastRulesReload = { timestamp, count };
    this.postRulesReloaded();
  }

  getLastRulesReload(): { timestamp: number; count: number } | undefined {
    return this.lastRulesReload ? { ...this.lastRulesReload } : undefined;
  }

  private postRulesReloaded(): void {
    if (!this.lastRulesReload) return;
    this.postToWebview({
      type: 'rules-reloaded',
      timestamp: this.lastRulesReload.timestamp,
      count: this.lastRulesReload.count,
    });
  }

  pushRuleMatch(match: RuleMatch): void {
    this.ruleMatches.set(match.entry.id, match);
    this.postToWebview({
      type: 'rule-match',
      entryId: match.entry.id,
      ruleId: match.rule.id,
      ruleName: match.rule.name,
      severity: match.rule.severity,
      matchedText: match.matchedText,
    });
  }

  addSession(id: string, title: string, transcriptPath: string): void {
    this.sessions.set(id, { id, title: title || id.slice(0, 8) + '...', transcriptPath, lastEventTime: 0 });
    this.postToWebview({ type: 'sessions', sessions: this.getSessionList() });
  }

  updateSessionTitle(id: string, title: string): void {
    const sess = this.sessions.get(id);
    if (sess) { sess.title = title; this.postToWebview({ type: 'sessions', sessions: this.getSessionList() }); }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = buildHtml();
    this.flushPending();
    this.postRulesReloaded();

    webviewView.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'open-jsonl' && typeof msg.path === 'string') {
        if (!this.jsonlDir || !isPathWithin(msg.path, this.jsonlDir)) return;
        const uri = vscode.Uri.file(msg.path);
        vscode.window.showTextDocument(uri, { preview: true }).then((editor) => {
          if (typeof msg.line === 'number' && msg.line > 0) {
            const pos = new vscode.Position(msg.line - 1, 0);
            editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
            editor.selection = new vscode.Selection(pos, pos);
          }
        });
      }
      if (msg.type === 'open-rules' && this.root) {
        const rulesDir = vscode.Uri.file(this.root + '/.oxford/rules');
        vscode.commands.executeCommand('revealInExplorer', rulesDir);
      }
      if (msg.type === 'open-sessions-dir' && this.jsonlDir) {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(this.jsonlDir));
      }
      if (msg.type === 'copy-monitor-command') {
        vscode.env.clipboard.writeText(MONITOR_COPY_TEXT);
        vscode.window.showInformationMessage('Monitor instructions copied — paste into Claude Code chat.');
      }
      if (msg.type === 'open-monitor-feed' && this.root) {
        const feedPath = vscode.Uri.file(this.root + '/.oxford/.monitor_feed');
        vscode.window.showTextDocument(feedPath, { preview: true });
      }
      if (msg.type === 'open-help') {
        void vscode.commands.executeCommand('little-oxford.openHelp');
      }
    });

    void this.reload();
  }

  private buildRuleMatchData(): Record<string, { ruleId: string; ruleName: string; severity: string }> {
    const data: Record<string, { ruleId: string; ruleName: string; severity: string }> = {};
    for (const [entryId, match] of this.ruleMatches) {
      data[entryId] = { ruleId: match.rule.id, ruleName: match.rule.name, severity: match.rule.severity };
    }
    return data;
  }

  private getSessionList(): Array<{ id: string; title: string; path: string; lastLogged: string }> {
    return Array.from(this.sessions.values()).map((s) => ({
      id: s.id,
      title: s.title,
      path: s.transcriptPath,
      lastLogged: s.lastEventTime > 0 ? timeAgo(s.lastEventTime) : 'never',
    }));
  }

  private postToWebview(msg: unknown): void {
    if (this.view) {
      void this.view.webview.postMessage(msg);
    } else {
      this.pendingMessages.push(msg);
      if (this.pendingMessages.length > 500) this.pendingMessages.shift();
    }
  }

  private flushPending(): void {
    if (!this.view || this.pendingMessages.length === 0) return;
    for (const msg of this.pendingMessages) {
      void this.view.webview.postMessage(msg);
    }
    this.pendingMessages = [];
  }
}
