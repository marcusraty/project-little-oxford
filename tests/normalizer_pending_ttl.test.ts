import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Normalizer } from '../src/audit/normalizer';

function userLine(uuid: string): string {
  return JSON.stringify({
    uuid, type: 'user', isMeta: false,
    timestamp: '2026-05-11T10:00:00Z',
    sessionId: 's',
    message: { role: 'user', content: 'go' },
  });
}

function assistantToolUseLine(uuid: string, toolUseId: string, timestamp: string): string {
  return JSON.stringify({
    uuid, type: 'assistant',
    timestamp,
    sessionId: 's',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: { file_path: '/x' } }],
    },
  });
}

test('Normalizer.pendingSize: drops entries older than the TTL', () => {
  const n = new Normalizer('s');
  n.normalize(userLine('u1'), 'p');

  // 200 tool_uses, none get a matching tool_result. They pile up in
  // pendingToolUse. With a 30-min TTL and timestamps spaced minutes apart,
  // the oldest fall off as we add new ones.
  for (let i = 0; i < 200; i++) {
    const ts = new Date(Date.now() + i * 60_000).toISOString();
    n.normalize(assistantToolUseLine(`a${i}`, `tu${i}`, ts), 'p');
  }
  // Without TTL, pending would be 200. With TTL of ~30 min, capped at ~30.
  const size = n.pendingSize();
  assert.ok(size < 200, `pending should be capped (got ${size})`);
  assert.ok(size > 0, 'some recent entries should remain');
});

test('Normalizer.pendingSize: fresh tool_use without tool_result stays in map', () => {
  const n = new Normalizer('s');
  n.normalize(userLine('u1'), 'p');
  n.normalize(assistantToolUseLine('a1', 'tu1', new Date().toISOString()), 'p');
  assert.equal(n.pendingSize(), 1);
});
