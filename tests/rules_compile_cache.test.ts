import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { RuleEngine } from '../src/audit/rules';
import type { AuditEntry } from '../src/audit/types';

function entry(text: string): AuditEntry {
  return {
    id: 'e-' + Math.random().toString(36).slice(2),
    session_id: 's', project_id: 'p', conversation_id: 'c', turn_id: 't',
    timestamp: '2026-05-11T00:00:00Z', kind: 'text', content: { text },
  };
}

test('regex cache: RegExp constructor called once per setRules, not per evaluate', () => {
  const original = global.RegExp;
  let constructorCalls = 0;
  // Patch the constructor so we can count instantiations.
  const Patched = function PatchedRegExp(pattern: string, flags?: string) {
    constructorCalls++;
    return new original(pattern, flags);
  } as unknown as typeof RegExp;
  (Patched as unknown as { prototype: object }).prototype = original.prototype;
  (global as unknown as { RegExp: typeof RegExp }).RegExp = Patched;

  try {
    const engine = new RuleEngine();
    engine.setRules([
      { id: 'R1', name: 'r1', kinds: ['text'], pattern: 'foo', action: 'log', severity: 'info' },
      { id: 'R2', name: 'r2', kinds: ['text'], pattern: 'bar', action: 'log', severity: 'info' },
    ]);
    const callsAfterSet = constructorCalls;

    for (let i = 0; i < 100; i++) {
      engine.evaluate(entry('foo bar baz ' + i));
    }
    const callsAfterEvaluates = constructorCalls;

    // Each rule's regex should be compiled at most once when setRules is called.
    // No regex compilation per evaluate.
    assert.equal(callsAfterEvaluates, callsAfterSet,
      `expected no further regex compiles during evaluate (saw ${callsAfterEvaluates - callsAfterSet})`);
    assert.ok(callsAfterSet <= 4,
      `expected at most 4 compiles from 2 rules (setRules + INTENT_PATTERN), got ${callsAfterSet}`);
  } finally {
    global.RegExp = original;
  }
});

test('regex cache: setRules re-compiles when rules change', () => {
  const engine = new RuleEngine();
  engine.setRules([
    { id: 'R1', name: 'r1', kinds: ['text'], pattern: 'foo', action: 'log', severity: 'info' },
  ]);
  const m1 = engine.evaluate(entry('foo here'));
  assert.equal(m1.length, 1);

  // Replace rules — should now match different pattern
  engine.setRules([
    { id: 'R2', name: 'r2', kinds: ['text'], pattern: 'bar', action: 'log', severity: 'info' },
  ]);
  const m2 = engine.evaluate(entry('foo here'));
  assert.equal(m2.length, 0, 'old rule no longer matches');
  const m3 = engine.evaluate(entry('bar here'));
  assert.equal(m3.length, 1, 'new rule matches');
});

test('regex cache: invalid regex pattern is dropped, doesnt poison engine', () => {
  const engine = new RuleEngine();
  // Should not throw on setRules, should not break subsequent evaluates
  engine.setRules([
    { id: 'BAD', name: 'invalid pattern', kinds: ['text'], pattern: '(unclosed', action: 'log', severity: 'info' },
    { id: 'GOOD', name: 'valid pattern', kinds: ['text'], pattern: 'hello', action: 'log', severity: 'info' },
  ]);
  const matches = engine.evaluate(entry('hello world'));
  // Bad rule is dropped; good rule still fires
  assert.ok(matches.some(m => m.rule.id === 'GOOD'));
  assert.ok(!matches.some(m => m.rule.id === 'BAD'));
});
