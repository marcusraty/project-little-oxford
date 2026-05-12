import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Normalizer } from '../src/audit/normalizer';

// D15: validate the Normalizer against a redacted slice of a real Claude
// Code transcript. Synthetic fixtures miss schema variations CC actually
// emits (compactMetadata nesting, custom-title events, file-history-snapshot
// skip records, attachments). This catches "the normalizer works on my
// hand-written fixtures but blows up on real data."

// Tests bundle to dist/tests.js; __dirname there points at dist/, not tests/.
// Use cwd which is the project root when npm test runs.
const FIXTURE = path.join(process.cwd(), 'tests', 'fixtures', 'real_cc_redacted.jsonl');

test('normalizer (real fixture): does not throw on any line', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
  const n = new Normalizer('s');
  assert.doesNotThrow(() => {
    for (const line of lines) n.normalize(line, 'p');
  });
});

test('normalizer (real fixture): produces at least one of each user-visible kind', () => {
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
  const n = new Normalizer('s');
  const counts: Record<string, number> = {};
  for (const line of lines) {
    for (const e of n.normalize(line, 'p')) {
      counts[e.kind] = (counts[e.kind] ?? 0) + 1;
    }
  }
  // At minimum we expect: user prompts, assistant text, thinking, and
  // tool_use events all show up. The fixture was sampled to include a
  // diverse slice of a session, so any missing kind here would be a
  // regression in the normalizer's recognition.
  assert.ok((counts.text ?? 0) > 0, `expected text events, got ${counts.text}`);
  assert.ok((counts.thinking ?? 0) > 0, `expected thinking events, got ${counts.thinking}`);
  assert.ok((counts.tool_use ?? 0) > 0, `expected tool_use events, got ${counts.tool_use}`);
});

test('normalizer (real fixture): skip types are honored', () => {
  // file-history-snapshot, permission-mode, last-prompt etc. must produce
  // zero AuditEntry events — they're noise CC emits for its own purposes.
  const lines = fs.readFileSync(FIXTURE, 'utf8').split('\n').filter((l) => l.trim());
  const n = new Normalizer('s');
  let snapshotEvents = 0;
  for (const line of lines) {
    try {
      const raw = JSON.parse(line);
      if (raw.type === 'file-history-snapshot' || raw.type === 'last-prompt') {
        const entries = n.normalize(line, 'p');
        snapshotEvents += entries.length;
      } else {
        n.normalize(line, 'p');
      }
    } catch { /* */ }
  }
  assert.equal(snapshotEvents, 0, 'meta events should be filtered');
});
