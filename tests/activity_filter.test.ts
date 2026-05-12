import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { filterActivityToComponents } from '../src/diagram/activity_filter';
import type { ActivityEntry } from '../src/diagram/types';

function entry(): ActivityEntry {
  return { last_read: '2026-01-01T00:00:00.000Z', last_read_session: 's1' };
}

test('filterActivityToComponents: keeps entries whose id is in the set', () => {
  const activity = { a: entry(), b: entry(), c: entry() };
  const r = filterActivityToComponents(activity, ['a', 'c']);
  assert.deepEqual(Object.keys(r).sort(), ['a', 'c']);
});

test('filterActivityToComponents: drops stale entry whose component was deleted', () => {
  // Reproduces the race: activity has a "ghost" component the diagram no
  // longer knows about. Tooltip would otherwise reference a missing node.
  const activity = { ghost: entry(), live: entry() };
  const r = filterActivityToComponents(activity, ['live']);
  assert.deepEqual(Object.keys(r), ['live']);
});

test('filterActivityToComponents: empty activity returns empty', () => {
  assert.deepEqual(filterActivityToComponents({}, ['a', 'b']), {});
});

test('filterActivityToComponents: empty component set drops everything', () => {
  assert.deepEqual(filterActivityToComponents({ a: entry() }, []), {});
});

test('filterActivityToComponents: accepts Set or array', () => {
  const a = { x: entry(), y: entry() };
  assert.deepEqual(filterActivityToComponents(a, new Set(['x'])), { x: entry() });
  assert.deepEqual(filterActivityToComponents(a, ['x']), { x: entry() });
});
