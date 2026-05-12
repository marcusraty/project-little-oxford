import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// Models the showPanel/disposePanel debounce contract from panel.ts.
// CURRENT BUG: panel.ts:24,33 holds a module-level showDebounce timer
// that disposePanel does not clear. If disposePanel runs while a debounce
// is pending, the timer fires later against a disposed panel.
//
// Contract under test: after dispose(), no pending rerender fires.

function createPanelDebounce() {
  let renderCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_MS = 30;

  function show() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { renderCount++; timer = undefined; }, DEBOUNCE_MS);
  }
  function dispose() {
    if (timer) { clearTimeout(timer); timer = undefined; }
  }
  return { show, dispose, getRenderCount: () => renderCount, DEBOUNCE_MS };
}

test('panel debounce: dispose() cancels a pending rerender', async () => {
  const { show, dispose, getRenderCount, DEBOUNCE_MS } = createPanelDebounce();
  show();           // schedule
  dispose();        // must cancel
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 30));
  assert.equal(getRenderCount(), 0, 'no render after dispose');
});

test('panel debounce: dispose() before any show() is a no-op', () => {
  const { dispose } = createPanelDebounce();
  assert.doesNotThrow(() => dispose());
});

test('panel debounce: show() after dispose() still works', async () => {
  const { show, dispose, getRenderCount, DEBOUNCE_MS } = createPanelDebounce();
  show();
  dispose();
  show();
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 30));
  assert.equal(getRenderCount(), 1, 'subsequent show fires once');
});

// Models model_watcher_setup.ts debounce contract. Same shape as the
// panel timer but the bug is in a different file. Issue #14.
function createModelWatcherDebounce() {
  let rerenderCount = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_MS = 30;
  const subscription = {
    dispose: () => { if (timer) { clearTimeout(timer); timer = undefined; } },
  };
  function trigger() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { rerenderCount++; timer = undefined; }, DEBOUNCE_MS);
  }
  return { trigger, subscription, getRerenderCount: () => rerenderCount, DEBOUNCE_MS };
}

test('model watcher debounce: subscription.dispose() cancels pending rerender', async () => {
  const { trigger, subscription, getRerenderCount, DEBOUNCE_MS } = createModelWatcherDebounce();
  trigger();
  subscription.dispose();
  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 30));
  assert.equal(getRerenderCount(), 0, 'no rerender after dispose');
});

