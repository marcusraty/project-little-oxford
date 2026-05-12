import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { loadRules, RuleEngine, type AuditRule } from '../src/audit/rules';
import { ALL_DEFAULT_RULES, BEHAVIORAL_RULES, COMPANION_RULES } from '../src/audit/default_rules';
import type { AuditEntry, ToolUseContent } from '../src/audit/types';

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) { await cleanup(); cleanup = undefined; }
});

function makeEntry(kind: string, text: string, toolName?: string, filePath?: string): AuditEntry {
  const base: AuditEntry = {
    id: 'test-' + Math.random().toString(36).slice(2),
    session_id: 'test', project_id: 'test', conversation_id: 'test',
    turn_id: 'test', timestamp: new Date().toISOString(),
    kind: kind as AuditEntry['kind'],
    content: { text },
  };
  if (kind === 'tool_use' && toolName) {
    base.content = {
      tool_name: toolName,
      input: filePath ? { file_path: filePath } : {},
      touched_paths: filePath ? [filePath] : [],
    } satisfies ToolUseContent;
  }
  return base;
}

test('rules: default rules are all valid', () => {
  assert.ok(ALL_DEFAULT_RULES.length > 0, 'has rules');
  for (const rule of ALL_DEFAULT_RULES) {
    assert.ok(rule.id, `rule has id: ${rule.id}`);
    assert.ok(rule.name, `rule has name: ${rule.name}`);
    assert.ok(Array.isArray(rule.kinds), `rule has kinds: ${rule.id}`);
  }
});

test('rules: behavioral rules have valid regex patterns', () => {
  for (const rule of BEHAVIORAL_RULES) {
    assert.ok(rule.pattern, `${rule.id} has pattern`);
    assert.doesNotThrow(() => new RegExp(rule.pattern!, 'i'), `${rule.id} pattern is valid regex`);
  }
});

test('rules: F4 matches shortcut language', () => {
  const engine = new RuleEngine();
  engine.setRules(BEHAVIORAL_RULES);

  const entry = makeEntry('text', 'Let me just wire this up quickly');
  const matches = engine.evaluate(entry);
  assert.ok(matches.some((m) => m.rule.id === 'F4'), 'F4 matched "just wire"');
});

test('rules: F5 matches self-reassurance', () => {
  const engine = new RuleEngine();
  engine.setRules(BEHAVIORAL_RULES);

  const entry = makeEntry('text', 'the old code still works so we can move on');
  const matches = engine.evaluate(entry);
  assert.ok(matches.some((m) => m.rule.id === 'F5'), 'F5 matched "still works"');
});

test('rules: F7 matches assumed-ok', () => {
  const engine = new RuleEngine();
  engine.setRules(BEHAVIORAL_RULES);

  const matches = engine.evaluate(makeEntry('thinking', 'the tests should still pass'));
  assert.ok(matches.some((m) => m.rule.id === 'F7'), 'F7 matched in thinking');
});

test('rules: F8 only matches thinking, not text', () => {
  const engine = new RuleEngine();
  engine.setRules(BEHAVIORAL_RULES);

  const textMatches = engine.evaluate(makeEntry('text', "that's fine for now"));
  const thinkMatches = engine.evaluate(makeEntry('thinking', "that's fine for now"));

  assert.ok(!textMatches.some((m) => m.rule.id === 'F8'), 'F8 does NOT match text');
  assert.ok(thinkMatches.some((m) => m.rule.id === 'F8'), 'F8 matches thinking');
});

test('rules: no match on clean text', () => {
  const engine = new RuleEngine();
  engine.setRules(BEHAVIORAL_RULES);

  const entry = makeEntry('text', 'I will read the file and write a test for the change.');
  const matches = engine.evaluate(entry);
  assert.equal(matches.length, 0, 'clean text has no matches');
});

const TEST_COMPANION: AuditRule = {
  id: 'C2', name: 'Renderer change without test', kinds: ['tool_use'],
  trigger: 'src/diagram/render.ts', companions: ['tests/render.test.ts'],
  hook: 'Stop', message: 'Edited render.ts without test.', action: 'hook', severity: 'warning',
};

test('rules: companion rules detect missing file', () => {
  const engine = new RuleEngine();
  engine.setRules([TEST_COMPANION]);

  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/diagram/render.ts'));
  const companions = engine.checkCompanions();
  assert.ok(companions.some((m) => m.rule.id === 'C2'), 'C2 fired: render change without test');
});

test('rules: companion rules satisfied when companion edited', () => {
  const engine = new RuleEngine();
  engine.setRules([TEST_COMPANION]);

  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/diagram/render.ts'));
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/tests/render.test.ts'));
  const companions = engine.checkCompanions();
  assert.ok(!companions.some((m) => m.rule.id === 'C2'), 'C2 NOT fired: companion was edited');
});

