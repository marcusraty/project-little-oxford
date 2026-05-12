import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildHtml } from '../src/vscode_extension/audit_view_html';

test('audit view HTML includes a Help element', () => {
  const html = buildHtml();
  assert.match(html, /id="help-link"/);
});

test('audit view HTML wires Help click → open-help postMessage', () => {
  const html = buildHtml();
  assert.match(html, /open-help/);
});

test('audit view HTML labels the Help element with the word Help', () => {
  const html = buildHtml();
  const match = html.match(/<[a-z]+[^>]*id="help-link"[^>]*>([^<]+)<\/[a-z]+>/);
  assert.ok(match, 'help-link element with text content');
  assert.match(match![1], /help/i);
});
