import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { isPathWithin } from '../src/audit/path_safety';

test('isPathWithin: same directory passes', () => {
  assert.equal(isPathWithin('/Users/m/proj/.oxford/audit.jsonl', '/Users/m/proj/.oxford'), true);
});

test('isPathWithin: nested path passes', () => {
  assert.equal(isPathWithin('/Users/m/proj/.oxford/sub/file', '/Users/m/proj/.oxford'), true);
});

test('isPathWithin: parent escape rejected', () => {
  assert.equal(isPathWithin('/Users/m/proj/.oxford/../../etc/passwd', '/Users/m/proj/.oxford'), false);
});

test('isPathWithin: sibling rejected', () => {
  assert.equal(isPathWithin('/Users/m/proj/elsewhere', '/Users/m/proj/.oxford'), false);
});

test('isPathWithin: prefix-name collision rejected', () => {
  // `/foo/.oxford-evil/x` shares the prefix `/foo/.oxford` as a substring
  // but is NOT inside `/foo/.oxford`. A naive `startsWith` check would pass.
  assert.equal(isPathWithin('/foo/.oxford-evil/x', '/foo/.oxford'), false);
});

test('isPathWithin: exact root passes (the dir itself)', () => {
  assert.equal(isPathWithin('/Users/m/proj/.oxford', '/Users/m/proj/.oxford'), true);
});

test('isPathWithin: trailing slash on either side', () => {
  assert.equal(isPathWithin('/Users/m/proj/.oxford/', '/Users/m/proj/.oxford'), true);
  assert.equal(isPathWithin('/Users/m/proj/.oxford/file', '/Users/m/proj/.oxford/'), true);
});
