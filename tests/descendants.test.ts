import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { collectDescendants } from '../src/diagram/descendants';

test('collectDescendants: direct children', () => {
  const components = {
    a: { parent: null },
    b: { parent: 'a' },
    c: { parent: 'a' },
  };
  const out = collectDescendants(components, 'a').sort();
  assert.deepEqual(out, ['b', 'c']);
});

test('collectDescendants: 3-level nesting (grandchildren)', () => {
  // a (container)
  //   b (container)
  //     d (leaf)
  //     e (leaf)
  //   c (leaf)
  const components = {
    a: { parent: null },
    b: { parent: 'a' },
    c: { parent: 'a' },
    d: { parent: 'b' },
    e: { parent: 'b' },
  };
  const out = collectDescendants(components, 'a').sort();
  assert.deepEqual(out, ['b', 'c', 'd', 'e'], 'grandchildren d, e must be included');
});

test('collectDescendants: 4-level deep', () => {
  const components = {
    a: { parent: null },
    b: { parent: 'a' },
    c: { parent: 'b' },
    d: { parent: 'c' },
  };
  const out = collectDescendants(components, 'a').sort();
  assert.deepEqual(out, ['b', 'c', 'd']);
});

test('collectDescendants: no descendants returns empty', () => {
  const components = { a: { parent: null } };
  assert.deepEqual(collectDescendants(components, 'a'), []);
});

test('collectDescendants: cycle does not infinite-loop', () => {
  // Pathological input: shouldn't happen via the renderer (it lints cycles)
  // but the function must not hang.
  const components = {
    a: { parent: 'b' },
    b: { parent: 'a' },
  };
  const out = collectDescendants(components, 'a');
  // We don't care about exact result — just that it returns.
  assert.ok(Array.isArray(out));
});

test('collectDescendants: unrelated subtrees ignored', () => {
  const components = {
    a: { parent: null }, b: { parent: 'a' },
    x: { parent: null }, y: { parent: 'x' },
  };
  assert.deepEqual(collectDescendants(components, 'a'), ['b']);
});
