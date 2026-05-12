import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ActivityEntry } from '../src/diagram/types';
import { readActivity, writeActivity, matchesFileAnchor, buildAnchorMap, updateActivity, checkOrphanActivity, timeAgo, computeStaleness, diffModelComponents } from '../src/diagram/activity';

let tmpDir = '';

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

async function makeTmp(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxford-activity-'));
  await fs.mkdir(path.join(tmpDir, '.oxford'), { recursive: true });
  return tmpDir;
}

test('activity I/O: writeActivity then readActivity round-trips', async () => {
  const root = await makeTmp();
  const data: Record<string, ActivityEntry> = {
    daemon: { last_read: '2026-05-06T20:00:00.000Z', last_read_session: 'sess-1' },
  };
  await writeActivity(root, data);
  const result = await readActivity(root);
  assert.deepEqual(result, data);
});

test('activity I/O: readActivity returns empty object when file missing', async () => {
  const root = await makeTmp();
  const result = await readActivity(root);
  assert.deepEqual(result, {});
});

test('activity I/O: writeActivity overwrites existing data', async () => {
  const root = await makeTmp();
  await writeActivity(root, { a: { last_read: 'old', last_read_session: 's1' } });
  await writeActivity(root, { b: { last_read: 'new', last_read_session: 's2' } });
  const result = await readActivity(root);
  assert.equal(result.b?.last_read, 'new');
  assert.equal(result.a, undefined);
});

// --- matchesFileAnchor ---

test('matchesFileAnchor: relative anchor matches absolute path by suffix', () => {
  assert.equal(matchesFileAnchor('/Users/m/project/src/audit/daemon.ts', 'src/audit/daemon.ts'), true);
});

test('matchesFileAnchor: must match at path segment boundary', () => {
  assert.equal(matchesFileAnchor('/Users/m/project/src/foo.ts', 'oo.ts'), false);
  assert.equal(matchesFileAnchor('/Users/m/project/src/foo.ts', 'foo.ts'), true);
});

test('matchesFileAnchor: exact absolute match', () => {
  assert.equal(matchesFileAnchor('/Users/m/project/src/foo.ts', '/Users/m/project/src/foo.ts'), true);
});

test('matchesFileAnchor: non-matching path', () => {
  assert.equal(matchesFileAnchor('/Users/m/project/src/foo.ts', 'src/bar.ts'), false);
});

test('matchesFileAnchor: anchor with leading ./ is normalized', () => {
  assert.equal(matchesFileAnchor('/Users/m/project/src/foo.ts', './src/foo.ts'), true);
});

// --- buildAnchorMap ---

test('buildAnchorMap: maps file anchors to component IDs', () => {
  const diagram = {
    components: {
      daemon: { kind: 'process', label: 'Daemon', parent: null, anchors: [{ type: 'file', value: 'src/audit/daemon.ts' }] },
      renderer: { kind: 'module', label: 'Renderer', parent: null, anchors: [{ type: 'file', value: 'src/diagram/render.ts' }] },
    },
    relationships: {},
  };
  const map = buildAnchorMap(diagram);
  assert.deepEqual(map.get('src/audit/daemon.ts'), ['daemon']);
  assert.deepEqual(map.get('src/diagram/render.ts'), ['renderer']);
});

test('buildAnchorMap: skips components without anchors', () => {
  const diagram = {
    components: {
      user: { kind: 'actor', label: 'User', parent: null },
    },
    relationships: {},
  };
  const map = buildAnchorMap(diagram);
  assert.equal(map.size, 0);
});

test('buildAnchorMap: skips non-file anchors', () => {
  const diagram = {
    components: {
      ext: { kind: 'service', label: 'Ext', parent: null, anchors: [{ type: 'url', value: 'https://example.com' }] },
    },
    relationships: {},
  };
  const map = buildAnchorMap(diagram);
  assert.equal(map.size, 0);
});

test('buildAnchorMap: multiple components sharing a file both appear', () => {
  const diagram = {
    components: {
      a: { kind: 'module', label: 'A', parent: null, anchors: [{ type: 'file', value: 'src/shared.ts' }] },
      b: { kind: 'module', label: 'B', parent: null, anchors: [{ type: 'file', value: 'src/shared.ts' }] },
    },
    relationships: {},
  };
  const map = buildAnchorMap(diagram);
  const ids = map.get('src/shared.ts');
  assert.ok(ids);
  assert.ok(ids!.includes('a'));
  assert.ok(ids!.includes('b'));
});

// --- updateActivity ---

test('updateActivity: writes activity for matching component', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/audit/daemon.ts', ['daemon']]]);
  await updateActivity(root, anchorMap, ['/Users/m/project/src/audit/daemon.ts'], '2026-05-06T20:00:00Z', 'sess-1');
  const activity = await readActivity(root);
  assert.equal(activity.daemon?.last_read, '2026-05-06T20:00:00Z');
  assert.equal(activity.daemon?.last_read_session, 'sess-1');
});

