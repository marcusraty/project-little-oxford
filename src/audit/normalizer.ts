import type { AuditEntry, ToolUseContent } from './types';

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const XML_TAG_RE = /<[^>]+>/g;

function cleanText(s: string): string {
  return s.replace(ANSI_RE, '').replace(XML_TAG_RE, '').trim();
}

function extractTouchedPaths(toolName: string, input: Record<string, unknown>, result?: unknown): string[] {
  const paths: string[] = [];

  if (input.file_path && typeof input.file_path === 'string') {
    paths.push(input.file_path);
  }
  if (input.path && typeof input.path === 'string') {
    paths.push(input.path);
  }

  if (toolName === 'Bash' && typeof input.command === 'string') {
    const fileArgs = input.command.match(/(?:^|\s)(\/[\w./\-]+|[\w./\-]+\/[\w./\-]+\.\w+)/g);
    if (fileArgs) {
      for (const m of fileArgs) {
        const trimmed = m.trim();
        if (trimmed.includes('/')) paths.push(trimmed);
      }
    }
  }

  if (toolName === 'Grep' || toolName === 'Glob') {
    if (typeof result === 'string') {
      const lines = result.split('\n');
      for (const line of lines) {
        const match = line.match(/^(\/[\w./\-]+|[\w./\-]+\.\w+)/);
        if (match) paths.push(match[1]);
      }
    }
  }

  return [...new Set(paths)];
}

const SKIP_TYPES = new Set([
  'file-history-snapshot',
  'permission-mode',
  'lock',
  'unlock',
  'summary',
  'config',
]);

export class Normalizer {
  private turnId = '';
  private conversationId = '';
  private sessionId: string;
  // Each pending tool_use carries the timestamp it was queued at so the TTL
  // sweep can drop stale ones (tool_use never got a matching tool_result —
  // session ended mid-call, transcript got truncated, etc).
  private pendingToolUse = new Map<string, { entry: AuditEntry; queuedAtMs: number }>();
  // Time-to-live: any pending entry older than this is evicted on each new
  // tool_use. 30 minutes covers normal long-running tool invocations while
  // still bounding memory.
  private static readonly PENDING_TTL_MS = 30 * 60 * 1000;

  constructor(sessionId = '') {
    this.sessionId = sessionId;
  }

  // Test/diagnostics only.
  pendingSize(): number {
    return this.pendingToolUse.size;
  }

