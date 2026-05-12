import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RuleEngine } from '../src/audit/rules';
import type { AuditEntry, ToolUseContent } from '../src/audit/types';

function editEntry(filePath: string, timestamp: string): AuditEntry {
  return {
    id: 'e-' + filePath, session_id: 's', project_id: 'p', conversation_id: 'c', turn_id: 't',
    timestamp,
    kind: 'tool_use',
    content: {
      tool_name: 'Edit',
      input: { file_path: filePath },
      touched_paths: [filePath],
    } satisfies ToolUseContent,
  };
}

test('recordEdit uses entry.timestamp: companion_first works on historical events processed out of order', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C-FIRST', name: 'Test before source', kinds: ['tool_use'],
    trigger: 'src/main.ts', companions: ['tests/main.test.ts'], order: 'companion_first',
    hook: 'Stop', message: 'Test first.', action: 'hook', severity: 'warning',
  }]);

  // Real-world history: test was edited at T1, then source at T2 (T2 > T1).
  // We replay them in reverse processing order (the source event arrives first,
  // then the test event) — which is what would happen with Date.now()-based
  // recordEdit. The companion_first check should still see the historical
  // ordering and NOT fire.
  engine.evaluate(editEntry('/p/src/main.ts',          '2026-05-11T10:00:02.000Z'));
  engine.evaluate(editEntry('/p/tests/main.test.ts',   '2026-05-11T10:00:01.000Z'));

  const matches = engine.checkCompanions();
  assert.equal(
    matches.filter(m => m.rule.id === 'C-FIRST').length,
    0,
    'companion_first should not fire when test was edited before source by entry.timestamp',
  );
});

test('recordEdit uses entry.timestamp: companion_first DOES fire when source was edited first by timestamp', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C-FIRST', name: 'Test before source', kinds: ['tool_use'],
    trigger: 'src/main.ts', companions: ['tests/main.test.ts'], order: 'companion_first',
    hook: 'Stop', message: 'Test first.', action: 'hook', severity: 'warning',
  }]);

  // Source first at T1, test later at T2.
  engine.evaluate(editEntry('/p/src/main.ts',          '2026-05-11T10:00:01.000Z'));
  engine.evaluate(editEntry('/p/tests/main.test.ts',   '2026-05-11T10:00:02.000Z'));

  const matches = engine.checkCompanions();
  assert.equal(
    matches.filter(m => m.rule.id === 'C-FIRST').length,
    1,
    'companion_first SHOULD fire when source was edited before test',
  );
});
