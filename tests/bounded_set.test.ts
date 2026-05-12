import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { BoundedSet } from '../src/audit/bounded_set';

test('BoundedSet: holds values under capacity', () => {
  const s = new BoundedSet(3);
  s.add('a'); s.add('b'); s.add('c');
  assert.equal(s.size, 3);
  assert.equal(s.has('a'), true);
});

test('BoundedSet: evicts oldest when capacity exceeded', () => {
  const s = new BoundedSet(3);
  s.add('a'); s.add('b'); s.add('c'); s.add('d');
  assert.equal(s.size, 3);
  assert.equal(s.has('a'), false, 'oldest evicted');
  assert.equal(s.has('d'), true, 'newest retained');
});

test('BoundedSet: re-adding existing value is a no-op (no eviction)', () => {
  const s = new BoundedSet(3);
  s.add('a'); s.add('b'); s.add('c');
  s.add('a');
  assert.equal(s.size, 3);
  assert.equal(s.has('a'), true);
  assert.equal(s.has('b'), true);
  assert.equal(s.has('c'), true);
});

test('BoundedSet: 100k adds stay capped at capacity', () => {
  const s = new BoundedSet(50_000);
  for (let i = 0; i < 100_000; i++) s.add('id-' + i);
  assert.equal(s.size, 50_000);
  assert.equal(s.has('id-0'), false, 'oldest evicted');
  assert.equal(s.has('id-99999'), true, 'newest retained');
});

test('BoundedSet: rejects bad capacity', () => {
  assert.throws(() => new BoundedSet(0));
  assert.throws(() => new BoundedSet(-1));
  assert.throws(() => new BoundedSet(1.5));
});

test('BoundedSet: clear empties the set', () => {
  const s = new BoundedSet(3);
  s.add('a'); s.add('b');
  s.clear();
  assert.equal(s.size, 0);
  assert.equal(s.has('a'), false);
});
