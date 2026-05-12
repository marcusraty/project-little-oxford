import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// Models the AuditEngine dispose contract.
// Bugs under test:
//   #2 — dispose() doesn't track disposed state; processSession can run
//        new jobs after dispose, mutating already-disposed state.
//   #3 — sessionQueues `.catch(() => {})` silently swallows errors from
//        processSessionImpl, hiding real failures (disk full, parse bug).

class FakeEngine {
  private disposed = false;
  private queues = new Map<string, Promise<void>>();
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  public processed: string[] = [];
  public errors: string[] = [];

  // GREEN behavior under test
  async processSession(id: string, impl: () => Promise<void>): Promise<void> {
    if (this.disposed) return;
    const prev = this.queues.get(id) ?? Promise.resolve();
    const job = prev.then(() => {
      if (this.disposed) return;
      return impl();
    }).then(() => { this.processed.push(id); });
    this.queues.set(id, job.catch((e) => {
      this.errors.push((e as Error)?.message ?? String(e));
    }));
    return job;
  }

  scheduleDebounce(fn: () => void, ms: number): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(fn, ms);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.debounceTimer) { clearTimeout(this.debounceTimer); this.debounceTimer = undefined; }
    await Promise.allSettled([...this.queues.values()]);
    this.queues.clear();
  }
}

test('#2 dispose() prevents NEW processSession invocations from running', async () => {
  const engine = new FakeEngine();
  await engine.dispose();
  await engine.processSession('s1', async () => { /* would push */ });
  assert.deepEqual(engine.processed, [], 'disposed engine ignored processSession');
});

test('#2 dispose() drains in-flight queue before returning', async () => {
  const engine = new FakeEngine();
  let resolveImpl: () => void = () => {};
  const impl = () => new Promise<void>((r) => { resolveImpl = r; });
  const p = engine.processSession('s1', impl);
  resolveImpl();
  await engine.dispose();
  await p;
  assert.deepEqual(engine.processed, ['s1'], 'in-flight job completed before dispose returned');
});

test('#2 dispose() cancels the debounce timer', async () => {
  const engine = new FakeEngine();
  let fired = false;
  engine.scheduleDebounce(() => { fired = true; }, 20);
  await engine.dispose();
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(fired, false, 'pending debounce did not fire after dispose');
});

test('#3 sessionQueue rejection is recorded, not silently swallowed', async () => {
  const engine = new FakeEngine();
  // Caller awaits — gets the rejection too.
  await assert.rejects(() => engine.processSession('s1', async () => { throw new Error('disk full'); }));
  // Internal queue must also have captured it for logging.
  await new Promise((r) => setImmediate(r));
  assert.equal(engine.errors.length, 1, 'one error recorded');
  assert.match(engine.errors[0], /disk full/, 'error message preserved');
});

test('#3 one failing job does not poison subsequent jobs on the same session', async () => {
  const engine = new FakeEngine();
  await engine.processSession('s1', async () => { throw new Error('boom'); }).catch(() => {});
  await engine.processSession('s1', async () => { /* ok */ });
  assert.deepEqual(engine.processed, ['s1'], 'second job ran despite first failing');
  assert.equal(engine.errors.length, 1);
});
