import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRulesReloaded } from '../src/vscode_extension/rules_reloaded_format';

const T0 = 1_700_000_000_000;

test('formatRulesReloaded: under 5s reads as "just reloaded"', () => {
  assert.equal(formatRulesReloaded(T0, 8, T0 + 1_000), '8 rules · just reloaded');
  assert.equal(formatRulesReloaded(T0, 8, T0 + 4_999), '8 rules · just reloaded');
});

test('formatRulesReloaded: seconds for >=5s and <60s', () => {
  assert.equal(formatRulesReloaded(T0, 8, T0 + 5_000), '8 rules · 5s ago');
  assert.equal(formatRulesReloaded(T0, 8, T0 + 59_000), '8 rules · 59s ago');
});

test('formatRulesReloaded: minutes for >=1m and <60m', () => {
  assert.equal(formatRulesReloaded(T0, 8, T0 + 60_000), '8 rules · 1m ago');
  assert.equal(formatRulesReloaded(T0, 8, T0 + 30 * 60_000), '8 rules · 30m ago');
});

test('formatRulesReloaded: hours for >=1h', () => {
  assert.equal(formatRulesReloaded(T0, 8, T0 + 60 * 60_000), '8 rules · 1h ago');
});

test('formatRulesReloaded: singular noun for count=1', () => {
  assert.equal(formatRulesReloaded(T0, 1, T0 + 1_000), '1 rule · just reloaded');
});

test('formatRulesReloaded: count=0 still uses plural "rules"', () => {
  assert.equal(formatRulesReloaded(T0, 0, T0 + 1_000), '0 rules · just reloaded');
});

test('formatRulesReloaded: future timestamps clamp to "just reloaded"', () => {
  assert.equal(formatRulesReloaded(T0 + 1_000, 5, T0), '5 rules · just reloaded');
});
