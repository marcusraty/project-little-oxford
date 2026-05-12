import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatMonitorLine } from '../src/audit/monitor_line_format';
import type { RuleMatch, AuditRule } from '../src/audit/rules';
import type { AuditEntry } from '../src/audit/types';

function makeMatch(
  kind: AuditEntry['kind'],
  content: Record<string, unknown> = {},
  ruleOverrides: Partial<AuditRule> = {},
): RuleMatch {
  const rule = {
    id: 'F11', name: 'Test-free implementation', kinds: [kind],
    pattern: 'x', action: 'monitor', severity: 'warning',
    message: 'Write the failing test FIRST.',
    ...ruleOverrides,
  } as AuditRule;
  const entry: AuditEntry = {
    id: 'e1', session_id: 's1', project_id: 'p1', conversation_id: 'c1',
    turn_id: 't1', timestamp: '2026-05-13T00:00:00Z',
    kind, content,
  };
  return { rule, entry } as RuleMatch;
}

test('formatMonitorLine: text kind appears in parens', () => {
  const line = formatMonitorLine(makeMatch('text'));
  assert.equal(line, '[F11] (text) Test-free implementation: Write the failing test FIRST.');
});

test('formatMonitorLine: thinking kind appears in parens', () => {
  const line = formatMonitorLine(makeMatch('thinking'));
  assert.equal(line, '[F11] (thinking) Test-free implementation: Write the failing test FIRST.');
});

test('formatMonitorLine: user_prompt kind appears in parens', () => {
  const line = formatMonitorLine(makeMatch('user_prompt'));
  assert.match(line, /\(user_prompt\)/);
});

test('formatMonitorLine: tool_use with tool_name shows tool_use:Edit', () => {
  const line = formatMonitorLine(makeMatch('tool_use', { tool_name: 'Edit', input: {} }));
  assert.match(line, /\(tool_use:Edit\)/);
});

test('formatMonitorLine: tool_use without tool_name falls back to tool_use', () => {
  const line = formatMonitorLine(makeMatch('tool_use', {}));
  assert.match(line, /\(tool_use\)/);
  assert.doesNotMatch(line, /\(tool_use:/);
});

test('formatMonitorLine: rule id, name, and message still present', () => {
  const line = formatMonitorLine(makeMatch('text'));
  assert.match(line, /\[F11\]/);
  assert.match(line, /Test-free implementation/);
  assert.match(line, /Write the failing test FIRST\./);
});

test('formatMonitorLine: empty message renders without trailing junk', () => {
  const m = makeMatch('text', {}, { message: '' });
  const line = formatMonitorLine(m);
  assert.match(line, /\[F11\] \(text\) Test-free implementation:?/);
});