test('updateActivity: no-op when no paths match', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/audit/daemon.ts', ['daemon']]]);
  await updateActivity(root, anchorMap, ['/Users/m/project/src/unrelated.ts'], '2026-05-06T20:00:00Z', 'sess-1');
  const activity = await readActivity(root);
  assert.deepEqual(activity, {});
});

test('updateActivity: does not overwrite with earlier timestamp', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/foo.ts', ['comp']]]);
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-06T21:00:00Z', 'sess-2');
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-06T20:00:00Z', 'sess-1');
  const activity = await readActivity(root);
  assert.equal(activity.comp?.last_read, '2026-05-06T21:00:00Z');
  assert.equal(activity.comp?.last_read_session, 'sess-2');
});

test('updateActivity: updates with later timestamp', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/foo.ts', ['comp']]]);
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-06T20:00:00Z', 'sess-1');
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-06T21:00:00Z', 'sess-2');
  const activity = await readActivity(root);
  assert.equal(activity.comp?.last_read, '2026-05-06T21:00:00Z');
  assert.equal(activity.comp?.last_read_session, 'sess-2');
});

// --- checkOrphanActivity ---

test('checkOrphanActivity: flags activity for nonexistent component', () => {
  const componentIds = new Set(['daemon', 'renderer']);
  const activity = {
    daemon: { last_read: '2026-01-01T00:00:00Z', last_read_session: 's1' },
    ghost: { last_read: '2026-01-01T00:00:00Z', last_read_session: 's2' },
  };
  const diags = checkOrphanActivity(componentIds, activity);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].rule, 'orphan-activity');
  assert.ok(diags[0].message.includes('ghost'));
});

test('checkOrphanActivity: no warnings when all entries match', () => {
  const componentIds = new Set(['daemon']);
  const activity = { daemon: { last_read: '2026-01-01T00:00:00Z', last_read_session: 's1' } };
  const diags = checkOrphanActivity(componentIds, activity);
  assert.equal(diags.length, 0);
});

test('checkOrphanActivity: empty activity returns no warnings', () => {
  const componentIds = new Set(['daemon']);
  const diags = checkOrphanActivity(componentIds, {});
  assert.equal(diags.length, 0);
});

// --- timeAgo ---

test('timeAgo: recent timestamp shows seconds', () => {
  const now = new Date(Date.now() - 30_000).toISOString();
  assert.match(timeAgo(now), /^\d+s ago$/);
});

test('timeAgo: minutes ago', () => {
  const fiveMin = new Date(Date.now() - 5 * 60_000).toISOString();
  assert.match(timeAgo(fiveMin), /^5m ago$/);
});

test('timeAgo: hours ago', () => {
  const twoHours = new Date(Date.now() - 2 * 3600_000).toISOString();
  assert.match(timeAgo(twoHours), /^2h ago$/);
});

test('timeAgo: days ago', () => {
  const threeDays = new Date(Date.now() - 3 * 86400_000).toISOString();
  assert.match(timeAgo(threeDays), /^3d ago$/);
});

test('timeAgo: future timestamp returns just now', () => {
  const future = new Date(Date.now() + 60_000).toISOString();
  assert.equal(timeAgo(future), 'just now');
});

test('timeAgo: invalid ISO string returns empty string', () => {
  assert.equal(timeAgo('not-a-date'), '');
});

test('timeAgo: empty string returns empty string', () => {
  assert.equal(timeAgo(''), '');
});

// --- updateActivity with toolName (Phase 1) ---

test('updateActivity with Read tool updates last_read only', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/foo.ts', ['comp']]]);
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-10T10:00:00Z', 'sess-1', 'Read');
  const activity = await readActivity(root);
  assert.equal(activity.comp?.last_read, '2026-05-10T10:00:00Z');
  assert.equal(activity.comp?.last_edit, undefined);
});

test('updateActivity with Edit tool updates last_edit only', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/foo.ts', ['comp']]]);
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-10T10:00:00Z', 'sess-1', 'Edit');
  const activity = await readActivity(root);
  assert.equal(activity.comp?.last_edit, '2026-05-10T10:00:00Z');
  assert.equal(activity.comp?.last_edit_session, 'sess-1');
  assert.equal(activity.comp?.last_read, '', 'last_read is empty string (not set)');
});

test('updateActivity with Write tool updates last_edit', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/foo.ts', ['comp']]]);
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-10T10:00:00Z', 'sess-1', 'Write');
  const activity = await readActivity(root);
  assert.equal(activity.comp?.last_edit, '2026-05-10T10:00:00Z');
  assert.equal(activity.comp?.last_edit_session, 'sess-1');
});

test('updateActivity preserves existing last_read when edit arrives', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/foo.ts', ['comp']]]);
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-10T09:00:00Z', 'sess-1', 'Read');
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-10T10:00:00Z', 'sess-2', 'Edit');
  const activity = await readActivity(root);
  assert.equal(activity.comp?.last_read, '2026-05-10T09:00:00Z');
  assert.equal(activity.comp?.last_read_session, 'sess-1');
  assert.equal(activity.comp?.last_edit, '2026-05-10T10:00:00Z');
  assert.equal(activity.comp?.last_edit_session, 'sess-2');
});

