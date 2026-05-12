import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeFileAtomic } from '../src/audit/atomic_write';

let tmpDir = '';
afterEach(async () => {
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
});

async function setup(): Promise<string> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-atomic-'));
  return tmpDir;
}

test('writeFileAtomic: writes new file', async () => {
  const dir = await setup();
  const fp = path.join(dir, 'a.txt');
  await writeFileAtomic(fp, 'hello');
  assert.equal(await fsp.readFile(fp, 'utf8'), 'hello');
});

test('writeFileAtomic: replaces existing file', async () => {
  const dir = await setup();
  const fp = path.join(dir, 'b.txt');
  await fsp.writeFile(fp, 'old');
  await writeFileAtomic(fp, 'new');
  assert.equal(await fsp.readFile(fp, 'utf8'), 'new');
});

test('writeFileAtomic: no temp file leaks after success', async () => {
  const dir = await setup();
  const fp = path.join(dir, 'c.txt');
  await writeFileAtomic(fp, 'content');
  const entries = await fsp.readdir(dir);
  // Only the destination file should remain.
  assert.deepEqual(entries, ['c.txt']);
});

test('writeFileAtomic: concurrent writes on the same path serialize without corruption', async () => {
  const dir = await setup();
  const fp = path.join(dir, 'd.txt');
  // 20 writes in flight, each writes a distinct string. The final content
  // should be one of the inputs verbatim — never a half-write mix.
  const inputs = Array.from({ length: 20 }, (_, i) => `content-${i.toString().padStart(4, '0')}`);
  await Promise.all(inputs.map((s) => writeFileAtomic(fp, s)));
  const final = await fsp.readFile(fp, 'utf8');
  assert.ok(inputs.includes(final), `final should be one of the inputs, got ${JSON.stringify(final)}`);
});

test('writeFileAtomic: tolerates non-existent directory by creating it', async () => {
  const dir = await setup();
  const fp = path.join(dir, 'sub', 'nested', 'e.txt');
  await writeFileAtomic(fp, 'value');
  assert.equal(await fsp.readFile(fp, 'utf8'), 'value');
});
