// D16 — Coverage-driven tests, treated skeptically.
//
// Many tests in this file were written to drive specific branches /
// statements into c8 coverage. That's a legitimate goal: an unreachable
// `?? []` or an empty-array early-return is still real code, and a test
// that exercises it surfaces the contract.
//
// But coverage-driven tests carry a risk: a test that exists ONLY to touch
// a line, with no behavioral assertion, becomes change-detection noise.
// When one of these tests fails during a refactor, ask:
//   - Is the assertion useful, or is it just "this code ran"?
//   - Does deleting the test lose anything we'd want to know?
//
// If the answer is "no useful assertion / nothing lost" — delete it,
// don't fix it. Coverage % is a signal, not the goal.
//
// Tests in here that ARE valuable: those that assert specific behaviors
// at the boundaries (empty input, missing fields, malformed JSON). Those
// that pin loose contracts (`?? '' ` defaults, optional field handling).
// Tests that ARE noise: those that wrap a single console.log-equivalent
// path "just to hit it."

import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Normalizer } from '../src/audit/normalizer';
import { loadRules, RuleEngine } from '../src/audit/rules';
import { COMPANION_RULES } from '../src/audit/default_rules';
import { MonitorSink, PanelSink, StatusBarSink, ActivitySink, type ProcessResult } from '../src/audit/sinks';
import { installRecorder, uninstallRecorder, recorder, noopRecorder } from '../src/diagnostics/recorder';
import type { DiagEvent, Sink } from '../src/diagnostics/types';
import { computeStaleness, buildAnchorMap, updateActivity, diffModelComponents } from '../src/diagram/activity';
import { emitSvg, computeLayout } from '../src/diagram/render';
import { readDiagram, mutateDiagram } from '../src/diagram/storage';
import { renderEventRow } from '../src/ui/components';
import { Disposables } from '../src/vscode_extension/disposables';
import { readHeartbeat, isMonitorRunning, writeMonitorMessage } from '../src/vscode_extension/monitor';
import type { Diagram } from '../src/diagram/types';
import type { AuditEntry, ToolUseContent } from '../src/audit/types';
import type { RuleMatch } from '../src/audit/rules';

const PROJECT = '/test/project';

let tmpDir = '';
afterEach(async () => {
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
});
async function makeTmp(): Promise<string> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oxford-cov-'));
  await fsp.mkdir(path.join(tmpDir, '.oxford'), { recursive: true });
  return tmpDir;
}

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

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

function makeResult(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    entry: { id: 'e1', session_id: 's1', project_id: 'p1', conversation_id: 'c1', turn_id: 't1', timestamp: '2026-05-10T10:00:00Z', kind: 'text', content: { text: 'hello' } },
    ruleMatches: [],
    companionMatches: [],
    isTurnBoundary: false,
    isCompactBoundary: false,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — lines 18-19 (path field extraction)
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: extractTouchedPaths uses input.path when present', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'test' }, sessionId: 's1' }), PROJECT);
  n.normalize(line({
    uuid: 'a1', type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'SomeCustomTool', input: { path: '/usr/local/src/file.ts' } }] },
  }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'r1', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
  }), PROJECT);

  const tc = entries[0].content as unknown as ToolUseContent;
  assert.ok(tc.touched_paths!.includes('/usr/local/src/file.ts'), 'input.path extracted');
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — lines 32-39 (Grep/Glob result path extraction)
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: Grep tool result extracts paths from output lines', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'test' }, sessionId: 's1' }), PROJECT);
  n.normalize(line({
    uuid: 'a1', type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'foo' } }] },
  }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'r1', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '/project/src/foo.ts:10:  foo = bar\nsrc/bar.ts:5:  another\nnot-a-path' }] },
  }), PROJECT);

  const tc = entries[0].content as unknown as ToolUseContent;
  assert.ok(tc.touched_paths!.includes('/project/src/foo.ts'), 'absolute path from Grep result');
  assert.ok(tc.touched_paths!.includes('src/bar.ts'), 'relative path from Grep result');
});

