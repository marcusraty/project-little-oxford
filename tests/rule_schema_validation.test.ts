import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRules } from '../src/audit/rules';

let tmpDir = '';
afterEach(async () => {
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
});

async function rulesDir(rules: unknown): Promise<string> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-schema-'));
  const dir = path.join(tmpDir, '.oxford', 'rules');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'r.json'), JSON.stringify({ rules }));
  return tmpDir;
}

test('schema: rule with unknown action is rejected', async () => {
  const root = await rulesDir([
    { id: 'OK',  name: 'ok',  kinds: ['text'], action: 'hook',     severity: 'warning' },
    { id: 'BAD', name: 'bad', kinds: ['text'], action: 'destroy',  severity: 'warning' },
  ]);
  const rules = await loadRules(root);
  const ids = rules.map((r) => r.id);
  assert.deepEqual(ids, ['OK']);
});

test('schema: rule with unknown severity is rejected', async () => {
  const root = await rulesDir([
    { id: 'OK',  name: 'ok',  kinds: ['text'], action: 'log', severity: 'info' },
    { id: 'BAD', name: 'bad', kinds: ['text'], action: 'log', severity: 'YOLO' },
  ]);
  const rules = await loadRules(root);
  const ids = rules.map((r) => r.id);
  assert.deepEqual(ids, ['OK']);
});

test('schema: rule with unknown hook is rejected', async () => {
  const root = await rulesDir([
    { id: 'OK',  name: 'ok',  kinds: ['text'], action: 'hook', severity: 'warning', hook: 'Stop' },
    { id: 'BAD', name: 'bad', kinds: ['text'], action: 'hook', severity: 'warning', hook: 'EvilHook' },
  ]);
  const rules = await loadRules(root);
  const ids = rules.map((r) => r.id);
  assert.deepEqual(ids, ['OK']);
});

test('schema: rule with non-string id/name is rejected', async () => {
  const root = await rulesDir([
    { id: 'OK', name: 'ok', kinds: ['text'], action: 'log', severity: 'info' },
    { id: 42,   name: 'x',  kinds: ['text'], action: 'log', severity: 'info' },
    { id: 'X',  name: null, kinds: ['text'], action: 'log', severity: 'info' },
  ]);
  const rules = await loadRules(root);
  assert.deepEqual(rules.map((r) => r.id), ['OK']);
});

test('schema: action and severity defaults are inferred when both missing', async () => {
  // Allow rules with only id+name+kinds; default to action=log, severity=info.
  const root = await rulesDir([
    { id: 'MIN', name: 'minimal', kinds: ['text'] },
  ]);
  const rules = await loadRules(root);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].action, 'log');
  assert.equal(rules[0].severity, 'info');
});
