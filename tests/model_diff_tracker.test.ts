import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ModelDiffTracker } from '../src/vscode_extension/model_diff_tracker';
import { RuleEngine } from '../src/audit/rules';

let tmpDir = '';
afterEach(async () => {
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
});

async function makeRoot(model: object): Promise<string> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-mdt-'));
  await fsp.mkdir(path.join(tmpDir, '.oxford'), { recursive: true });
  await fsp.writeFile(path.join(tmpDir, '.oxford/model.json'), JSON.stringify(model), 'utf8');
  return tmpDir;
}

test('ModelDiffTracker: concurrent checks observe consistent cachedModel', async () => {
  const root = await makeRoot({
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
  });
  const ruleEngine = new RuleEngine();
  const tracker = new ModelDiffTracker(root, ruleEngine);
  await tracker.init();

  // Mutate the model 10 times, fire checks concurrently.
  await Promise.all(Array.from({ length: 10 }, async (_, i) => {
    const model = {
      components: {
        a: { kind: 'svc', label: 'A', parent: null },
        ['b' + i]: { kind: 'svc', label: 'B' + i, parent: null },
      },
      relationships: {},
    };
    await fsp.writeFile(path.join(root, '.oxford/model.json'), JSON.stringify(model), 'utf8');
    await tracker.check();
  }));

  // After 10 concurrent checks, the cachedModel must equal the last on-disk
  // state — no stale cache, no torn updates.
  const last = JSON.parse(await fsp.readFile(path.join(root, '.oxford/model.json'), 'utf8'));
  const cached = tracker.getCached();
  assert.deepEqual(cached, last);
});

test('ModelDiffTracker: check returns changed component ids', async () => {
  const root = await makeRoot({
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
  });
  const ruleEngine = new RuleEngine();
  const tracker = new ModelDiffTracker(root, ruleEngine);
  await tracker.init();

  // Add a new component b
  await fsp.writeFile(path.join(root, '.oxford/model.json'), JSON.stringify({
    components: {
      a: { kind: 'svc', label: 'A', parent: null },
      b: { kind: 'svc', label: 'B', parent: null },
    },
    relationships: {},
  }), 'utf8');

  const res = await tracker.check();
  assert.ok(res);
  assert.deepEqual(res.changed, ['b']);
});

test('ModelDiffTracker: returns null when no change', async () => {
  const root = await makeRoot({
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
  });
  const ruleEngine = new RuleEngine();
  const tracker = new ModelDiffTracker(root, ruleEngine);
  await tracker.init();

  const res = await tracker.check();
  assert.equal(res, null);
});
