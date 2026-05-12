// little-oxford — audit engine (replaces daemon).
//
// Watches CC JSONL transcripts, normalizes events, tracks activity,
// and appends to .oxford/audit.jsonl. Runs in the extension host —
// no child process, no HTTP, no SSE.

import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { Normalizer } from '../audit/normalizer';
import type { AuditEntry, ToolUseContent } from '../audit/types';
import { buildAnchorMap, updateActivity } from '../diagram/activity';
import { readDiagram } from '../diagram/storage';
import { routeActivityPaths } from '../audit/activity_routing';
import { encodeWorkspaceForCC } from '../audit/workspace_encoding';
import { JSONL_WATCHER_DEBOUNCE_MS } from './timing';
import { invokeCallbacksSafe } from '../audit/callbacks';
import { tailLines } from '../audit/tail_lines';
import { BoundedSet } from '../audit/bounded_set';

// Cap dedup memory in long-running sessions. Even with JSONL rotation
// (TODO #7), we don't want unbounded growth in the meantime.
const SEEN_IDS_CAPACITY = 50_000;

interface SessionState {
  normalizer: Normalizer;
  offset: number;
  conversationId: string;
  title: string;
  transcriptPath: string;
}

export type LogFn = (msg: string) => void;

export class AuditEngine {
  private sessions = new Map<string, SessionState>();
  private anchorMap = new Map<string, string[]>();
  private auditLogPath: string;
  private projectId: string;
  private root: string;
  private log: LogFn;
  private jsonlWatcher: vscode.FileSystemWatcher | undefined;
  private debounceSet = new Set<string>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private disposables: vscode.Disposable[] = [];
  private disposed = false;

  private auditCallbacks: Array<(entry: AuditEntry) => void> = [];
  private sessionStartedCallbacks: Array<(file: string) => void> = [];
  private sessionTitleCallbacks: Array<(file: string, title: string) => void> = [];
  private conversationIdCallbacks: Array<(id: string, session: string) => void> = [];
  // Per-session queue so concurrent processSession(sameId) calls serialize.
  // Without this, two overlapping invocations both read the same offset and
  // re-do the same work — seenIds dedup hides the duplicate writes but the
  // read + parse passes are wasted.
  private sessionQueues = new Map<string, Promise<void>>();

  constructor(root: string, log: LogFn) {
    this.root = root;
    this.log = log;
    this.auditLogPath = path.join(root, '.oxford', 'audit.jsonl');
    this.projectId = path.basename(root);
  }

  onAuditEvent(cb: (entry: AuditEntry) => void): void { this.auditCallbacks.push(cb); }
  onSessionStarted(cb: (file: string) => void): void { this.sessionStartedCallbacks.push(cb); }
  onSessionTitle(cb: (file: string, title: string) => void): void { this.sessionTitleCallbacks.push(cb); }
  onConversationId(cb: (id: string, session: string) => void): void { this.conversationIdCallbacks.push(cb); }

  private seenIds = new BoundedSet(SEEN_IDS_CAPACITY);

  async start(): Promise<void> {
    await this.rebuildAnchorMap();
    this.seenIds = await this.loadSeenIds();
    this.startJsonlWatcher();
    await this.discoverExistingSessions();
  }

  // Reads the last N event IDs from audit.jsonl to seed the dedup set on
  // startup. Previously this streamed the WHOLE file (multi-second cold
  // start for large logs). 10k recent IDs is plenty for practical dedup:
  // an event re-emitted from a session whose ID is no longer in the window
  // would simply double-write, and the cost is bounded by the JSONL append
  // rate — not a correctness issue, and rotation (TODO #7) will further
  // reduce the window relevance.
  private async loadSeenIds(): Promise<BoundedSet> {
    const ids = new BoundedSet(SEEN_IDS_CAPACITY);
    const lines = await tailLines(this.auditLogPath, 10000);
    for (const line of lines) {
      try {
        const e = JSON.parse(line);
        if (e.id) ids.add(e.id);
      } catch { /* skip malformed */ }
    }
    return ids;
  }