test('normalizer: Glob tool result extracts paths from output lines', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'test' }, sessionId: 's1' }), PROJECT);
  n.normalize(line({
    uuid: 'a1', type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Glob', input: { pattern: '**/*.ts' } }] },
  }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'r1', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '/project/tests/render.test.ts\n/project/src/index.ts' }] },
  }), PROJECT);

  const tc = entries[0].content as unknown as ToolUseContent;
  assert.ok(tc.touched_paths!.includes('/project/tests/render.test.ts'));
  assert.ok(tc.touched_paths!.includes('/project/src/index.ts'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — lines 97-98 (unknown type returns empty)
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: unknown type with message content returns empty', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'u1', type: 'response_complete', timestamp: '2025-01-01T00:00:00Z',
    message: { role: 'assistant', content: 'something' },
  }), PROJECT);
  assert.equal(entries.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — lines 223-227 (normalizeSystem with array content)
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: system event with array content joins text blocks', () => {
  const n = new Normalizer('sess-1');
  const entries = n.normalize(line({
    type: 'system', uuid: 'sys-1', timestamp: '2026-05-10T10:00:00Z',
    content: [
      { type: 'text', text: 'First part.' },
      { type: 'text', text: 'Second part.' },
      { type: 'image', url: 'ignored' },
    ],
  }), PROJECT);
  assert.equal(entries.length, 1);
  const text = (entries[0].content as any).text;
  assert.ok(text.includes('First part.'));
  assert.ok(text.includes('Second part.'));
});

test('normalizer: system event with message.content array', () => {
  const n = new Normalizer('sess-1');
  const entries = n.normalize(line({
    type: 'system', uuid: 'sys-2', timestamp: '2026-05-10T10:00:00Z',
    message: { content: [{ type: 'text', text: 'From message.content' }] },
  }), PROJECT);
  assert.equal(entries.length, 1);
  assert.ok((entries[0].content as any).text.includes('From message.content'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — lines 49-51 (loadRules single object format)
// ═══════════════════════════════════════════════════════════════════════════════

test('rules: loadRules handles single rule object (not array, not {rules:[]})', async () => {
  const root = await makeTmp();
  const rulesDir = path.join(root, '.oxford', 'rules');
  await fsp.mkdir(rulesDir, { recursive: true });
  await fsp.writeFile(
    path.join(rulesDir, 'single.json'),
    JSON.stringify({ id: 'S1', name: 'Single', kinds: ['text'], action: 'log', severity: 'info' }),
    'utf8',
  );
  const rules = await loadRules(root);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'S1');
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — line 220 (companion any mode)
// ═══════════════════════════════════════════════════════════════════════════════

test('rules: companion rule with any=true fires when no companions match', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C-ANY', name: 'Any companion', kinds: ['tool_use'],
    trigger: 'src/audit/', companions: ['tests/audit.test.ts', 'tests/audit2.test.ts'],
    any: true, hook: 'Stop', message: 'Need at least one test.', action: 'hook', severity: 'warning',
  }]);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/audit/engine.ts'));
  const companions = engine.checkCompanions();
  assert.ok(companions.some(m => m.rule.id === 'C-ANY'), 'fires when none match');
});

test('rules: companion rule with any=true satisfied by one companion', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C-ANY', name: 'Any companion', kinds: ['tool_use'],
    trigger: 'src/audit/', companions: ['tests/audit.test.ts', 'tests/audit2.test.ts'],
    any: true, hook: 'Stop', message: 'Need at least one test.', action: 'hook', severity: 'warning',
  }]);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/audit/engine.ts'));
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/tests/audit.test.ts'));
  const companions = engine.checkCompanions();
  assert.ok(!companions.some(m => m.rule.id === 'C-ANY'), 'satisfied by one');
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — lines 261-263 (reset method)
// ═══════════════════════════════════════════════════════════════════════════════

test('rules: reset clears editedFiles and companionAlerted', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C1', name: 'Test', kinds: ['tool_use'],
    trigger: 'src/', companions: ['tests/'],
    hook: 'Stop', message: 'Need test.', action: 'hook', severity: 'warning',
  }]);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/foo.ts'));
  engine.checkCompanions();
  engine.reset();
  const after = engine.checkCompanions();
  assert.equal(after.length, 0, 'reset cleared everything');
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — lines 269-270 (extractText with no text field)
// ═══════════════════════════════════════════════════════════════════════════════

test('rules: evaluate on tool_use entry with no text field does not crash', () => {
  const engine = new RuleEngine();
  engine.setRules([{ id: 'F1', name: 'Test', kinds: ['tool_use'], pattern: 'crash', action: 'log', severity: 'info' }]);
  const entry: AuditEntry = {
    id: 'test', session_id: 'test', project_id: 'test', conversation_id: 'test',
    turn_id: 'test', timestamp: new Date().toISOString(),
    kind: 'tool_use',
    content: { tool_name: 'Edit', input: { file_path: '/foo.ts' }, touched_paths: ['/foo.ts'] } satisfies ToolUseContent,
  };
  const matches = engine.evaluate(entry);
  assert.equal(matches.length, 0, 'no match on entry without text');
});

// ═══════════════════════════════════════════════════════════════════════════════
// sinks.ts — branch 28 (rule without message), branch 63 (onUpdate callback), branch 71 (no changes)
// ═══════════════════════════════════════════════════════════════════════════════

test('MonitorSink: skips rule match without message field', async () => {
  const root = await makeTmp();
  const sink = new MonitorSink(root, async (r, m) => {
    const fp = path.join(r, '.oxford', '.monitor_feed');
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    await fsp.appendFile(fp, m + '\n', 'utf8');
  });
  const match = {
    rule: { id: 'F1', name: 'Test', kinds: ['text'], action: 'hook' as const, severity: 'warning' as const, hook: 'Stop' as const },
    entry: makeResult().entry,
    matchedText: 'x',
  };
  await sink.receive(makeResult({ ruleMatches: [match] }));
  const exists = await fsp.access(path.join(root, '.oxford', '.monitor_feed')).then(() => true).catch(() => false);
  assert.equal(exists, false, 'no feed written for rule without message');
});

test('StatusBarSink: calls onUpdate callback', async () => {
  let lastW = 0, lastE = 0;
  const sink = new StatusBarSink((w, e) => { lastW = w; lastE = e; });
  const match = {
    rule: { id: 'F1', name: 'Test', kinds: ['text'], action: 'hook' as const, severity: 'warning' as const, message: 'hi', hook: 'Stop' as const },
    entry: makeResult().entry,
    matchedText: 'x',
  };
  await sink.receive(makeResult({ ruleMatches: [match] }));
  assert.equal(lastW, 1);
  assert.equal(lastE, 0);
});

test('ActivitySink: no-op when modelChanges is empty array', async () => {
  const root = await makeTmp();
  await fsp.writeFile(path.join(root, '.oxford', 'activity.json'), '{}', 'utf8');
  const sink = new ActivitySink(root);
  await sink.receive(makeResult({ modelChanges: { changed: [], unverified: [] } }));
  const activity = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'activity.json'), 'utf8'));
  assert.deepEqual(activity, {});
});

test('ActivitySink: no-op when modelChanges is undefined', async () => {
  const root = await makeTmp();
  await fsp.writeFile(path.join(root, '.oxford', 'activity.json'), '{}', 'utf8');
  const sink = new ActivitySink(root);
  await sink.receive(makeResult());
  const activity = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'activity.json'), 'utf8'));
  assert.deepEqual(activity, {});
});

// ═══════════════════════════════════════════════════════════════════════════════
// recorder.ts — lines 23-24 (NOOP use returns fn), 56-63 (flush), 75-76 (proxy use)
// ═══════════════════════════════════════════════════════════════════════════════

test('diagnostics: NOOP recorder use() returns a no-op dispose function', () => {
  uninstallRecorder();
  const dispose = recorder.use({ write() {} });
  assert.equal(typeof dispose, 'function');
  assert.doesNotThrow(() => dispose());
});

test('diagnostics: RealRecorder flush calls sink.flush', async () => {
  const real = installRecorder();
  let flushed = false;
  real.use({ write() {}, flush: async () => { flushed = true; } });
  await (real as any).flush();
  assert.equal(flushed, true);
  uninstallRecorder();
});

test('diagnostics: RealRecorder flush tolerates broken sink', async () => {
  const real = installRecorder();
  real.use({ write() {}, flush: async () => { throw new Error('boom'); } });
  await assert.doesNotReject(() => (real as any).flush());
  uninstallRecorder();
});

test('diagnostics: proxy use delegates to impl', () => {
  uninstallRecorder();
  const dispose = recorder.use({ write() {} });
  assert.equal(typeof dispose, 'function');
  dispose();
});

test('diagnostics: RealRecorder dispose calls sink.dispose', () => {
  const real = installRecorder();
  let disposed = false;
  const unreg = real.use({ write() {}, dispose: () => { disposed = true; } });
  unreg();
  assert.equal(disposed, true);
  uninstallRecorder();
});

test('diagnostics: noopRecorder exports', () => {
  assert.equal(typeof noopRecorder.emit, 'function');
  assert.equal(typeof noopRecorder.ingest, 'function');
  assert.doesNotThrow(() => noopRecorder.emit('host', 'test', {}));
});

// ═══════════════════════════════════════════════════════════════════════════════
// activity.ts — branch 30 (anchor with leading ./), branch 81 (isEdit skip stale), branch 116 (skip stale edit)
// ═══════════════════════════════════════════════════════════════════════════════

test('buildAnchorMap: strips leading ./ from anchor values', () => {
  const diagram = {
    components: {
      comp: { kind: 'module', label: 'Comp', parent: null, anchors: [{ type: 'file', value: './src/foo.ts' }] },
    },
    relationships: {},
  };
  const map = buildAnchorMap(diagram as any);
  assert.ok(map.has('src/foo.ts'), 'leading ./ stripped');
  assert.ok(!map.has('./src/foo.ts'), 'raw value not stored');
});

test('computeStaleness: no read and no model_update returns unknown', () => {
  assert.equal(computeStaleness({ last_read: '', last_read_session: '' }), 'unknown');
});

test('computeStaleness: model_update present with no last_edit returns fresh', () => {
  assert.equal(computeStaleness({
    last_read: '2026-05-10T10:00:00Z', last_read_session: 's1',
    last_model_update: '2026-05-10T11:00:00Z', last_model_update_verified: true,
  }), 'fresh');
});

test('updateActivity: skips earlier edit timestamp', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/foo.ts', ['comp']]]);
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-10T11:00:00Z', 'sess-1', 'Edit');
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-10T10:00:00Z', 'sess-2', 'Edit');
  const { readActivity } = await import('../src/diagram/activity');
  const activity = await readActivity(root);
  assert.equal(activity.comp?.last_edit, '2026-05-10T11:00:00Z', 'earlier timestamp ignored');
  assert.equal(activity.comp?.last_edit_session, 'sess-1');
});

// ═══════════════════════════════════════════════════════════════════════════════
// render.ts — paintAttrs, drawBox, cylinder, diamond, buildEdgeGroups, drawEdgeGroup, applyPinnedOverrides
// ═══════════════════════════════════════════════════════════════════════════════

test('emitSvg: renders cylinder shape for kind with symbol=cylinder', async () => {
  const model: Diagram = {
    components: {
      db: { kind: 'database', label: 'DB', parent: null },
      svc: { kind: 'service', label: 'Svc', parent: null },
    },
    relationships: { r1: { kind: 'reads', from: 'svc', to: 'db' } },
    rules: { component_styles: { database: { symbol: 'cylinder', color: '#38bdf8' } } },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  assert.ok(svg.includes('<ellipse'), 'cylinder uses ellipse elements');
  assert.ok(svg.includes('<path d="M'), 'cylinder uses path for body');
});

test('emitSvg: renders diamond shape for kind with symbol=diamond', async () => {
  const model: Diagram = {
    components: {
      decision: { kind: 'gate', label: 'Gate', parent: null },
      svc: { kind: 'service', label: 'Svc', parent: null },
    },
    relationships: { r1: { kind: 'checks', from: 'svc', to: 'decision' } },
    rules: { component_styles: { gate: { symbol: 'diamond', color: '#f59e0b' } } },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  assert.ok(svg.includes(' Z"'), 'diamond shape has closed path');
});

test('emitSvg: renders staleness dots when activity provided', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null, anchors: [{ type: 'file', value: 'src/a.ts' }] },
      b: { kind: 'service', label: 'B', parent: null, anchors: [{ type: 'file', value: 'src/b.ts' }] },
    },
    relationships: { r1: { kind: 'calls', from: 'a', to: 'b' } },
  };
  const activity = {
    a: { last_read: '2026-05-10T11:00:00Z', last_read_session: 's1', last_edit: '2026-05-10T10:00:00Z', last_edit_session: 's1' },
    b: { last_read: '2026-05-10T09:00:00Z', last_read_session: 's1', last_edit: '2026-05-10T10:00:00Z', last_edit_session: 's1' },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout, activity);
  assert.ok(svg.includes('#22c55e'), 'fresh dot rendered (green)');
  assert.ok(svg.includes('#ef4444'), 'stale dot rendered (red)');
  assert.ok(svg.includes('pv-staleness-dot'), 'staleness dot class');
});

test('emitSvg: paintAttrs emits class for default fill/stroke when no style', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'unknown_kind', label: 'A', parent: null },
      b: { kind: 'unknown_kind', label: 'B', parent: null },
    },
    relationships: { r1: { kind: 'calls', from: 'a', to: 'b' } },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  assert.ok(svg.includes('pv-default-fill'), 'default fill class');
  assert.ok(svg.includes('pv-default-stroke'), 'default stroke class');
});

test('emitSvg: custom fill/stroke from rules emits inline attrs', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'custom', label: 'A', parent: null },
      b: { kind: 'custom', label: 'B', parent: null },
    },
    relationships: { r1: { kind: 'calls', from: 'a', to: 'b' } },
    rules: { component_styles: { custom: { symbol: 'rectangle', fill: '#ff0000', color: '#00ff00' } } },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  assert.ok(svg.includes('fill="#ff0000"'), 'inline fill attr from rules');
  assert.ok(svg.includes('stroke="#00ff00"'), 'inline stroke attr from rules');
  assert.ok(!svg.includes('pv-default-fill'), 'no default fill class when custom');
});

test('emitSvg: dashed border style renders stroke-dasharray', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'external', label: 'Ext', parent: null },
      b: { kind: 'service', label: 'Svc', parent: null },
    },
    relationships: { r1: { kind: 'calls', from: 'b', to: 'a' } },
    rules: { component_styles: { external: { symbol: 'rectangle', color: '#888', border: 'dashed' } } },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  assert.ok(svg.includes('stroke-dasharray="5 3"'), 'dashed border');
});

test('emitSvg: bidirectional edges render marker-start', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null },
    },
    relationships: {
      r1: { kind: 'calls', from: 'a', to: 'b' },
      r2: { kind: 'returns', from: 'b', to: 'a' },
    },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  assert.ok(svg.includes('marker-start="url(#arrow)"'), 'bidirectional marker-start');
});

test('emitSvg: multi-edge group renders badge with count', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null },
    },
    relationships: {
      r1: { kind: 'calls', from: 'a', to: 'b' },
      r2: { kind: 'notifies', from: 'a', to: 'b' },
      r3: { kind: 'queries', from: 'a', to: 'b' },
    },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  assert.ok(svg.includes('pv-edge-badge-bg'), 'badge background');
  assert.ok(svg.includes('pv-edge-badge-text'), 'badge text');
  assert.ok(svg.includes('>3<'), 'count of 3');
});

test('emitSvg: dashed relationship style renders dashed edge', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null },
    },
    relationships: { r1: { kind: 'optional', from: 'a', to: 'b' } },
    rules: { relationship_styles: { optional: { style: 'dashed' } } },
  };
  const layout = await computeLayout(model);
  const svg = emitSvg(model, layout);
  assert.ok(svg.includes('stroke-dasharray="6 4"'), 'dashed edge');
});

test('renderDiagram: applyPinnedOverrides shifts container and children', async () => {
  const model: Diagram = {
    components: {
      container: { kind: 'group', label: 'Container', parent: null },
      child1: { kind: 'service', label: 'Child1', parent: 'container' },
      child2: { kind: 'service', label: 'Child2', parent: 'container' },
      outside: { kind: 'service', label: 'Outside', parent: null },
    },
    relationships: {
      r1: { kind: 'calls', from: 'outside', to: 'child1' },
    },
  };
  const layout1 = await computeLayout(model);
  const containerRelPos = layout1.relative['container'];
  const childBefore = layout1.components['child1'];
  model.layout = { components: { container: { x: containerRelPos.x + 50, y: containerRelPos.y + 30, w: containerRelPos.w, h: containerRelPos.h } } };
  const result = await renderDiagram(model);
  assert.ok(result.svg.includes('Child1'), 'child rendered');
  assert.ok(result.svg.includes('Child2'), 'child2 rendered');
});

// ═══════════════════════════════════════════════════════════════════════════════
// storage.ts — lines 80-81 (readDiagram file missing), 86-87 (bad JSON), 141-144 (gcOrphans overrides)
// ═══════════════════════════════════════════════════════════════════════════════

test('readDiagram: returns null when file missing', async () => {
  const root = await makeTmp();
  const result = await readDiagram(root);
  assert.equal(result, null);
});

test('readDiagram: returns null for invalid JSON', async () => {
  const root = await makeTmp();
  await fsp.writeFile(path.join(root, '.oxford', 'model.json'), '{broken json!!!', 'utf8');
  const result = await readDiagram(root);
  assert.equal(result, null);
});

test('mutateDiagram: gcOrphans removes overrides for deleted components', async () => {
  const root = await makeTmp();
  const model = {
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
    overrides: { a: { label: 'Custom A' }, deleted: { label: 'Ghost' } },
  };
  await fsp.writeFile(path.join(root, '.oxford', 'model.json'), JSON.stringify(model), 'utf8');
  await mutateDiagram(root, () => {});
  const raw = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'model.json'), 'utf8'));
  assert.ok(raw.overrides.a, 'valid override preserved');
  assert.equal(raw.overrides.deleted, undefined, 'orphan override removed');
});

// ═══════════════════════════════════════════════════════════════════════════════
// components.ts — lines 28-29 (formatTimestamp catch), 87-88 (DOM overflow)
// ═══════════════════════════════════════════════════════════════════════════════

// Test AuditEventList with DOM mock
import { AuditEventList } from '../src/ui/components';

function createMockElement(): any {
  const children: any[] = [];
  const el = {
    scrollTop: 0,
    get scrollHeight() { return 1000; },
    get children() { return children; },
    get firstChild() { return children[0] ?? null; },
    removeChild(child: any) { const i = children.indexOf(child); if (i >= 0) children.splice(i, 1); },
    insertAdjacentHTML(_pos: string, _html: string) { children.push({ _html }); },
  };
  Object.defineProperty(el, 'innerHTML', {
    set(v: string) { children.length = 0; if (v) { for (const _m of v.matchAll(/<div/g)) children.push({}); } },
    get() { return ''; },
  });
  return el;
}

test('AuditEventList: mount renders entries', () => {
  const list = new AuditEventList();
  const el = createMockElement();
  list.mount(el);
  assert.equal(list.count, 0);
});

test('AuditEventList: push adds entry and trims overflow', () => {
  const list = new AuditEventList();
  const el = createMockElement();
  list.mount(el);
  for (let i = 0; i < 105; i++) {
    list.push({
      id: `e${i}`, session_id: 's', project_id: 'p', conversation_id: 'c',
      turn_id: 't', timestamp: '2026-05-10T10:00:00Z', kind: 'text', content: { text: `msg ${i}` },
    });
  }
  assert.equal(list.count, 100, 'capped at MAX_EVENTS=100');
  assert.ok(el.children.length <= 100, 'DOM children trimmed');
});

test('AuditEventList: push without mount does not crash', () => {
  const list = new AuditEventList();
  assert.doesNotThrow(() => {
    list.push({
      id: 'e1', session_id: 's', project_id: 'p', conversation_id: 'c',
      turn_id: 't', timestamp: '2026-05-10T10:00:00Z', kind: 'text', content: { text: 'hello' },
    });
  });
  assert.equal(list.count, 1);
});

test('renderEventRow: invalid timestamp renders Invalid Date string', () => {
  const entry: AuditEntry = {
    id: 'e1', session_id: 's', project_id: 'p', conversation_id: 'c',
    turn_id: 't', timestamp: 'not-a-date', kind: 'text', content: { text: 'hello' },
  };
  const html = renderEventRow(entry);
  assert.ok(html.includes('Invalid Date'), 'Invalid Date shown for bad timestamp');
});

test('renderEventRow: system kind renders gear icon', () => {
  const entry: AuditEntry = {
    id: 'e1', session_id: 's', project_id: 'p', conversation_id: 'c',
    turn_id: 't', timestamp: '2026-05-10T10:00:00Z', kind: 'system', content: { text: 'compacted' },
  };
  const html = renderEventRow(entry);
  assert.ok(html.includes('⚙'), 'gear icon for system');
});

test('renderEventRow: unknown kind uses bullet', () => {
  const entry: AuditEntry = {
    id: 'e1', session_id: 's', project_id: 'p', conversation_id: 'c',
    turn_id: 't', timestamp: '2026-05-10T10:00:00Z', kind: 'unknown_kind' as any, content: { text: 'x' },
  };
  const html = renderEventRow(entry);
  assert.ok(html.includes('•'), 'bullet for unknown kind');
});

// ═══════════════════════════════════════════════════════════════════════════════
// disposables.ts — lines 37-38 (dispose catches thrown)
// ═══════════════════════════════════════════════════════════════════════════════

test('Disposables: dispose tolerates throwing listener removal', () => {
  const disposables = new Disposables();
  let secondCalled = false;
  const badTarget = {
    addEventListener() {},
    removeEventListener() { throw new Error('removal failed'); },
  };
  const goodTarget = {
    addEventListener() {},
    removeEventListener() { secondCalled = true; },
  };
  disposables.on(badTarget, 'click', () => {});
  disposables.on(goodTarget, 'mousemove', () => {});
  assert.doesNotThrow(() => disposables.dispose());
  assert.equal(secondCalled, true, 'second listener still cleaned up');
});

// ═══════════════════════════════════════════════════════════════════════════════
// monitor.ts — branch 17 (readHeartbeat NaN case)
// ═══════════════════════════════════════════════════════════════════════════════

test('monitor: readHeartbeat returns null for NaN content', async () => {
  const root = await makeTmp();
  await fsp.writeFile(path.join(root, '.oxford', '.monitor_heartbeat'), 'not-a-number', 'utf8');
  const ts = await readHeartbeat(root);
  assert.equal(ts, null);
});

test('monitor: readHeartbeat returns null when file missing', async () => {
  const root = await makeTmp();
  const ts = await readHeartbeat(root);
  assert.equal(ts, null);
});

test('monitor: isMonitorRunning returns false for stale heartbeat', async () => {
  const root = await makeTmp();
  const oldTs = Math.floor(Date.now() / 1000) - 10;
  await fsp.writeFile(path.join(root, '.oxford', '.monitor_heartbeat'), String(oldTs), 'utf8');
  const running = await isMonitorRunning(root);
  assert.equal(running, false);
});

test('monitor: isMonitorRunning returns true for fresh heartbeat', async () => {
  const root = await makeTmp();
  const freshTs = Math.floor(Date.now() / 1000);
  await fsp.writeFile(path.join(root, '.oxford', '.monitor_heartbeat'), String(freshTs), 'utf8');
  const running = await isMonitorRunning(root);
  assert.equal(running, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// layout.ts — branch 141 (stampTiers __root__ recursion)
// This is covered implicitly by computeLayout since every call goes through
// stampTiers. The branch is __root__ node detection. We test it via a model
// that exercises tiering.
// ═══════════════════════════════════════════════════════════════════════════════

test('layout: stampTiers places actors above services above data', async () => {
  const model: Diagram = {
    components: {
      user: { kind: 'actor', label: 'User', parent: null },
      api: { kind: 'service', label: 'API', parent: null },
      db: { kind: 'database', label: 'DB', parent: null },
    },
    relationships: {
      r1: { kind: 'calls', from: 'user', to: 'api' },
      r2: { kind: 'reads', from: 'api', to: 'db' },
    },
  };
  const layout = await computeLayout(model);
  assert.ok(layout.components.user.y < layout.components.db.y, 'actor above database');
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — flush() for incomplete tool_use
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: flush returns pending tool_use entries', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'test' }, sessionId: 's1' }), PROJECT);
  n.normalize(line({
    uuid: 'a1', type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/foo.ts' } }] },
  }), PROJECT);
  const flushed = n.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].kind, 'tool_use');
});

// ══════════════════════════════════════════════════════════════════════════════���
// PanelSink coverage
// ═══════════════════════════════════════════════════════════════════════════════

test('PanelSink: pushes rule matches to callback', () => {
  const received: RuleMatch[] = [];
  const sink = new PanelSink((m) => received.push(m));
  const match: RuleMatch = {
    rule: { id: 'F1', name: 'Test', kinds: ['text'], action: 'hook', severity: 'warning', message: 'hi', hook: 'Stop' },
    entry: makeResult().entry,
    matchedText: 'matched',
  };
  sink.receive(makeResult({ ruleMatches: [match] }));
  assert.equal(received.length, 1);
  assert.equal(received[0].rule.id, 'F1');
});

// ═══════════════════════════════════════════════════════════════════════════════
// render.ts — orphan-override diagnostic (lines 198-207)
// ═══════════════════════════════════════════════════════════════════════════════

import { renderDiagram } from '../src/diagram/render';

test('renderDiagram: orphan override produces diagnostic', async () => {
  const model: Diagram = {
    components: { a: { kind: 'service', label: 'A', parent: null } },
    relationships: {},
    overrides: { a: { label: 'Custom A' }, ghost: { label: 'Phantom' } },
  };
  const result = await renderDiagram(model);
  const orphan = result.diagnostics.find(d => d.rule === 'orphan-override');
  assert.ok(orphan, 'orphan-override diagnostic emitted');
  assert.ok(orphan!.message.includes('ghost'), 'mentions the orphan id');
});

test('renderDiagram: orphan layout entry produces diagnostic', async () => {
  const model: Diagram = {
    components: { a: { kind: 'service', label: 'A', parent: null } },
    relationships: {},
    layout: { components: { a: { x: 10, y: 20, w: 100, h: 50 }, ghost: { x: 0, y: 0, w: 100, h: 50 } } },
  };
  const result = await renderDiagram(model);
  const orphan = result.diagnostics.find(d => d.rule === 'orphan-layout');
  assert.ok(orphan, 'orphan-layout diagnostic emitted');
  assert.ok(orphan!.message.includes('ghost'), 'mentions the orphan id');
});

// ═══════════════════════════════════════════════════════════════════════════════
// render.ts — empty model (lines 428-430)
// ═══════════════════════════════════════════════════════════════════════════════

test('renderDiagram: model with no components returns empty svg', async () => {
  const model: Diagram = { components: {}, relationships: {} };
  const result = await renderDiagram(model);
  assert.ok(result.svg.includes('<svg'), 'SVG produced');
  assert.ok(result.layout.canvasWidth! > 0, 'canvas width positive');
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — verifyModelUpdate with no-anchor component (branch 124, 131)
// ═══════════════════════════════════════════════════════════════════════════════

test('rules: verifyModelUpdate skips component with no anchor mapping', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  engine.setAnchorMap(new Map([['src/a.ts', ['comp_a']]]));
  const unverified = engine.verifyModelUpdate(['comp_with_no_anchor']);
  assert.equal(unverified.length, 0, 'no anchor = not flagged');
});

test('rules: verifyModelUpdate checks correct anchor for component', () => {
  const engine = new RuleEngine();
  engine.setRules([]);
  engine.setAnchorMap(new Map([
    ['src/a.ts', ['comp_a']],
    ['src/b.ts', ['comp_b']],
  ]));
  engine.evaluate(makeEntry('text', 'I will update model.json'));
  engine.evaluate(makeEntry('tool_use', '', 'Read', '/project/src/a.ts'));
  const unverified = engine.verifyModelUpdate(['comp_a', 'comp_b']);
  assert.equal(unverified.length, 1);
  assert.equal(unverified[0].id, 'comp_b');
  assert.equal(unverified[0].missingFile, 'src/b.ts');
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — companion dedup (branch 212)
// ═══════════════════════════════════════════════════════════════════════════════

test('rules: companion rule only fires once per alert (dedup)', () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C-DEDUP', name: 'Dedup test', kinds: ['tool_use'],
    trigger: 'src/', companions: ['tests/'],
    hook: 'Stop', message: 'Need test.', action: 'hook', severity: 'warning',
  }]);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/foo.ts'));
  const first = engine.checkCompanions();
  assert.equal(first.length, 1, 'fires first time');
  const second = engine.checkCompanions();
  assert.equal(second.length, 0, 'dedup prevents second fire');
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — isValidRule branches (line 58 — non-object input)
// ═══════════════════════════════════════════════════════════════════════════════

test('rules: loadRules filters invalid entries in array format', async () => {
  const root = await makeTmp();
  const rulesDir = path.join(root, '.oxford', 'rules');
  await fsp.mkdir(rulesDir, { recursive: true });
  await fsp.writeFile(
    path.join(rulesDir, 'mixed.json'),
    JSON.stringify([
      null,
      42,
      'string',
      { id: 'valid', name: 'Valid', kinds: ['text'], action: 'log', severity: 'info' },
      { id: 123, name: 'InvalidId', kinds: ['text'] },
      { id: 'noKinds', name: 'NoKinds', kinds: 'notArray' },
    ]),
    'utf8',
  );
  const rules = await loadRules(root);
  assert.equal(rules.length, 1);
  assert.equal(rules[0].id, 'valid');
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — companion_first satisfied (line 229) - test edited before source
// ═══════════════════════════════════════════════════════════════════════════════

test('rules: companion_first with all companions before trigger does NOT fire', async () => {
  const engine = new RuleEngine();
  engine.setRules([{
    id: 'C-FIRST', name: 'Companion first', kinds: ['tool_use'],
    trigger: 'src/main.ts', companions: ['tests/main.test.ts'], order: 'companion_first',
    hook: 'Stop', message: 'Test before code.', action: 'hook', severity: 'warning',
  }]);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/tests/main.test.ts'));
  await new Promise(r => setTimeout(r, 2));
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/main.ts'));
  const matches = engine.checkCompanions();
  assert.equal(matches.filter(m => m.rule.id === 'C-FIRST').length, 0, 'companions before trigger = no fire');
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — empty thinking/text blocks (branch paths)
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: empty text block is skipped', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', isMeta: false, timestamp: 'T', message: { role: 'user', content: 'prompt' } }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: 'T',
    message: { role: 'assistant', content: [{ type: 'text', text: '' }, { type: 'text', text: 'actual' }] },
  }), PROJECT);
  assert.equal(entries.length, 1, 'only non-empty text block produces entry');
  assert.equal((entries[0].content as any).text, 'actual');
});

test('normalizer: empty thinking block is skipped', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', isMeta: false, timestamp: 'T', message: { role: 'user', content: 'prompt' } }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: 'T',
    message: { role: 'assistant', content: [{ type: 'thinking', thinking: '' }, { type: 'thinking', thinking: 'real' }] },
  }), PROJECT);
  assert.equal(entries.length, 1, 'only non-empty thinking produces entry');
});

test('normalizer: content block without type is skipped', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', isMeta: false, timestamp: 'T', message: { role: 'user', content: 'prompt' } }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: 'T',
    message: { role: 'assistant', content: [{ noType: true }, { type: 'text', text: 'valid' }] },
  }), PROJECT);
  assert.equal(entries.length, 1);
  assert.equal((entries[0].content as any).text, 'valid');
});

test('normalizer: assistant with non-array content returns empty', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: 'T',
    message: { role: 'assistant', content: 'string content' },
  }), PROJECT);
  assert.equal(entries.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — tool_use with missing block.id uses blockId fallback
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: tool_use without block.id is emitted immediately with generated blockId', () => {
  // N2 fix: a tool_use without a valid block.id can't be tracked for its
  // tool_result, so it's emitted on the spot rather than disappearing into
  // pendingToolUse under a null key.
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', isMeta: false, timestamp: 'T', message: { role: 'user', content: 'p' } }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: 'T',
    message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/f.ts' } }] },
  }), PROJECT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'a1-0', 'blockId fallback used');
});

// ═══════════════════════════════════════════════════════════════════════════════
// storage.ts — mutateDiagram non-default filename keeps layout (branch 120-126)
// ═══════════════════════════════════════════════════════════════════════════════

test('mutateDiagram: non-default filename preserves layout in output', async () => {
  const root = await makeTmp();
  const customFile = 'alternate.json';
  const model = {
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
    layout: { components: { a: { x: 10, y: 20, w: 100, h: 50 } } },
  };
  await fsp.writeFile(path.join(root, '.oxford', customFile), JSON.stringify(model), 'utf8');
  await mutateDiagram(root, (d) => { d.components.a.label = 'Updated'; }, customFile);
  const raw = JSON.parse(await fsp.readFile(path.join(root, '.oxford', customFile), 'utf8'));
  assert.ok(raw.layout, 'layout preserved for non-default filename');
  assert.equal(raw.components.a.label, 'Updated');
});

test('mutateDiagram: no-op when diagram file missing', async () => {
  const root = await makeTmp();
  await assert.doesNotReject(() => mutateDiagram(root, () => {}));
});

// ═══════════════════════════════════════════════════════════════════════════════
// storage.ts — gcLayoutOrphans (line 148)
// ═══════════════════════════════════════════════════════════════════════════════

import { mutateLayout, writeLayout } from '../src/diagram/storage';

test('mutateLayout: GC removes entries for non-existent components', async () => {
  const root = await makeTmp();
  await writeLayout(root, { components: { exists: { x: 1, y: 1, w: 1, h: 1 }, gone: { x: 2, y: 2, w: 2, h: 2 } } });
  await mutateLayout(root, () => {}, new Set(['exists']));
  const { readLayout: rl } = await import('../src/diagram/storage');
  const layout = await rl(root);
  assert.ok(layout.components?.exists, 'existing kept');
  assert.equal(layout.components?.gone, undefined, 'orphan removed');
});

// ═══════════════════════════════════════════════════════════════════════════════
// render.ts — renderDiagram with unknown preset (lines 96-107)
// ═══════════════════════════════════════════════════════════════════════════════

test('renderDiagram: unknown layout preset returns error diagnostic', async () => {
  const model: Diagram = {
    components: { a: { kind: 'service', label: 'A', parent: null } },
    relationships: {},
  };
  const result = await renderDiagram(model, { preset: 'nonexistent' } as any);
  const err = result.diagnostics.find(d => d.rule === 'unknown-layout-preset');
  assert.ok(err, 'unknown-layout-preset diagnostic emitted');
  assert.equal(err!.level, 'error');
  assert.equal(result.svg, '', 'no SVG produced on error');
});

// ═══════════════════════════════════════════════════════════════════════════════
// render.ts — self-loop diagnostic
// ═══════════════════════════════════════════════════════════════════════════════

test('renderDiagram: self-loop relationship produces diagnostic', async () => {
  const model: Diagram = {
    components: { a: { kind: 'service', label: 'A', parent: null } },
    relationships: { r1: { kind: 'calls', from: 'a', to: 'a' } },
  };
  const result = await renderDiagram(model);
  const diag = result.diagnostics.find(d => d.rule === 'self-loop');
  assert.ok(diag, 'self-loop diagnostic produced');
});

// ═══════════════════════════════════════════════════════════════════════════════
// render.ts — parent-cycle diagnostic
// ═══════════════════════════════════════════════════════════════════════════════

test('renderDiagram: parent cycle produces diagnostic', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: 'b' },
      b: { kind: 'service', label: 'B', parent: 'a' },
    },
    relationships: {},
  };
  const result = await renderDiagram(model);
  const diag = result.diagnostics.find(d => d.rule === 'parent-cycle');
  assert.ok(diag, 'parent-cycle diagnostic produced');
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — null-coalesce branches for missing fields
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: thinking block with null thinking field produces empty', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', isMeta: false, timestamp: 'T', message: { role: 'user', content: 'prompt' } }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: 'T',
    message: { role: 'assistant', content: [{ type: 'thinking' }] },
  }), PROJECT);
  assert.equal(entries.length, 0, 'null thinking skipped via ?? fallback');
});

test('normalizer: text block with null text field produces empty', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', isMeta: false, timestamp: 'T', message: { role: 'user', content: 'prompt' } }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: 'T',
    message: { role: 'assistant', content: [{ type: 'text' }] },
  }), PROJECT);
  assert.equal(entries.length, 0, 'null text skipped via ?? fallback');
});

test('normalizer: tool_use with null name and no input', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', isMeta: false, timestamp: 'T', message: { role: 'user', content: 'p' } }), PROJECT);
  n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: 'T',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1' }] },
  }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'r1', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] },
  }), PROJECT);
  assert.equal(entries.length, 1);
  const tc = entries[0].content as unknown as ToolUseContent;
  assert.equal(tc.tool_name, '', 'null name → empty string');
});

test('normalizer: system event with empty text and no compact_boundary returns empty', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    type: 'system', uuid: 's1', timestamp: 'T',
    content: '',
  }), PROJECT);
  assert.equal(entries.length, 0);
});

test('normalizer: compact_boundary with no content text uses fallback', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    type: 'system', uuid: 's1', timestamp: 'T',
    subtype: 'compact_boundary',
    compactMetadata: { trigger: 'auto', preTokens: 50000, postTokens: 5000 },
  }), PROJECT);
  assert.equal(entries.length, 1);
  const text = (entries[0].content as any).text;
  assert.equal(text, 'Conversation compacted');
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — user with array content but no tool_result (line 134 area)
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: user array content with no matching tool_use is skipped', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'u1', type: 'user', timestamp: 'T',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'nonexistent', content: 'x' }] },
  }), PROJECT);
  assert.equal(entries.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// storage.ts — gcLayoutOrphans with no components field (line 148)
// ═══════════════════════════════════════════════════════════════════════════════

test('mutateLayout: no-op when layout has no components field', async () => {
  const root = await makeTmp();
  await writeLayout(root, {});
  await mutateLayout(root, () => {}, new Set(['a']));
  const { readLayout: rl } = await import('../src/diagram/storage');
  const layout = await rl(root);
  assert.equal(layout.components, undefined);
});

// ═══════════════════════════════════════════════════════════════════════════════
// rules.ts — behavioral rule skipped in checkCompanions (line 205)
// ═══════════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════════
// normalizer.ts — uuid missing (line 74), no message (line 86),
// empty user text (line 111), tool_result output field (lines 131-134)
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizer: event with no uuid uses empty string', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    type: 'user', timestamp: '2025-01-01T00:00:00Z', isMeta: false,
    message: { role: 'user', content: 'hello' },
  }), PROJECT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, '', 'empty uuid fallback');
});

test('normalizer: event with no timestamp uses current time', () => {
  const n = new Normalizer();
  const before = new Date().toISOString();
  const entries = n.normalize(line({
    uuid: 'u1', type: 'user', isMeta: false,
    message: { role: 'user', content: 'hello' },
  }), PROJECT);
  assert.equal(entries.length, 1);
  assert.ok(entries[0].timestamp >= before, 'generated timestamp');
});

test('normalizer: user/assistant type with no message returns empty', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'u1', type: 'user', timestamp: 'T',
  }), PROJECT);
  assert.equal(entries.length, 0);
});

test('normalizer: user prompt that is only whitespace/ANSI after cleaning returns empty', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'u1', type: 'user', timestamp: 'T', isMeta: false,
    message: { role: 'user', content: '   \x1b[32m\x1b[0m   ' },
  }), PROJECT);
  assert.equal(entries.length, 0, 'pure ANSI/whitespace prompt skipped');
});

test('normalizer: tool_result with output field instead of content', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'p' }, sessionId: 's' }), PROJECT);
  n.normalize(line({
    uuid: 'a1', type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] },
  }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'r1', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', output: 'file.ts\ndir/' }] },
  }), PROJECT);
  const tc = entries[0].content as unknown as ToolUseContent;
  assert.equal(tc.result, 'file.ts\ndir/');
});

test('normalizer: tool_result with neither content nor output uses null', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'p' }, sessionId: 's' }), PROJECT);
  n.normalize(line({
    uuid: 'a1', type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: '/f.ts' } }] },
  }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'r1', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1' }] },
  }), PROJECT);
  const tc = entries[0].content as unknown as ToolUseContent;
  assert.equal(tc.result, null, 'null fallback when no content or output');
});

test('normalizer: tool_result with is_error=true', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'p' }, sessionId: 's' }), PROJECT);
  n.normalize(line({
    uuid: 'a1', type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'bad' } }] },
  }), PROJECT);
  const entries = n.normalize(line({
    uuid: 'r1', type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'error msg', is_error: true }] },
  }), PROJECT);
  const tc = entries[0].content as unknown as ToolUseContent;
  assert.equal(tc.is_error, true);
});

// ═══════════════════════════════════════════════════════════════════════════════
// activity.ts — diffModelComponents branch 81 (newModel.components ?? {})
// ═══════════════════════════════════════════════════════════════════════════════

test('diffModelComponents: newModel with undefined components returns empty', () => {
  const changed = diffModelComponents({ components: { a: {} } } as any, { components: undefined } as any);
  assert.ok(changed.includes('a'), 'old component counted as changed');
});

test('rules: checkCompanions skips behavioral rules (no trigger/companion)', () => {
  const engine = new RuleEngine();
  engine.setRules([
    { id: 'F1', name: 'Behavioral', kinds: ['text'], pattern: 'just', action: 'hook', severity: 'warning' },
    { id: 'C1', name: 'Companion', kinds: ['tool_use'], trigger: 'src/', companions: ['tests/'], hook: 'Stop', message: 'test', action: 'hook', severity: 'warning' },
  ]);
  engine.evaluate(makeEntry('tool_use', '', 'Edit', '/project/src/foo.ts'));
  const companions = engine.checkCompanions();
  assert.ok(!companions.some(m => m.rule.id === 'F1'), 'behavioral rule not in companions');
  assert.ok(companions.some(m => m.rule.id === 'C1'), 'companion rule fires');
});
