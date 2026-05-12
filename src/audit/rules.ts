// little-oxford — audit rule engine.

import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { AuditEntry, ToolUseContent } from './types';
import type { ProcessResult } from './process_result';

export interface AuditRule {
  id: string;
  name: string;
  description?: string;
  kinds: string[];
  pattern?: string;
  trigger?: string;
  companions?: string[];
  any?: boolean;
  timeout_seconds?: number;
  hook?: 'Stop' | 'PostToolUse' | 'PreToolUse';
  message?: string;
  order?: 'companion_first';
  action: 'notify' | 'hook' | 'monitor' | 'log';
  severity: 'info' | 'warning' | 'error';
}

export interface RuleMatch {
  rule: AuditRule;
  entry: AuditEntry;
  matchedText?: string;
}

export async function loadRules(root: string): Promise<AuditRule[]> {
  const rulesDir = path.join(root, '.oxford', 'rules');
  let files: string[];
  try {
    files = (await fsp.readdir(rulesDir)).filter((f) => f.endsWith('.json'));
  } catch {
    return [];
  }

  const rules: AuditRule[] = [];
  const pushValid = (candidates: unknown[]): void => {
    for (const c of candidates) {
      const v = validateRule(c);
      if (v) rules.push(v);
    }
  };
  for (const file of files) {
    try {
      const raw = await fsp.readFile(path.join(rulesDir, file), 'utf8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        pushValid(parsed);
      } else if (parsed.rules && Array.isArray(parsed.rules)) {
        pushValid(parsed.rules);
      } else {
        const v = validateRule(parsed);
        if (v) rules.push(v);
      }
    } catch { /* skip malformed files */ }
  }
  return rules;
}

const VALID_ACTIONS = new Set(['notify', 'hook', 'monitor', 'log']);
const VALID_SEVERITIES = new Set(['info', 'warning', 'error']);
const VALID_HOOKS = new Set(['Stop', 'PostToolUse', 'PreToolUse']);
const VALID_ORDERS = new Set(['companion_first']);

// Validates a parsed rule and normalizes missing optional fields with
// reasonable defaults. Rules with unknown enum values (action/severity/
// hook/order) are rejected outright — silently accepting them would let
// a malformed `.oxford/rules/*.json` flow into sink-dispatch logic that
// switches on those exact string values.
function validateRule(r: unknown): AuditRule | null {
  if (!r || typeof r !== 'object') return null;
  const obj = r as Record<string, unknown>;
  if (typeof obj.id !== 'string' || obj.id.length === 0) return null;
  if (typeof obj.name !== 'string' || obj.name.length === 0) return null;
  if (!Array.isArray(obj.kinds)) return null;
  if (obj.action !== undefined && (typeof obj.action !== 'string' || !VALID_ACTIONS.has(obj.action))) return null;
  if (obj.severity !== undefined && (typeof obj.severity !== 'string' || !VALID_SEVERITIES.has(obj.severity))) return null;
  if (obj.hook !== undefined && (typeof obj.hook !== 'string' || !VALID_HOOKS.has(obj.hook))) return null;
  if (obj.order !== undefined && (typeof obj.order !== 'string' || !VALID_ORDERS.has(obj.order))) return null;
  return {
    ...(obj as unknown as AuditRule),
    action: (obj.action as AuditRule['action']) ?? 'log',
    severity: (obj.severity as AuditRule['severity']) ?? 'info',
  };
}

function isValidRule(r: unknown): r is AuditRule {
  return validateRule(r) !== null;
}

interface CompanionState {
  timestamp: number;
  alerted: boolean;
}

export class RuleEngine {
  private rules: AuditRule[] = [];
  private compiledPatterns = new Map<string, RegExp>();
  private editedFiles = new Map<string, number>();
  private companionAlerted = new Set<string>();
  private filesInContext = new Set<string>();
  private intentActive = false;
  private filesReadSinceIntent = new Set<string>();
  private anchorMap = new Map<string, string[]>();

  private static readonly INTENT_PATTERN = /update.*model\.?json|update.*diagram|edit.*model\.?json|modify.*model\.?json|modify.*diagram/i;