  // Parses the line and delegates. Kept for call sites that have a raw
  // JSONL line. Callers that already parsed the line (e.g. the audit
  // engine, which parses to detect custom-title events first) should use
  // normalizeParsed instead to avoid the double-parse.
  normalize(line: string, projectId: string): AuditEntry[] {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      return [];
    }
    return this.normalizeParsed(raw, projectId);
  }

  normalizeParsed(raw: Record<string, unknown>, projectId: string): AuditEntry[] {
    const type = raw.type as string | undefined;
    if (!type || SKIP_TYPES.has(type)) return [];

    const uuid = (raw.uuid as string) ?? '';
    const timestamp = (raw.timestamp as string) ?? new Date().toISOString();
    if (raw.sessionId) this.conversationId = raw.sessionId as string;

    if (type === 'system') {
      const subtype = raw.subtype as string | undefined;
      if (subtype && subtype !== 'compact_boundary') return [];
      const sysContent = raw.message ? (raw.message as Record<string, unknown>).content : raw.content;
      return this.normalizeSystem(uuid, projectId, timestamp, sysContent, subtype, raw.compactMetadata as Record<string, unknown> | undefined);
    }

    const message = raw.message as Record<string, unknown> | undefined;
    if (!message) return [];

    const content = message.content;
    const isMeta = raw.isMeta === true;

    if (type === 'user') {
      return this.normalizeUser(uuid, projectId, timestamp, content, isMeta);
    }
    if (type === 'assistant') {
      return this.normalizeAssistant(uuid, projectId, timestamp, content);
    }

    return [];
  }

  private normalizeUser(
    uuid: string,
    projectId: string,
    timestamp: string,
    content: unknown,
    isMeta: boolean,
  ): AuditEntry[] {
    if (typeof content === 'string' && !isMeta) {
      this.turnId = uuid;
      const text = cleanText(content);
      if (!text) return [];
      return [{
        id: uuid,
        session_id: this.sessionId,
        project_id: projectId,
        conversation_id: this.conversationId,
        turn_id: this.turnId,
        timestamp,
        kind: 'user_prompt',
        content: { text },
      }];
    }

    if (Array.isArray(content)) {
      const results: AuditEntry[] = [];
      for (const block of content) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          const pending = this.pendingToolUse.get(block.tool_use_id);
          if (pending) {
            const tc = pending.entry.content as unknown as ToolUseContent;
            tc.result = block.content ?? block.output ?? null;
            tc.is_error = block.is_error === true;
            const resultPaths = extractTouchedPaths(tc.tool_name, tc.input as Record<string, unknown>, tc.result);
            tc.touched_paths = [...new Set([...(tc.touched_paths ?? []), ...resultPaths])];
            this.pendingToolUse.delete(block.tool_use_id);
            results.push(pending.entry);
          }
          // Note: pending.block is no longer stored; the old code carried
          // it but never used it after the tool_result was found.
        }
      }
      return results;
    }

    return [];
  }

  private normalizeAssistant(
    uuid: string,
    projectId: string,
    timestamp: string,
    content: unknown,
  ): AuditEntry[] {
    if (!Array.isArray(content)) return [];

    const results: AuditEntry[] = [];
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (!block?.type) continue;

      const blockId = `${uuid}-${i}`;

      if (block.type === 'thinking') {
        const text = cleanText(block.thinking ?? '');
        if (!text) continue;
        results.push({
          id: blockId,
          session_id: this.sessionId,
          project_id: projectId,
          conversation_id: this.conversationId,
          turn_id: this.turnId,
          timestamp,
          kind: 'thinking',
          content: { text },
        });
      } else if (block.type === 'text') {
        const text = cleanText(block.text ?? '');
        if (!text) continue;
        results.push({
          id: blockId,
          session_id: this.sessionId,
          project_id: projectId,
          conversation_id: this.conversationId,
          turn_id: this.turnId,
          timestamp,
          kind: 'text',
          content: { text },
        });
      } else if (block.type === 'tool_use') {
        const toolName = block.name ?? '';
        const input = (block.input ?? {}) as Record<string, unknown>;
        // N2: block.id must be a non-empty string. Without this guard,
        // multiple tool_uses with missing IDs would collapse to a single
        // pendingToolUse entry keyed by `undefined`, losing all but the
        // last one — and the matching tool_result lookup would fail too.
        const pendingKey = typeof block.id === 'string' && block.id.length > 0
          ? block.id
          : null;
        const entry: AuditEntry = {
          id: pendingKey ?? blockId,
          session_id: this.sessionId,
          project_id: projectId,
          conversation_id: this.conversationId,
          turn_id: this.turnId,
          timestamp,
          kind: 'tool_use',
          content: {
            tool_name: toolName,
            input,
            touched_paths: extractTouchedPaths(toolName, input),
          } satisfies ToolUseContent,
          raw_event: block,
        };
        if (!pendingKey) {
          // Can't track this tool_use against a future tool_result. Emit
          // the entry immediately rather than dropping it.
          results.push(entry);
          continue;
        }
        // Evict any pending entries that have outlived the TTL before
        // inserting the new one. Done lazily here (rather than via a timer)
        // so the Normalizer has no background work.
        this.evictStalePending(Date.parse(timestamp));
        const queuedAtMs = Date.parse(timestamp);
        this.pendingToolUse.set(pendingKey, {
          entry,
          queuedAtMs: Number.isNaN(queuedAtMs) ? Date.now() : queuedAtMs,
        });
      }
    }
    return results;
  }

  private normalizeSystem(
    uuid: string,
    projectId: string,
    timestamp: string,
    content: unknown,
    subtype?: string,
    compactMetadata?: Record<string, unknown>,
  ): AuditEntry[] {
    let raw = '';
    if (typeof content === 'string') {
      raw = content;
    } else if (Array.isArray(content)) {
      raw = content
        .filter((b: Record<string, unknown>) => b?.type === 'text')
        .map((b: Record<string, unknown>) => b.text as string)
        .join('\n');
    }
    const text = cleanText(raw);
    if (!text && subtype !== 'compact_boundary') return [];

    const entry: AuditEntry = {
      id: uuid,
      session_id: this.sessionId,
      project_id: projectId,
      conversation_id: this.conversationId,
      turn_id: this.turnId,
      timestamp,
      kind: 'system',
      content: compactMetadata ? { text: text || 'Conversation compacted', compactMetadata } : { text },
    };
    if (subtype) entry.subtype = subtype;

    return [entry];
  }

  flush(): AuditEntry[] {
    const remaining = Array.from(this.pendingToolUse.values()).map((p) => p.entry);
    this.pendingToolUse.clear();
    return remaining;
  }

  private evictStalePending(nowMs: number): void {
    if (Number.isNaN(nowMs)) return;
    const cutoff = nowMs - Normalizer.PENDING_TTL_MS;
    for (const [k, v] of this.pendingToolUse) {
      if (v.queuedAtMs < cutoff) this.pendingToolUse.delete(k);
    }
  }
}
