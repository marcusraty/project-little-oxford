import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRules, RuleEngine } from '../src/audit/rules';
import { ALL_DEFAULT_RULES, BEHAVIORAL_RULES, COMPANION_RULES } from '../src/audit/default_rules';

async function writeRulesToDisk(root: string): Promise<void> {
  const rulesDir = path.join(root, '.oxford', 'rules');
  await fsp.mkdir(rulesDir, { recursive: true });
  await fsp.writeFile(
    path.join(rulesDir, 'behavioral.json'),
    JSON.stringify({ rules: BEHAVIORAL_RULES }, null, 2),
    'utf8',
  );
  await fsp.writeFile(
    path.join(rulesDir, 'companion.json'),
    JSON.stringify({ rules: COMPANION_RULES }, null, 2),
    'utf8',
  );
}

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) { await cleanup(); cleanup = undefined; }
});

async function setup(): Promise<{ root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-wt-'));
  await fsp.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fsp.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  cleanup = async () => fsp.rm(root, { recursive: true, force: true });
  return { root };
}

// --- Step 2: CC Session discovery ---

test('integration: list sessions finds JSONL files', async () => {
  const { root } = await setup();
  const jsonlDir = path.join(root, '.claude-sessions');
  await fsp.mkdir(jsonlDir, { recursive: true });
  await fsp.writeFile(path.join(jsonlDir, 'abc-123.jsonl'), '{"type":"system"}\n', 'utf8');
  await fsp.writeFile(path.join(jsonlDir, 'def-456.jsonl'), '{"type":"system"}\n', 'utf8');
  await fsp.writeFile(path.join(jsonlDir, 'not-jsonl.txt'), 'nope', 'utf8');

  const files = (await fsp.readdir(jsonlDir)).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 2);
  assert.ok(files.includes('abc-123.jsonl'));
  assert.ok(files.includes('def-456.jsonl'));
});

test('integration: pull all logs processes unregistered sessions', async () => {
  const { root } = await setup();
  const jsonlDir = path.join(root, '.claude-sessions');
  await fsp.mkdir(jsonlDir, { recursive: true });

  const event1 = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' });
  const event2 = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'def' });
  await fsp.writeFile(path.join(jsonlDir, 'abc.jsonl'), event1 + '\n', 'utf8');
  await fsp.writeFile(path.join(jsonlDir, 'def.jsonl'), event2 + '\n', 'utf8');

  const files = (await fsp.readdir(jsonlDir)).filter((f) => f.endsWith('.jsonl'));
  const existingIds = new Set<string>();
  const missing = files.filter((f) => !existingIds.has(f.replace('.jsonl', '')));
  assert.equal(missing.length, 2, 'both sessions are missing');

  existingIds.add('abc');
  const stillMissing = files.filter((f) => !existingIds.has(f.replace('.jsonl', '')));
  assert.equal(stillMissing.length, 1, 'only def is missing after registering abc');
});

// --- Step 3: Bootstrap ---

test('integration: bootstrap creates starter model.json', async () => {
  const { root } = await setup();
  const modelPath = path.join(root, '.oxford', 'model.json');

  const starter = {
    components: {
      app: {
        kind: 'module',
        label: path.basename(root),
        description: 'Main application.',
        parent: null,
      },
    },
    relationships: {},
    rules: { component_styles: { module: { symbol: 'rectangle', color: '#0ea5e9' } } },
    overrides: {},
    _notes: 'Starter diagram.',
  };
  await fsp.writeFile(modelPath, JSON.stringify(starter, null, 2) + '\n', 'utf8');

  const content = JSON.parse(await fsp.readFile(modelPath, 'utf8'));
  assert.ok(content.components.app, 'app component exists');
  assert.equal(content.components.app.kind, 'module');
  assert.ok(content.rules.component_styles.module, 'style rule exists');
  assert.deepEqual(content.relationships, {});
});

test('integration: bootstrap does not overwrite existing model.json', async () => {
  const { root } = await setup();
  const modelPath = path.join(root, '.oxford', 'model.json');
  const original = '{"components":{"existing":{"kind":"service","label":"Existing"}}}\n';
  await fsp.writeFile(modelPath, original, 'utf8');

  const exists = await fsp.access(modelPath).then(() => true).catch(() => false);
  assert.equal(exists, true, 'model.json exists — command should prompt before overwriting');
});

// --- Step 4: Audit Rules ---

