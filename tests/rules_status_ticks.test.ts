import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHtml } from '../src/vscode_extension/audit_view_html';

const auditViewSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'audit_view.ts'),
  'utf8',
);
const auditHtml = buildHtml();

// The chip needs to keep ticking ("just reloaded" → "5s ago" → "1m ago" …)
// while the audit panel is open. The host can't keep pushing updates
// indefinitely (and shouldn't), so the webview owns the tick: host sends
// raw timestamp + count, webview re-formats on a setInterval.

test('postRulesReloaded sends raw timestamp + count, not a baked text string', () => {
  const post = auditViewSource.match(/private\s+postRulesReloaded[\s\S]*?\}\s*\n/);
  assert.ok(post, 'postRulesReloaded method exists');
  assert.match(post![0], /timestamp:/);
  assert.match(post![0], /count:/);
  assert.doesNotMatch(post![0], /text:/);
});

test('webview JS sets a setInterval to refresh the rules-status chip', () => {
  assert.match(auditHtml, /setInterval\([^)]*(?:rulesStatus|refreshRulesStatus|formatRulesAgo)/);
});

test('webview JS has a format helper that converts timestamp → relative-time text', () => {
  // Look for a function that produces "just reloaded" / "Ns ago" / "Nm ago".
  assert.match(auditHtml, /just reloaded/);
  assert.match(auditHtml, /s ago/);
  assert.match(auditHtml, /m ago/);
});

test('webview re-renders the chip on the rules-reloaded message using its raw fields', () => {
  // Handler should read msg.timestamp and msg.count from the payload.
  const handlerBlock = auditHtml.match(/msg\.type === ['"]rules-reloaded['"][\s\S]*?\}/);
  assert.ok(handlerBlock, 'rules-reloaded handler block exists');
  assert.match(handlerBlock![0], /msg\.timestamp/);
  assert.match(handlerBlock![0], /msg\.count/);
});
