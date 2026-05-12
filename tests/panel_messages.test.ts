import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { parsePanelMessage } from '../src/vscode_extension/panel_messages';

const DIAG = 'oxford-diag';

test('parsePanelMessage: rejects non-object input', () => {
  assert.equal(parsePanelMessage(undefined, DIAG), undefined);
  assert.equal(parsePanelMessage(null, DIAG), undefined);
  assert.equal(parsePanelMessage('ready', DIAG), undefined);
  assert.equal(parsePanelMessage(42, DIAG), undefined);
});

test('parsePanelMessage: rejects unknown type', () => {
  assert.equal(parsePanelMessage({ type: 'evil' }, DIAG), undefined);
});

test('parsePanelMessage: ready/reset-layout/open-settings normalize to literal', () => {
  assert.deepEqual(parsePanelMessage({ type: 'ready' }, DIAG), { type: 'ready' });
  assert.deepEqual(parsePanelMessage({ type: 'reset-layout' }, DIAG), { type: 'reset-layout' });
  assert.deepEqual(parsePanelMessage({ type: 'open-settings' }, DIAG), { type: 'open-settings' });
});

test('parsePanelMessage: pin requires string id and finite numbers', () => {
  assert.equal(parsePanelMessage({ type: 'pin' }, DIAG), undefined, 'no id');
  assert.equal(parsePanelMessage({ type: 'pin', id: 'x', x: NaN, y: 0, w: 1, h: 1 }, DIAG), undefined, 'NaN x');
  assert.equal(parsePanelMessage({ type: 'pin', id: 'x', x: Infinity, y: 0, w: 1, h: 1 }, DIAG), undefined, 'Infinity');
  assert.equal(parsePanelMessage({ type: 'pin', id: 'x', x: '0', y: 0, w: 1, h: 1 }, DIAG), undefined, 'string x');
  assert.equal(parsePanelMessage({ type: 'pin', id: 5, x: 0, y: 0, w: 1, h: 1 }, DIAG), undefined, 'numeric id');
});

test('parsePanelMessage: pin accepts valid coords and defaults parentRelative', () => {
  const r = parsePanelMessage({ type: 'pin', id: 'a', x: 1, y: 2, w: 3, h: 4 }, DIAG);
  assert.deepEqual(r, { type: 'pin', id: 'a', x: 1, y: 2, w: 3, h: 4, traceId: undefined, parentRelative: false });
});

test('parsePanelMessage: pin parentRelative true is preserved', () => {
  const r = parsePanelMessage({ type: 'pin', id: 'a', x: 1, y: 2, w: 3, h: 4, parentRelative: true, traceId: 't1' }, DIAG);
  assert.deepEqual(r, { type: 'pin', id: 'a', x: 1, y: 2, w: 3, h: 4, traceId: 't1', parentRelative: true });
});

test('parsePanelMessage: open-anchor requires non-empty string value', () => {
  assert.equal(parsePanelMessage({ type: 'open-anchor' }, DIAG), undefined);
  assert.equal(parsePanelMessage({ type: 'open-anchor', value: '' }, DIAG), undefined);
  assert.equal(parsePanelMessage({ type: 'open-anchor', value: 42 }, DIAG), undefined);
  assert.deepEqual(parsePanelMessage({ type: 'open-anchor', value: 'x' }, DIAG), { type: 'open-anchor', value: 'x' });
});

test('parsePanelMessage: set-active-model requires non-empty string name', () => {
  assert.equal(parsePanelMessage({ type: 'set-active-model' }, DIAG), undefined);
  assert.equal(parsePanelMessage({ type: 'set-active-model', name: '' }, DIAG), undefined);
  assert.deepEqual(parsePanelMessage({ type: 'set-active-model', name: 'foo.json' }, DIAG), { type: 'set-active-model', name: 'foo.json' });
});

test('parsePanelMessage: diag passthrough only for configured type', () => {
  assert.deepEqual(parsePanelMessage({ type: DIAG, event: { foo: 1 } }, DIAG), { type: 'diag', event: { foo: 1 } });
  assert.equal(parsePanelMessage({ type: 'other-diag', event: {} }, DIAG), undefined);
});
