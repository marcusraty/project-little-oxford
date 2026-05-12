// Tracks the most-recently-seen model.json so the audit pipeline can compute
// component diffs when the agent edits model.json. Without serialization,
// two concurrent onAuditEvent callbacks would both read the same cachedModel,
// both compute diffs against it, both overwrite — last-write wins and
// intermediate diffs vanish.
//
// `check()` chains every call onto a single Promise so reads/writes of
// cachedModel are ordered.

import { readDiagram } from '../diagram/storage';
import { diffModelComponents } from '../diagram/activity';
import type { Diagram } from '../diagram/types';
import type { RuleEngine } from '../audit/rules';

export interface ModelDiffResult {
  changed: string[];
  unverified: Array<{ id: string; missingFile: string }>;
}

export class ModelDiffTracker {
  private cached: Diagram | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly root: string, private readonly rules: RuleEngine) {}

  async init(): Promise<void> {
    this.cached = await readDiagram(this.root);
  }

  getCached(): Diagram | null {
    return this.cached;
  }

  async check(): Promise<ModelDiffResult | null> {
    let result: ModelDiffResult | null = null;
    const job = this.queue.then(async () => {
      const next = await readDiagram(this.root);
      if (!next || !this.cached) {
        this.cached = next;
        return;
      }
      const changed = diffModelComponents(this.cached, next);
      this.cached = next;
      if (changed.length === 0) return;
      const unverified = this.rules.verifyModelUpdate(changed);
      result = { changed, unverified };
    });
    this.queue = job.catch(() => {});
    await job;
    return result;
  }
}