test('updateActivity without toolName defaults to last_read', async () => {
  const root = await makeTmp();
  const anchorMap = new Map([['src/foo.ts', ['comp']]]);
  await updateActivity(root, anchorMap, ['/p/src/foo.ts'], '2026-05-10T10:00:00Z', 'sess-1');
  const activity = await readActivity(root);
  assert.equal(activity.comp?.last_read, '2026-05-10T10:00:00Z');
  assert.equal(activity.comp?.last_edit, undefined);
});

// --- computeStaleness (Phase 2) ---

test('computeStaleness: no last_edit returns fresh', () => {
  assert.equal(computeStaleness({ last_read: '2026-05-10T10:00:00Z', last_read_session: 's1' }), 'fresh');
});

test('computeStaleness: last_read after last_edit returns fresh', () => {
  assert.equal(computeStaleness({
    last_read: '2026-05-10T11:00:00Z', last_read_session: 's1',
    last_edit: '2026-05-10T10:00:00Z', last_edit_session: 's1',
  }), 'fresh');
});

test('computeStaleness: last_edit after last_read returns stale', () => {
  assert.equal(computeStaleness({
    last_read: '2026-05-10T10:00:00Z', last_read_session: 's1',
    last_edit: '2026-05-10T11:00:00Z', last_edit_session: 's2',
  }), 'stale');
});

test('computeStaleness: equal timestamps returns fresh', () => {
  assert.equal(computeStaleness({
    last_read: '2026-05-10T10:00:00Z', last_read_session: 's1',
    last_edit: '2026-05-10T10:00:00Z', last_edit_session: 's1',
  }), 'fresh');
});

test('computeStaleness: missing last_read returns unknown', () => {
  assert.equal(computeStaleness({
    last_read: '', last_read_session: '',
    last_edit: '2026-05-10T10:00:00Z', last_edit_session: 's1',
  }), 'unknown');
});

// --- computeStaleness v2 (Phase 5) ---

test('computeStaleness v2: verified model update after file edit = fresh', () => {
  assert.equal(computeStaleness({
    last_read: '2026-05-10T09:00:00Z', last_read_session: 's1',
    last_edit: '2026-05-10T10:00:00Z', last_edit_session: 's1',
    last_model_update: '2026-05-10T11:00:00Z', last_model_update_verified: true,
  }), 'fresh');
});

test('computeStaleness v2: file edited after model update = stale', () => {
  assert.equal(computeStaleness({
    last_read: '2026-05-10T09:00:00Z', last_read_session: 's1',
    last_edit: '2026-05-10T12:00:00Z', last_edit_session: 's1',
    last_model_update: '2026-05-10T11:00:00Z', last_model_update_verified: true,
  }), 'stale');
});

test('computeStaleness v2: unverified model update = stale', () => {
  assert.equal(computeStaleness({
    last_read: '2026-05-10T09:00:00Z', last_read_session: 's1',
    last_edit: '2026-05-10T10:00:00Z', last_edit_session: 's1',
    last_model_update: '2026-05-10T11:00:00Z', last_model_update_verified: false,
  }), 'stale');
});

// --- diffModelComponents (Phase 3) ---

test('diffModelComponents: detects added component', () => {
  const oldModel = { components: { a: { kind: 'svc', label: 'A' } }, relationships: {} };
  const newModel = { components: { a: { kind: 'svc', label: 'A' }, b: { kind: 'svc', label: 'B' } }, relationships: {} };
  const changed = diffModelComponents(oldModel, newModel);
  assert.ok(changed.includes('b'), 'new component b detected');
  assert.ok(!changed.includes('a'), 'unchanged component a not included');
});

test('diffModelComponents: detects modified description', () => {
  const oldModel = { components: { a: { kind: 'svc', label: 'A', description: 'old' } }, relationships: {} };
  const newModel = { components: { a: { kind: 'svc', label: 'A', description: 'new' } }, relationships: {} };
  const changed = diffModelComponents(oldModel, newModel);
  assert.ok(changed.includes('a'), 'modified component a detected');
});

test('diffModelComponents: unchanged model returns empty', () => {
  const model = { components: { a: { kind: 'svc', label: 'A' } }, relationships: {} };
  const changed = diffModelComponents(model, model);
  assert.equal(changed.length, 0);
});

test('diffModelComponents: detects deleted component', () => {
  const oldModel = { components: { a: { kind: 'svc', label: 'A' }, b: { kind: 'svc', label: 'B' } }, relationships: {} };
  const newModel = { components: { a: { kind: 'svc', label: 'A' } }, relationships: {} };
  const changed = diffModelComponents(oldModel, newModel);
  assert.ok(changed.includes('b'), 'deleted component b detected');
});

test('diffModelComponents: null/undefined old model treats all as new', () => {
  const newModel = { components: { a: { kind: 'svc', label: 'A' } }, relationships: {} };
  const changed = diffModelComponents(null as any, newModel);
  assert.ok(changed.includes('a'));
});
