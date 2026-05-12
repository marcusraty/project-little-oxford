// Shared shape returned by RuleEngine.processEntry and consumed by sinks.
// Lives in its own module so rules.ts and sinks.ts don't have to import
// each other (D12 — sinks depends on rules, not the other way around).

import type { AuditEntry } from './types';
import type { RuleMatch } from './rules';

export interface ProcessResult {
  entry: AuditEntry;
  ruleMatches: RuleMatch[];
  companionMatches: RuleMatch[];
  modelChanges?: {
    changed: string[];
    unverified: Array<{ id: string; missingFile: string }>;
  };
  isTurnBoundary: boolean;
  isCompactBoundary: boolean;
}