  getAnchorMap(): Map<string, string[]> { return this.anchorMap; }

  async rebuildAnchorMap(): Promise<void> {
    const diagram = await readDiagram(this.root);
    this.anchorMap = diagram ? buildAnchorMap(diagram) : new Map();
  }

  getJsonlDir(): string {
    return path.join(os.homedir(), '.claude', 'projects', encodeWorkspaceForCC(this.root));
  }

  private startJsonlWatcher(): void {
    const jsonlDir = this.getJsonlDir();
    try {
      const pattern = new vscode.RelativePattern(vscode.Uri.file(jsonlDir), '*.jsonl');
      this.jsonlWatcher = vscode.workspace.createFileSystemWatcher(pattern);

      const onChange = (uri: vscode.Uri) => {
        this.debounceSet.add(uri.fsPath);
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          const files = [...this.debounceSet];
          this.debounceSet.clear();
          for (const f of files) {
            const sessionId = path.basename(f, '.jsonl');
            if (!this.sessions.has(sessionId)) {
              this.registerSession(sessionId, f);
            }
            void this.processSession(sessionId);
          }
        }, JSONL_WATCHER_DEBOUNCE_MS);
      };

      this.jsonlWatcher.onDidChange(onChange);
      this.jsonlWatcher.onDidCreate(onChange);
      this.disposables.push(this.jsonlWatcher);
      this.log(`Watching JSONL dir: ${jsonlDir}`);
    } catch {
      this.log(`Could not watch JSONL dir: ${jsonlDir}`);
    }
  }

  private async discoverExistingSessions(): Promise<void> {
    const jsonlDir = this.getJsonlDir();
    try {
      const files = await fsp.readdir(jsonlDir);
      const jsonls = files.filter((f) => f.endsWith('.jsonl'));
      const stats = await Promise.all(
        jsonls.map(async (f) => {
          const fp = path.join(jsonlDir, f);
          const stat = await fsp.stat(fp);
          return { file: f, path: fp, mtime: stat.mtimeMs };
        }),
      );
      stats.sort((a, b) => b.mtime - a.mtime);
      for (const s of stats) {
        const sessionId = s.file.replace('.jsonl', '');
        this.registerSession(sessionId, s.path);
      }
      if (stats.length > 0) {
        const latestId = stats[0].file.replace('.jsonl', '');
        await this.processSession(latestId);
        this.log(`Discovered ${stats.length} session(s), processing latest: ${latestId.slice(0, 8)}...`);
      }
    } catch {
      this.log('No CC sessions found');
    }
  }

  registerSession(sessionId: string, transcriptPath: string): void {
    if (this.sessions.has(sessionId)) return;
    const session: SessionState = {
      normalizer: new Normalizer(sessionId),
      offset: 0,
      conversationId: '',
      title: '',
      transcriptPath,
    };
    this.sessions.set(sessionId, session);
    void invokeCallbacksSafe(this.sessionStartedCallbacks, sessionId);
  }

  async processSession(sessionId: string): Promise<void> {
    if (this.disposed) return;
    // Chain onto the per-session queue so concurrent calls serialize.
    const prev = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    const job = prev.then(() => {
      if (this.disposed) return;
      return this.processSessionImpl(sessionId);
    });
    // Surface rejections — silently swallowing hid disk-full / parse bugs.
    this.sessionQueues.set(sessionId, job.catch((e) => {
      this.log(`processSession ${sessionId.slice(0, 8)} failed: ${(e as Error)?.message ?? e}`);
    }));
    return job;
  }

  private async processSessionImpl(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    let size: number;
    try {
      const stat = await fsp.stat(session.transcriptPath);
      size = stat.size;
    } catch {
      return;
    }
    if (size <= session.offset) return;

    // AE2: read line-by-line via createReadStream rather than allocating
    // one Buffer the size of the unread tail. If the JSONL grew by 100 MB
    // since the last read, the old code would do `Buffer.alloc(100MB)` in
    // one shot. Streaming holds only the current line in memory.
    const { createReadStream } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const stream = createReadStream(session.transcriptPath, {
      encoding: 'utf8',
      start: session.offset,
      end: size - 1,
    });
    const rl = createInterface({ input: stream });
    const lines: string[] = [];
    for await (const line of rl) {
      if (line.trim()) lines.push(line);
    }
    session.offset = size;
    const newEntries: AuditEntry[] = [];

    try {

      for (const line of lines) {
        // Parse ONCE per line. Previously this parsed the line here to
        // check for custom-title events, then the normalizer parsed it
        // again — doubling the JSON.parse cost on hot paths.
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        if (raw.type === 'custom-title' && typeof raw.customTitle === 'string') {
          session.title = raw.customTitle;
          await invokeCallbacksSafe(this.sessionTitleCallbacks, sessionId, raw.customTitle);
          continue;
        }
        const entries = session.normalizer.normalizeParsed(raw, this.projectId);
        for (const entry of entries) {
          if (!session.conversationId && entry.conversation_id) {
            session.conversationId = entry.conversation_id;
            await invokeCallbacksSafe(this.conversationIdCallbacks, entry.conversation_id, sessionId);
          }
          if (this.seenIds.has(entry.id)) continue;
          this.seenIds.add(entry.id);
          newEntries.push(entry);
          await invokeCallbacksSafe(this.auditCallbacks, entry);
        }
      }

      if (newEntries.length > 0) {
        const logLines = newEntries.map((e) => JSON.stringify(e)).join('\n') + '\n';
        await fsp.appendFile(this.auditLogPath, logLines, 'utf8');
      }
      if (this.anchorMap.size > 0) {
        const { readPaths, readTimestamp, editPaths, editTimestamp } = routeActivityPaths(newEntries);
        if (readPaths.length > 0) await updateActivity(this.root, this.anchorMap, readPaths, readTimestamp, sessionId, 'Read');
        if (editPaths.length > 0) await updateActivity(this.root, this.anchorMap, editPaths, editTimestamp, sessionId, 'Edit');
      }
    } catch (e) {
      // SD2-like: surface errors instead of swallowing.
      // eslint-disable-next-line no-console
      try { console.error('[little-oxford] processSession failed:', (e as Error)?.message ?? e); } catch { /* */ }
    }
  }

  getSessions(): Array<{ id: string; title: string; conversationId: string; transcriptPath: string }> {
    return Array.from(this.sessions.entries()).map(([id, s]) => ({
      id,
      title: s.title,
      conversationId: s.conversationId,
      transcriptPath: s.transcriptPath,
    }));
  }

  async listAllJsonlFiles(): Promise<Array<{ id: string; path: string; mtime: number }>> {
    const jsonlDir = this.getJsonlDir();
    try {
      const files = await fsp.readdir(jsonlDir);
      const jsonls = files.filter((f) => f.endsWith('.jsonl'));
      const results = await Promise.all(
        jsonls.map(async (f) => {
          const fp = path.join(jsonlDir, f);
          const stat = await fsp.stat(fp);
          return { id: f.replace('.jsonl', ''), path: fp, mtime: stat.mtimeMs };
        }),
      );
      results.sort((a, b) => b.mtime - a.mtime);
      return results;
    } catch {
      return [];
    }
  }

  dispose(): void {
    this.disposed = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    for (const d of this.disposables) d.dispose();
    // Drain any in-flight work so callbacks against disposed state can't
    // fire after dispose returns. Promise.allSettled ignores rejections.
    void Promise.allSettled([...this.sessionQueues.values()]).then(() => this.sessionQueues.clear());
  }
}

