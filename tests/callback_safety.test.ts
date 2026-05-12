import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { invokeCallbacksSafe } from '../src/audit/callbacks';

test('invokeCallbacksSafe: a throwing sync callback does not stop the others', async () => {
  const seen: string[] = [];
  await invokeCallbacksSafe([
    () => { seen.push('a'); },
    () => { throw new Error('boom'); },
    () => { seen.push('c'); },
  ], 'x');
  assert.deepEqual(seen, ['a', 'c']);
});

test('invokeCallbacksSafe: a rejecting async callback does not stop the others', async () => {
  const seen: string[] = [];
  await invokeCallbacksSafe([
    async () => { seen.push('a'); },
    async () => { throw new Error('boom-async'); },
    async () => { seen.push('c'); },
  ], 'x');
  assert.deepEqual(seen.sort(), ['a', 'c']);
});

test('invokeCallbacksSafe: awaits async callbacks (does not return until they all settle)', async () => {
  const seen: string[] = [];
  await invokeCallbacksSafe([
    async () => { await new Promise((r) => setTimeout(r, 20)); seen.push('slow'); },
    () => { seen.push('fast'); },
  ], 'x');
  assert.ok(seen.includes('slow'), 'slow callback completed before return');
  assert.ok(seen.includes('fast'));
});
