import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// Models the AuditViewProvider.reload() race from audit_view.ts.
//
// Bug: reload() does `eventCounts = {}; await this.readFromFile()` where
// readFromFile re-populates eventCounts as it streams. Two concurrent
// reloads both reset to {} and then race to fill — the result is at best
// double the count, at worst interleaved partial counts. Symptom: when
// the panel re-opens rapidly, badge numbers and the visible event list
// drift.
//
// GREEN: keep an in-flight reload promise. A second reload while one is
// running coalesces — it waits for the current to finish then optionally
// re-runs once (or returns the same promise).

class FakeAuditView {
  private inFlight: Promise<void> | undefined;
  public eventCounts: Record<string, number> = {};
  public readsStarted = 0;
  public readsFinished = 0;
  public readDelayMs = 20;
  // Simulated source — readFromFile counts these.
  public source: Array<{ kind: string }> = [];

  async reload(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        this.readsStarted++;
        this.eventCounts = {};
        // Simulate file IO.
        await new Promise((r) => setTimeout(r, this.readDelayMs));
        for (const e of this.source) {
          this.eventCounts[e.kind] = (this.eventCounts[e.kind] ?? 0) + 1;
        }
        this.readsFinished++;
      } finally {
        this.inFlight = undefined;
      }
    })();
    return this.inFlight;
  }
}

test('reload() serializes: two concurrent calls run a single read', async () => {
  const v = new FakeAuditView();
  v.source = [{ kind: 'text' }, { kind: 'text' }, { kind: 'tool_use' }];
  const a = v.reload();
  const b = v.reload();
  await Promise.all([a, b]);
  assert.equal(v.readsStarted, 1, 'concurrent reload coalesced into one read');
  assert.equal(v.readsFinished, 1);
  assert.deepEqual(v.eventCounts, { text: 2, tool_use: 1 });
});

test('reload() after previous completes: new read runs', async () => {
  const v = new FakeAuditView();
  v.source = [{ kind: 'text' }];
  await v.reload();
  v.source = [{ kind: 'text' }, { kind: 'text' }];
  await v.reload();
  assert.equal(v.readsStarted, 2);
  assert.equal(v.readsFinished, 2);
  assert.deepEqual(v.eventCounts, { text: 2 });
});
