import { test } from 'node:test';
import * as assert from 'node:assert/strict';

// Models the showPanel → rerender path from panel.ts.
// Currently showPanel calls `void rerender()` immediately on every call.
// The fix adds a debounce so rapid calls coalesce.

// Toggle this to false to simulate the CURRENT (broken) behavior.
const USE_DEBOUNCE = true;

function createShowPanel() {
  let renderCount = 0;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  const DEBOUNCE_MS = 80;

  function showPanelRerender() {
    if (USE_DEBOUNCE) {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => { renderCount++; }, DEBOUNCE_MS);
    } else {
      renderCount++;
    }
  }

  return { showPanelRerender, getRenderCount: () => renderCount, DEBOUNCE_MS };
}

test('rapid showPanel calls coalesce into a single rerender', async () => {
  const { showPanelRerender, getRenderCount, DEBOUNCE_MS } = createShowPanel();

  for (let i = 0; i < 5; i++) {
    showPanelRerender();
  }

  await new Promise((r) => setTimeout(r, DEBOUNCE_MS + 50));
  assert.equal(getRenderCount(), 1, `expected 1 render but got ${getRenderCount()}`);
});

test('spaced showPanel calls each trigger a render', async () => {
  const { showPanelRerender, getRenderCount, DEBOUNCE_MS } = createShowPanel();

  showPanelRerender();
  await new Promise((r) => setTimeout(r, USE_DEBOUNCE ? DEBOUNCE_MS + 20 : 0));
  assert.equal(getRenderCount(), 1, 'first render');

  showPanelRerender();
  await new Promise((r) => setTimeout(r, USE_DEBOUNCE ? DEBOUNCE_MS + 20 : 0));
  assert.equal(getRenderCount(), 2, 'second render after gap');
});
