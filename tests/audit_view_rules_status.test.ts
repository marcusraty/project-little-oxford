import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml } from '../src/vscode_extension/audit_view_html';

test('audit view HTML includes a rules-status span for reload feedback', () => {
  const html = buildHtml();
  assert.match(html, /id="rules-status"/);
});

test('rules-status starts hidden (no reload event yet on first render)', () => {
  const html = buildHtml();
  // Find the rules-status element (attributes in any order) and assert it has the hidden class.
  const match = html.match(/<[a-z]+[^>]*id="rules-status"[^>]*>/);
  assert.ok(match, 'rules-status element exists');
  assert.match(match![0], /class="[^"]*\bhidden\b[^"]*"/);
});

test('audit view HTML handles a rules-reloaded postMessage event', () => {
  const html = buildHtml();
  assert.match(html, /rules-reloaded/);
});
