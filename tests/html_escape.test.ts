import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { escapeHtml, escapeAttr } from '../src/audit/html_escape';

test('escapeHtml: covers all five HTML-significant characters', () => {
  assert.equal(escapeHtml('<script>'), '&lt;script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  assert.equal(escapeHtml(`'single'`), '&#39;single&#39;');
  assert.equal(escapeHtml('plain'), 'plain');
});

test('escapeHtml: ampersand-first prevents double-encoding', () => {
  // If we escape & after <, we get "&amp;lt;" which is wrong.
  // Correct: escape & first, then the others.
  assert.equal(escapeHtml('<&>'), '&lt;&amp;&gt;');
});

test('escapeAttr: covers everything escapeHtml does (attribute context is stricter)', () => {
  assert.equal(escapeAttr('<>"\'&'), '&lt;&gt;&quot;&#39;&amp;');
});

test('escapeHtml: tolerates non-string input', () => {
  assert.equal(escapeHtml(null as unknown as string), '');
  assert.equal(escapeHtml(undefined as unknown as string), '');
});
