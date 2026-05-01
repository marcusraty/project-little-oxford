// Tests for src/vscode_extension/disposables.ts — focused on the
// listener-leak invariant.
//
// The bug under test: webview.ts's `wireDrag` runs on every rerender and
// each time it adds fresh `mousemove` and `mouseup` listeners to `window`
// without removing the previous pair. Disposables groups attachments so
// they can be removed before the next attach.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Disposables } from '../src/vscode_extension/disposables';

test('Disposables: dispose removes a registered listener', () => {
  const target = new EventTarget();
  let count = 0;
  const d = new Disposables();
  d.on(target, 'click', () => {
    count++;
  });
  target.dispatchEvent(new Event('click'));
  assert.equal(count, 1, 'handler fires once before dispose');

  d.dispose();
  target.dispatchEvent(new Event('click'));
  assert.equal(count, 1, 'handler does not fire after dispose');
});

test('Disposables: dispose removes every listener registered through it', () => {
  const target = new EventTarget();
  let a = 0;
  let b = 0;
  const d = new Disposables();
  d.on(target, 'click', () => {
    a++;
  });
  d.on(target, 'click', () => {
    b++;
  });
  target.dispatchEvent(new Event('click'));
  assert.deepEqual([a, b], [1, 1]);

  d.dispose();
  target.dispatchEvent(new Event('click'));
  assert.deepEqual([a, b], [1, 1], 'neither handler fires after dispose');
});

test('Disposables: dispose is idempotent', () => {
  const target = new EventTarget();
  const d = new Disposables();
  d.on(target, 'click', () => {});
  d.dispose();
  d.dispose(); // must not throw
});