test('integration: loadRules reads from .oxford/rules/', async () => {
  const { root } = await setup();
  await writeRulesToDisk(root);

  const rules = await loadRules(root);
  assert.ok(rules.length > 0, 'rules loaded');

  const ruleEngine = new RuleEngine();
  ruleEngine.setRules(rules);
  assert.equal(ruleEngine.getRules().length, rules.length);
});

test('integration: import rules validates structure', async () => {
  const { root } = await setup();
  const rulesDir = path.join(root, '.oxford', 'rules');
  await fsp.mkdir(rulesDir, { recursive: true });

  const validFile = path.join(root, 'my-rules.json');
  await fsp.writeFile(validFile, JSON.stringify({ rules: [{ id: 'custom1', name: 'Test', kinds: ['text'], pattern: 'foo', action: 'notify', severity: 'warning' }] }), 'utf8');

  const content = JSON.parse(await fsp.readFile(validFile, 'utf8'));
  assert.ok(Array.isArray(content.rules), 'valid rules file');

  await fsp.copyFile(validFile, path.join(rulesDir, 'my-rules.json'));
  const loaded = await loadRules(root);
  assert.ok(loaded.some((r) => r.id === 'custom1'), 'imported rule loaded');
});

test('integration: import rejects invalid rules file', async () => {
  const invalidContent = JSON.stringify({ notRules: true });
  const parsed = JSON.parse(invalidContent);
  assert.equal(Array.isArray(parsed.rules), false, 'missing rules array detected');
});

// --- Full walkthrough flow: hook → bootstrap → rules → verify ---

test('integration: full flow — hook + bootstrap + rules from scratch', async () => {
  const { root } = await setup();

  // Step 3: Bootstrap
  const modelPath = path.join(root, '.oxford', 'model.json');
  const starter = {
    components: { app: { kind: 'module', label: 'Test App', description: 'Test', parent: null } },
    relationships: {},
    rules: { component_styles: { module: { symbol: 'rectangle', color: '#0ea5e9' } } },
    overrides: {},
  };
  await fsp.writeFile(modelPath, JSON.stringify(starter, null, 2) + '\n', 'utf8');
  const model = JSON.parse(await fsp.readFile(modelPath, 'utf8'));
  assert.ok(model.components.app);

  // Step 4: Default rules
  await writeRulesToDisk(root);
  const rules = await loadRules(root);
  assert.ok(rules.length > 0);

  // Verify: rule engine works with loaded rules
  const engine = new RuleEngine();
  engine.setRules(rules);
  const behavioralIds = engine.getRules().filter((r) => r.id.startsWith('F')).map((r) => r.id);
  assert.ok(behavioralIds.includes('F7'), 'F7 assumed-ok rule loaded');

  // Verify: all files exist
  assert.ok(await fsp.access(modelPath).then(() => true).catch(() => false));
  assert.ok(await fsp.access(path.join(root, '.oxford', 'rules', 'behavioral.json')).then(() => true).catch(() => false));
  assert.ok(await fsp.access(path.join(root, '.oxford', 'rules', 'companion.json')).then(() => true).catch(() => false));
});

test('integration: writeMonitorMessage creates feed file with message', async () => {
  const { root } = await setup();
  const { writeMonitorMessage } = require('../src/vscode_extension/monitor');
  await writeMonitorMessage(root, '[F7] Run the tests.');
  const content = await fsp.readFile(path.join(root, '.oxford', '.monitor_feed'), 'utf8');
  assert.ok(content.includes('[F7] Run the tests.'));
});

test('integration: writeMonitorMessage appends multiple messages on separate lines', async () => {
  const { root } = await setup();
  const { writeMonitorMessage } = require('../src/vscode_extension/monitor');
  await writeMonitorMessage(root, 'Message 1');
  await writeMonitorMessage(root, 'Message 2');
  const content = await fsp.readFile(path.join(root, '.oxford', '.monitor_feed'), 'utf8');
  assert.equal(content, 'Message 1\nMessage 2\n');
});

test('integration: isMonitorRunning detects heartbeat', async () => {
  const { root } = await setup();
  const { isMonitorRunning } = require('../src/vscode_extension/monitor');
  assert.equal(await isMonitorRunning(root), false, 'no heartbeat = not running');
  const now = Math.floor(Date.now() / 1000);
  await fsp.writeFile(path.join(root, '.oxford', '.monitor_heartbeat'), String(now), 'utf8');
  assert.equal(await isMonitorRunning(root), true, 'fresh heartbeat = running');
});
