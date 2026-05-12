import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { dispatchToSinks, type RuleSink, type ProcessResult } from '../src/audit/sinks';

function makeResult(): ProcessResult {
  return {
    entry: { id: 'e1', session_id: 's', project_id: 'p', conversation_id: 'c', turn_id: 't', timestamp: '2026-05-11T10:00:00Z', kind: 'text', content: { text: 'hi' } },
    ruleMatches: [],
    companionMatches: [],
    isTurnBoundary: false,
    isCompactBoundary: false,
  };
}

test('dispatchToSinks: throwing sink does not prevent other sinks from receiving', async () => {
  const received: string[] = [];
  const sinks: RuleSink[] = [
    { receive() { received.push('A'); } },
    { receive() { throw new Error('boom'); } },
    { receive() { received.push('C'); } },
  ];
  await dispatchToSinks(sinks, makeResult());
  assert.deepEqual(received, ['A', 'C']);
});

test('dispatchToSinks: async-rejecting sink does not prevent other sinks from receiving', async () => {
  const received: string[] = [];
  const sinks: RuleSink[] = [
    { async receive() { received.push('A'); } },
    { async receive() { throw new Error('boom-async'); } },
    { async receive() { received.push('C'); } },
  ];
  await dispatchToSinks(sinks, makeResult());
  assert.deepEqual(received.sort(), ['A', 'C']);
});

test('dispatchToSinks: all sinks fire in parallel (do not block on slow sinks)', async () => {
  const received: string[] = [];
  const sinks: RuleSink[] = [
    { async receive() { await new Promise(r => setTimeout(r, 50)); received.push('slow'); } },
    { receive() { received.push('fast'); } },
  ];
  const start = Date.now();
  await dispatchToSinks(sinks, makeResult());
  const elapsed = Date.now() - start;
  // If serial: ~50ms (slow runs first then fast). If parallel: ~50ms either way.
  // The order of received tells us — fast should append before slow finishes.
  assert.deepEqual(received, ['fast', 'slow']);
  assert.ok(elapsed < 100, `should resolve in ~50ms (parallel), took ${elapsed}ms`);
});