test('rules: loadRules reads from .oxford/rules/', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-rules-'));
  cleanup = async () => fsp.rm(root, { recursive: true, force: true });

  const rulesDir = path.join(root, '.oxford', 'rules');
  await fsp.mkdir(rulesDir, { recursive: true });
  await fsp.writeFile(
    path.join(rulesDir, 'test.json'),
    JSON.stringify({ rules: [{ id: 'T1', name: 'Test', kinds: ['text'], pattern: 'hello', action: 'log', severity: 'info' }] }),
    'utf8',
  );

  const rules = await loadRules(root);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'T1');
});

test('rules: loadRules returns empty for missing dir', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-rules-'));
  cleanup = async () => fsp.rm(root, { recursive: true, force: true });

  const rules = await loadRules(root);
  assert.equal(rules.length, 0);
});

test('rules: loadRules skips malformed files', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-rules-'));
  cleanup = async () => fsp.rm(root, { recursive: true, force: true });

  const rulesDir = path.join(root, '.oxford', 'rules');
  await fsp.mkdir(rulesDir, { recursive: true });
  await fsp.writeFile(path.join(rulesDir, 'bad.json'), '{not valid json', 'utf8');
  await fsp.writeFile(
    path.join(rulesDir, 'good.json'),
    JSON.stringify([{ id: 'G1', name: 'Good', kinds: ['text'], action: 'log', severity: 'info' }]),
    'utf8',
  );

  const rules = await loadRules(root);
  assert.equal(rules.length, 1, 'only valid rules loaded');
  assert.equal(rules[0].id, 'G1');
});

test('rules: rule with hook+message fields is valid', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'H1', name: 'Hook rule', kinds: ['text'], pattern: 'should work',
    hook: 'Stop', message: 'Run the tests.', action: 'hook', severity: 'warning',
  }]);
  assert.equal(engine.getRules().length, 1);
  assert.equal(engine.getRules()[0].hook, 'Stop');
  assert.equal(engine.getRules()[0].message, 'Run the tests.');
});

test('rules: evaluate returns match with message from hook rule', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'H2', name: 'Assumed-ok', kinds: ['text'], pattern: 'should work',
    hook: 'Stop', message: 'Verify before assuming.', action: 'hook', severity: 'warning',
  }]);
  const matches = engine.evaluate(makeEntry('text', 'I think this should work fine'));
  assert.equal(matches.length, 1);
  assert.equal(matches[0].rule.hook, 'Stop');
  assert.equal(matches[0].rule.message, 'Verify before assuming.');
});

test('rules: resetEditTracking clears edited files', () => {
  const engine = new RuleEngine();
  engine.setRules([TEST_COMPANION]);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/diagram/render.ts'));
  const before = engine.checkCompanions();
  assert.ok(before.length > 0, 'companion fired before reset');
  engine.resetEditTracking();
  const after = engine.checkCompanions();
  assert.equal(after.length, 0, 'no companions fire after reset');
});

test('rules: companion with order=companion_first fires when src edited before test', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C10', name: 'Source before test', kinds: ['tool_use'],
    trigger: 'src/', companions: ['tests/'], order: 'companion_first',
    hook: 'Stop', message: 'Write test first.', action: 'hook', severity: 'warning',
  }]);
  // Edit src first (timestamp 100), no test edit
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/foo.ts'));
  const matches = engine.checkCompanions();
  assert.ok(matches.some((m) => m.rule.id === 'C10'), 'C10 fires: src edited without test');
});

test('rules: companion with order=companion_first does NOT fire when test edited first', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C10', name: 'Source before test', kinds: ['tool_use'],
    trigger: 'src/', companions: ['tests/'], order: 'companion_first',
    hook: 'Stop', message: 'Write test first.', action: 'hook', severity: 'warning',
  }]);
  // Edit test first (T1), then src (T2 > T1). The engine reads entry.timestamp
  // for ordering, so we have to make them distinct.
  const t1 = makeEntry('tool_use', '', 'Edit', '/project/tests/foo.test.ts');
  t1.timestamp = '2026-05-11T10:00:01.000Z';
  const t2 = makeEntry('tool_use', '', 'Edit', '/project/src/foo.ts');
  t2.timestamp = '2026-05-11T10:00:02.000Z';
  engine.evaluate(t1);
  engine.evaluate(t2);
  const matches = engine.checkCompanions();
  assert.equal(matches.filter((m) => m.rule.id === 'C10').length, 0, 'C10 does NOT fire: test was edited first');
});

// --- context tracking (Phase 2) ---

test('context tracker: Read adds file to context set', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  engine.evaluate(makeEntry('tool_use', '', 'Read', '/project/src/render.ts'));
  assert.equal(engine.isInContext('src/render.ts'), true);
});

test('context tracker: clearContext removes all files', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  engine.evaluate(makeEntry('tool_use', '', 'Read', '/project/src/render.ts'));
  engine.clearContext();
  assert.equal(engine.isInContext('src/render.ts'), false);
});