  setRules(rules: AuditRule[]): void {
    // Compile every rule's regex once here. A rule with an invalid pattern is
    // dropped so it can't break evaluate() with a SyntaxError on every event.
    const accepted: AuditRule[] = [];
    this.compiledPatterns.clear();
    for (const rule of rules) {
      if (rule.pattern) {
        try {
          this.compiledPatterns.set(rule.id, new RegExp(rule.pattern, 'i'));
        } catch {
          continue;
        }
      }
      accepted.push(rule);
    }
    this.rules = accepted;
  }

  setAnchorMap(map: Map<string, string[]>): void {
    this.anchorMap = map;
  }

  resetEditTracking(): void {
    this.editedFiles.clear();
    this.companionAlerted.clear();
    this.intentActive = false;
    this.filesReadSinceIntent.clear();
  }

  getRules(): AuditRule[] {
    return this.rules;
  }

  clearContext(): void {
    this.filesInContext.clear();
    this.intentActive = false;
    this.filesReadSinceIntent.clear();
  }

  isInContext(filePath: string): boolean {
    const key = this.normalizedKey(filePath);
    return this.filesInContext.has(key);
  }

  isIntentDeclared(): boolean {
    return this.intentActive;
  }

  isReadSinceIntent(filePath: string): boolean {
    return this.filesReadSinceIntent.has(this.normalizedKey(filePath));
  }

  verifyModelUpdate(changedComponentIds: string[]): Array<{ id: string; missingFile: string }> {
    const unverified: Array<{ id: string; missingFile: string }> = [];
    for (const compId of changedComponentIds) {
      let hasAnchor = false;
      for (const [anchorFile, compIds] of this.anchorMap) {
        if (!compIds.includes(compId)) continue;
        hasAnchor = true;
        const key = this.normalizedKey(anchorFile);
        if (!this.filesReadSinceIntent.has(key) && !this.filesInContext.has(key)) {
          unverified.push({ id: compId, missingFile: anchorFile });
        }
      }
      if (!hasAnchor) continue;
    }
    return unverified;
  }

  processEntry(entry: AuditEntry): ProcessResult {
    if (entry.kind === 'system' && entry.subtype === 'compact_boundary') {
      this.clearContext();
    }

    const companionMatches = entry.kind === 'user_prompt' ? this.checkCompanions() : [];
    if (entry.kind === 'user_prompt') this.resetEditTracking();

    const ruleMatches = this.evaluate(entry);

    return {
      entry,
      ruleMatches,
      companionMatches,
      isTurnBoundary: entry.kind === 'user_prompt',
      isCompactBoundary: entry.kind === 'system' && entry.subtype === 'compact_boundary',
    };
  }

  evaluate(entry: AuditEntry): RuleMatch[] {
    const matches: RuleMatch[] = [];

    for (const rule of this.rules) {
      if (!rule.kinds.includes(entry.kind)) continue;

      if (rule.pattern) {
        const text = extractText(entry);
        if (!text) continue;
        const re = this.compiledPatterns.get(rule.id);
        if (!re) continue;
        const m = re.exec(text);
        if (m) {
          matches.push({ rule, entry, matchedText: m[0] });
        }
      }
    }

    if ((entry.kind === 'text' || entry.kind === 'thinking') && !this.intentActive) {
      const text = extractText(entry);
      if (text && RuleEngine.INTENT_PATTERN.test(text)) {
        this.intentActive = true;
        this.filesReadSinceIntent.clear();
      }
    }

    if (entry.kind === 'tool_use') {
      const tc = entry.content as unknown as ToolUseContent;
      const tool = tc.tool_name;
      if (tool === 'Read' && tc.input) {
        const fp = (tc.input as Record<string, unknown>).file_path as string | undefined;
        if (fp) {
          const key = this.normalizedKey(fp);
          this.filesInContext.add(key);
          if (this.intentActive) this.filesReadSinceIntent.add(key);
        }
      }
      if ((tool === 'Write' || tool === 'Edit') && tc.input) {
        const fp = (tc.input as Record<string, unknown>).file_path as string | undefined;
        if (fp) this.recordEdit(fp, entry.timestamp);
      }
    }

    return matches;
  }

