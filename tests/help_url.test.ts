import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP_EMAIL, helpMailtoUrl } from '../src/vscode_extension/help';

test('HELP_EMAIL is set', () => {
  assert.ok(HELP_EMAIL.length > 0);
  assert.match(HELP_EMAIL, /@/);
});

test('helpMailtoUrl builds a mailto with the right address', () => {
  const url = helpMailtoUrl();
  assert.ok(url.startsWith('mailto:'));
  assert.ok(url.includes(HELP_EMAIL));
});

test('helpMailtoUrl includes a subject line', () => {
  const url = helpMailtoUrl();
  assert.match(url, /[?&]subject=/);
  assert.match(url, /little-oxford/i);
});

test('helpMailtoUrl URL-encodes the subject', () => {
  const url = helpMailtoUrl();
  // No literal unencoded space in the URL.
  assert.equal(url.indexOf(' '), -1);
});
