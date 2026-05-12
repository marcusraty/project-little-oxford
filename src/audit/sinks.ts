// D11: this module no longer reaches into vscode_extension/. The monitor
// write hook is injected via the MonitorSink constructor so the audit
// layer stays a leaf with no inbound coupling on the extension layer.
import type { RuleMatch } from './rules';
import { mutateActivity } from '../diagram/activity';
import { formatMonitorLine } from './monitor_line_format';
import type { ProcessResult } from './process_result';
export type { ProcessResult } from './process_result';

export interface RuleSink {
  receive(result: ProcessResult): void | Promise<void>;
}

// Fans a ProcessResult out to every sink in parallel with error isolation.
// One sink throwing or rejecting must not silently kill the others — the
// previous serial-await loop did exactly that.
export async function dispatchToSinks(sinks: RuleSink[], result: ProcessResult): Promise<void> {
  await Promise.allSettled(sinks.map((s) => {
    try {
      return Promise.resolve(s.receive(result));
    } catch (e) {
      return Promise.reject(e);
    }
  }));
}

export type WriteMonitorFn = (root: string, message: string) => Promise<void>;

export class MonitorSink implements RuleSink {
  constructor(private root: string, private writeMessage: WriteMonitorFn) {}

  async receive(result: ProcessResult): Promise<void> {
    // S2: build the full batch of messages first, then write them in a
    // single appendFile call. The previous version did N serial awaited
    // appendFile calls per event, which scaled badly on rule-heavy events.
    const lines: string[] = [];
    for (const m of [...result.ruleMatches, ...result.companionMatches]) {
      if (m.rule.action !== 'hook' && m.rule.action !== 'monitor') continue;
      if (!m.rule.message) continue;
      lines.push(formatMonitorLine(m));
    }
    if (result.modelChanges) {
      for (const u of result.modelChanges.unverified) {
        lines.push(`[UNVERIFIED] Updated ${u.id} in diagram without reading ${u.missingFile}`);
      }
    }
    if (lines.length === 0) return;
    await this.writeMessage(this.root, lines.join('\n'));
  }
}

export class PanelSink implements RuleSink {
  constructor(private pushRuleMatch: (match: RuleMatch) => void) {}

  receive(result: ProcessResult): void {
    for (const m of [...result.ruleMatches, ...result.companionMatches]) {
      this.pushRuleMatch(m);
    }
  }
}

export class StatusBarSink implements RuleSink {
  warnings = 0;
  errors = 0;
  private onUpdate?: (warnings: number, errors: number) => void;

  constructor(onUpdate?: (warnings: number, errors: number) => void) {
    this.onUpdate = onUpdate;
  }

  receive(result: ProcessResult): void {
    for (const m of [...result.ruleMatches, ...result.companionMatches]) {
      if (m.rule.severity === 'warning') this.warnings++;
      if (m.rule.severity === 'error') this.errors++;
    }
    this.onUpdate?.(this.warnings, this.errors);
  }
}

export class ActivitySink implements RuleSink {
  constructor(private root: string) {}

  async receive(result: ProcessResult): Promise<void> {
    if (!result.modelChanges || result.modelChanges.changed.length === 0) return;
    const ts = result.entry.timestamp;
    const changes = result.modelChanges;
    // Serialized via mutateActivity so concurrent ActivitySink + updateActivity
    // calls against the same workspace don't tear-write the file.
    await mutateActivity(this.root, (activity) => {
      for (const id of changes.changed) {
        const existing = activity[id] ?? { last_read: '', last_read_session: '' };
        const isVerified = !changes.unverified.find(u => u.id === id);
        activity[id] = { ...existing, last_model_update: ts, last_model_update_verified: isVerified };
      }
    });
  }
}