test('context tracker: isInContext returns false for unread file', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  assert.equal(engine.isInContext('src/render.ts'), false);
});

test('context tracker: Edit does not add to context set', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/render.ts'));
  assert.equal(engine.isInContext('src/render.ts'), false);
});

// --- F12 rule test ---

test('F12: matches "save for next session"', () => {
  const engine = new RuleEngine();
  engine.setRules(BEHAVIORAL_RULES);
  const matches = engine.evaluate(makeEntry('text', 'Let me save this for next session and wrap up.'));
  const f12 = matches.find((m) => m.rule.id === 'F12');
  assert.ok(f12, 'F12 should match "save.*for next session"');
});

test('F12: does not match normal text', () => {
  const engine = new RuleEngine();
  engine.setRules(BEHAVIORAL_RULES);
  const matches = engine.evaluate(makeEntry('text', 'I will continue implementing this feature.'));
  const f12 = matches.find((m) => m.rule.id === 'F12');
  assert.equal(f12, undefined, 'F12 should not match normal text');
});

// --- processEntry (Phase 4) ---

test('processEntry: returns ruleMatches and companionMatches together', () => {
  const engine = new RuleEngine();
  engine.setRules([...BEHAVIORAL_RULES, ...COMPANION_RULES]);
  const result = engine.processEntry(makeEntry('text', 'this should work fine'));
  assert.ok(result.ruleMatches.length > 0, 'behavioral rule matched');
  assert.ok(Array.isArray(result.companionMatches));
  assert.equal(result.isTurnBoundary, false);
  assert.equal(result.isCompactBoundary, false);
});

test('processEntry: user_prompt triggers companion check and marks turn boundary', () => {
  const engine = new RuleEngine();
  engine.setRules(COMPANION_RULES);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/diagram/types.ts'));
  const result = engine.processEntry(makeEntry('user_prompt', 'next'));
  assert.equal(result.isTurnBoundary, true);
});

test('processEntry: compact_boundary marks isCompactBoundary', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  const entry = makeEntry('system', 'Conversation compacted');
  entry.subtype = 'compact_boundary';
  const result = engine.processEntry(entry);
  assert.equal(result.isCompactBoundary, true);
  assert.equal(engine.isInContext('anything'), false);
});

test('F11: matches "implement first then test"', () => {
  const engine = new RuleEngine();
  engine.setRules(BEHAVIORAL_RULES);
  const matches = engine.evaluate(makeEntry('text', 'Let me implement first then add tests later.'));
  const f11 = matches.find((m) => m.rule.id === 'F11');
  assert.ok(f11, 'F11 should match');
});

// --- intent-to-verify (Phase 4) ---

test('intent-verify: intent detected on "update model.json" text', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  engine.evaluate(makeEntry('text', 'Let me update the model.json now.'));
  assert.equal(engine.isIntentDeclared(), true);
});

test('intent-verify: Read after intent adds to verified set', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  engine.evaluate(makeEntry('text', 'I should update the diagram.'));
  engine.evaluate(makeEntry('tool_use', '', 'Read', '/project/src/render.ts'));
  assert.equal(engine.isReadSinceIntent('src/render.ts'), true);
});

test('intent-verify: model.json edit with backing file read = no fire', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  const anchorMap = new Map([['src/render.ts', ['renderer']]]);
  engine.setAnchorMap(anchorMap);
  engine.evaluate(makeEntry('text', 'Let me update model.json.'));
  engine.evaluate(makeEntry('tool_use', '', 'Read', '/project/src/render.ts'));
  const unverified = engine.verifyModelUpdate(['renderer']);
  assert.equal(unverified.length, 0, 'all components verified');
});

test('intent-verify: model.json edit without reading backing file = fires', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  const anchorMap = new Map([['src/render.ts', ['renderer']]]);
  engine.setAnchorMap(anchorMap);
  engine.evaluate(makeEntry('text', 'Let me update model.json.'));
  const unverified = engine.verifyModelUpdate(['renderer']);
  assert.equal(unverified.length, 1, 'renderer is unverified');
  assert.equal(unverified[0].id, 'renderer');
  assert.equal(unverified[0].missingFile, 'src/render.ts');
});

test('intent-verify: intent resets on user_prompt', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  engine.evaluate(makeEntry('text', 'Let me update model.json.'));
  assert.equal(engine.isIntentDeclared(), true);
  engine.evaluate(makeEntry('user_prompt', 'next turn'));
  engine.resetEditTracking();
  assert.equal(engine.isIntentDeclared(), false);
});

test('intent-verify: file in context counts even without intent', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  const anchorMap = new Map([['src/render.ts', ['renderer']]]);
  engine.setAnchorMap(anchorMap);
  engine.evaluate(makeEntry('tool_use', '', 'Read', '/project/src/render.ts'));
  const unverified = engine.verifyModelUpdate(['renderer']);
  assert.equal(unverified.length, 0, 'file was in context — verified');
});