  checkCompanions(): RuleMatch[] {
    const matches: RuleMatch[] = [];
    const editedEntries = Array.from(this.editedFiles.entries());

    for (const rule of this.rules) {
      if (!rule.trigger || !rule.companions) continue;

      const triggerKey = this.normalizedKey(rule.trigger);
      const triggerMatch = editedEntries.find(([k]) => k === triggerKey || k.startsWith(triggerKey));
      if (!triggerMatch) continue;

      const alertKey = `${rule.id}:${triggerKey}`;
      if (this.companionAlerted.has(alertKey)) continue;

      const companionMatch = (c: string) => {
        const ck = this.normalizedKey(c);
        return editedEntries.find(([k]) => k === ck || k.startsWith(ck));
      };

      const satisfied = rule.any
        ? rule.companions.some((c) => !!companionMatch(c))
        : rule.companions.every((c) => !!companionMatch(c));

      // companion_first: companions should come BEFORE the trigger.
      // Fire when missing (handled below), OR when companion was edited AFTER
      // the trigger (satisfied but wrong order).
      if (rule.order === 'companion_first' && satisfied) {
        const triggerTime = triggerMatch[1];
        const allCompanionsBefore = rule.companions.every((c) => {
          const cm = companionMatch(c);
          return cm && cm[1] < triggerTime;
        });
        if (allCompanionsBefore) continue;
        // Wrong order — fire.
        matches.push({
          rule,
          entry: {
            id: `companion-${rule.id}`,
            session_id: '', project_id: '', conversation_id: '', turn_id: '',
            timestamp: new Date().toISOString(), kind: 'system',
            content: { text: `Edited ${rule.trigger} before ${rule.companions.join(', ')}` },
          },
          matchedText: `${rule.trigger} → companion edited AFTER trigger`,
        });
        this.companionAlerted.add(alertKey);
        continue;
      }

      if (!satisfied) {
        const missing = rule.companions.filter((c) => !companionMatch(c));
        matches.push({
          rule,
          entry: {
            id: `companion-${rule.id}`,
            session_id: '', project_id: '', conversation_id: '', turn_id: '',
            timestamp: new Date().toISOString(), kind: 'system',
            content: { text: `Edited ${rule.trigger}, missing: ${missing.join(', ')}` },
          },
          matchedText: `${rule.trigger} → missing ${missing.join(', ')}`,
        });
        this.companionAlerted.add(alertKey);
      }
    }
    return matches;
  }

  // Records an edit at the entry's own timestamp (parsed to ms epoch).
  // This is what makes companion_first ordering work correctly when historical
  // events are replayed via pullAllLogs — wall-clock Date.now() would collapse
  // them all into one cluster regardless of when they actually occurred.
  private recordEdit(filePath: string, isoTimestamp: string): void {
    const key = this.normalizedKey(filePath);
    const ts = Date.parse(isoTimestamp);
    this.editedFiles.set(key, Number.isNaN(ts) ? Date.now() : ts);
  }

  // R3: a normalized key for matching trigger/companion patterns against
  // edited file paths. Originally only stripped absolute prefixes when the
  // path contained `/src/` or `/tests/` — files outside those directories
  // (package.json, scripts/foo.mjs, .oxford/model.json) kept their full
  // absolute path, so a trigger like `package.json` would never match the
  // recorded edit key `/Users/m/proj/package.json`.
  //
  // Now: strip a known set of project-root markers if present. Otherwise
  // strip to the last 2-3 segments as a best-effort relative path. The
  // ordering (`src/`, `tests/` first) preserves the previous behavior for
  // those most-common cases.
  private static readonly ROOT_MARKERS = ['src/', 'tests/', 'scripts/', '.oxford/'];

  private normalizedKey(fp: string): string {
    for (const marker of RuleEngine.ROOT_MARKERS) {
      const i = fp.lastIndexOf('/' + marker);
      if (i >= 0) return fp.slice(i + 1);
      if (fp.startsWith(marker)) return fp;
    }
    // Top-level file (e.g. /Users/m/proj/package.json): keep only the basename.
    // Trigger/companion patterns matching by basename will work; absolute
    // path collisions across workspaces are not a concern at this scale.
    const slash = fp.lastIndexOf('/');
    return slash >= 0 ? fp.slice(slash + 1) : fp;
  }

  reset(): void {
    this.editedFiles.clear();
    this.companionAlerted.clear();
  }
}

function extractText(entry: AuditEntry): string | undefined {
  const c = entry.content;
  if ('text' in c && typeof c.text === 'string') return c.text;
  return undefined;
}
