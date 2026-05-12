import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const scriptPath = join(__dirname, '..', '.oxford', 'monitor.sh');

test('monitor.sh skips feed history on startup (tail -n 0)', () => {
  const script = readFileSync(scriptPath, 'utf8');
  assert.match(
    script,
    /tail\s+(-n\s+0\s+-f|-f\s+-n\s+0)/,
    'monitor.sh should use `tail -n 0 -f` so it only emits events appended after start, not historical lines from prior sessions',
  );
});

test('monitor.sh does not use bare `tail -f` (would replay last 10 lines)', () => {
  const script = readFileSync(scriptPath, 'utf8');
  const bareTailF = /tail\s+-f\s+["']?\$?FEED["']?/.test(script) && !/tail\s+-n\s+0/.test(script);
  assert.equal(bareTailF, false);
});
