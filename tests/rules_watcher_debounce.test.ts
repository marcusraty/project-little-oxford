import { test } from 'node:test';
import assert from 'node:assert/strict';

// Models the setupRulesWatcher debounce + reload-and-notify contract.
//
// Contract under test:
// 1. Rapid file events within debounce window collapse to ONE reload call.
// 2. After reload, auditView.notifyRulesReloaded is called with the
//    current rule count.
// 3. dispose() cancels a pending debounced fire.

function createRulesWatcherDebounce() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_MS = 30;
  let reloadCount = 0;
  let notifyCount = 0;
  let lastNotifiedCount: number | undefined;
  let currentRuleCount = 0;

  function trigger() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      timer = undefined;
      reloadCount++;
      await new Promise((r) => setImmediate(r));
      notifyCount++;
      lastNotifiedCount = currentRuleCount;
    }, DEBOUNCE_MS);
  }
  function dispose() {
    if (timer) { clearTimeout(timer); timer = undefined; }
  }
  function setRuleCount(n: number) { currentRuleCount = n; }

  return {
    trigger, dispose, setRuleCount,
    getReloadCount: () => reloadCount,
    getNotifyCount: () => notifyCount,
    getLastNotifiedCount: () => lastNotifiedCount,
    DEBOUNCE_MS,
  };
}

test('rules watcher: three rapid events collapse to one reload', async () => {
  const w = createRulesWatcherDebounce();
  w.setRuleCount(8);
  w.trigger();
  w.trigger();
  w.trigger();
  await new Promise((r) => setTimeout(r, w.DEBOUNCE_MS + 30));
  assert.equal(w.getReloadCount(), 1, 'one reload despite three triggers');
  assert.equal(w.getNotifyCount(), 1, 'one notify');
  assert.equal(w.getLastNotifiedCount(), 8, 'notify carries current rule count');
});

test('rules watcher: dispose cancels pending fire', async () => {
  const w = createRulesWatcherDebounce();
  w.trigger();
  w.dispose();
  await new Promise((r) => setTimeout(r, w.DEBOUNCE_MS + 30));
  assert.equal(w.getReloadCount(), 0);
  assert.equal(w.getNotifyCount(), 0);
});

test('rules watcher: two events spaced apart fire twice', async () => {
  const w = createRulesWatcherDebounce();
  w.setRuleCount(5);
  w.trigger();
  await new Promise((r) => setTimeout(r, w.DEBOUNCE_MS + 30));
  w.setRuleCount(7);
  w.trigger();
  await new Promise((r) => setTimeout(r, w.DEBOUNCE_MS + 30));
  assert.equal(w.getReloadCount(), 2);
  assert.equal(w.getNotifyCount(), 2);
  assert.equal(w.getLastNotifiedCount(), 7);
});

test('rules watcher: dispose with no pending fire is a no-op', () => {
  const w = createRulesWatcherDebounce();
  assert.doesNotThrow(() => w.dispose());
});
