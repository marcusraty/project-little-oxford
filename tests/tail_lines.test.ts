import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { tailLines } from '../src/audit/tail_lines';

let tmpDir = '';
afterEach(async () => {
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
});

async function writeLines(name: string, lines: string[]): Promise<string> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-tail-'));
  const fp = path.join(tmpDir, name);
  await fsp.writeFile(fp, lines.join('\n') + '\n', 'utf8');
  return fp;
}

test('tailLines: returns all lines when file has fewer than N', async () => {
  const fp = await writeLines('small.txt', ['a', 'b', 'c']);
  const out = await tailLines(fp, 1000);
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('tailLines: returns last N lines when file has more', async () => {
  const lines = Array.from({ length: 5000 }, (_, i) => `line${i}`);
  const fp = await writeLines('big.txt', lines);
  const out = await tailLines(fp, 1000);
  assert.equal(out.length, 1000);
  assert.equal(out[0], 'line4000');
  assert.equal(out[999], 'line4999');
});

test('tailLines: returns [] for missing file', async () => {
  const out = await tailLines('/nonexistent/path/file.jsonl', 100);
  assert.deepEqual(out, []);
});

test('tailLines: filters empty lines', async () => {
  const fp = await writeLines('blanks.txt', ['a', '', 'b', '   ', 'c']);
  const out = await tailLines(fp, 100);
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('tailLines: handles file ending without trailing newline', async () => {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-tail-'));
  const fp = path.join(tmpDir, 'no-trailing.txt');
  await fsp.writeFile(fp, 'a\nb\nc', 'utf8'); // no final \n
  const out = await tailLines(fp, 100);
  assert.deepEqual(out, ['a', 'b', 'c']);
});

test('tailLines: large file performance — does not read whole file when N is small', async () => {
  // 100K lines × ~20 bytes each = ~2MB. tailLines should NOT take more than
  // a fraction of a second to extract the last 100 lines.
  const lines = Array.from({ length: 100_000 }, (_, i) => `event-${i.toString().padStart(8, '0')}`);
  const fp = await writeLines('large.jsonl', lines);
  const start = Date.now();
  const out = await tailLines(fp, 100);
  const elapsed = Date.now() - start;
  assert.equal(out.length, 100);
  assert.equal(out[99], 'event-00099999');
  assert.ok(elapsed < 200, `expected <200ms tail of 2MB file, took ${elapsed}ms`);
});
