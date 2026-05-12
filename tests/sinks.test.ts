import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProcessResult } from '../src/audit/sinks';
import { MonitorSink, StatusBarSink, ActivitySink } from '../src/audit/sinks';
import type { AuditEntry } from '../src/audit/types';

let tmpDir = '';
afterEach(async () => {
  if (tmpDir) { await fsp.rm(tmpDir, { recursive: true, force: true }); tmpDir = ''; }
});
async function makeTmp(): Promise<string> {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'oxford-sinks-'));
  await fsp.mkdir(path.join(tmpDir, '.oxford'), { recursive: true });
  return tmpDir;
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

function makeMatch(id: string, severity: 'info' | 'warning' | 'error', action: 'hook' | 'monitor' | 'log' | 'notify' = 'hook') {
  return {
    rule: { id, name: `Rule ${id}`, kinds: ['text'] as string[], action, severity, message: `${id} fired`, hook: 'Stop' as const },
    entry: { id: 'e1', session_id: 's1', project_id: 'p1', conversation_id: 'c1', turn_id: 't1', timestamp: '2026-05-10T10:00:00Z', kind: 'text' as const, content: { text: 'hi' } },
    matchedText: 'matched',
  };
}

test('MonitorSink: writes formatted message for rule match', async () => {
  const root = await makeTmp();
  const sink = new MonitorSink(root, async (r, m) => {
    const fp = path.join(r, '.oxford', '.monitor_feed');
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    await fsp.appendFile(fp, m + '\n', 'utf8');
  });
  await sink.receive(makeResult({ ruleMatches: [makeMatch('F7', 'warning')] }));
  const feed = await fsp.readFile(path.join(root, '.oxford', '.monitor_feed'), 'utf8');
  assert.ok(feed.includes('[F7]'));
  assert.ok(feed.includes('F7 fired'));
});

test('MonitorSink: writes unverified model change message', async () => {
  const root = await makeTmp();
  const sink = new MonitorSink(root, async (r, m) => {
    const fp = path.join(r, '.oxford', '.monitor_feed');
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    await fsp.appendFile(fp, m + '\n', 'utf8');
  });
  await sink.receive(makeResult({ modelChanges: { changed: ['renderer'], unverified: [{ id: 'renderer', missingFile: 'src/render.ts' }] } }));
  const feed = await fsp.readFile(path.join(root, '.oxford', '.monitor_feed'), 'utf8');
  assert.ok(feed.includes('[UNVERIFIED]'));
  assert.ok(feed.includes('renderer'));
});

test('MonitorSink: skips matches with action=log', async () => {
  const root = await makeTmp();
  const sink = new MonitorSink(root, async (r, m) => {
    const fp = path.join(r, '.oxford', '.monitor_feed');
    await fsp.mkdir(path.dirname(fp), { recursive: true });
    await fsp.appendFile(fp, m + '\n', 'utf8');
  });
  await sink.receive(makeResult({ ruleMatches: [makeMatch('F7', 'warning', 'log')] }));
  const exists = await fsp.access(path.join(root, '.oxford', '.monitor_feed')).then(() => true).catch(() => false);
  assert.equal(exists, false, 'no feed file for log-only action');
});

test('StatusBarSink: increments warning count', async () => {
  const sink = new StatusBarSink();
  await sink.receive(makeResult({ ruleMatches: [makeMatch('F7', 'warning')] }));
  assert.equal(sink.warnings, 1);
  assert.equal(sink.errors, 0);
});

test('StatusBarSink: increments error count', async () => {
  const sink = new StatusBarSink();
  await sink.receive(makeResult({ ruleMatches: [makeMatch('F7', 'error')] }));
  assert.equal(sink.warnings, 0);
  assert.equal(sink.errors, 1);
});

test('ActivitySink: updates last_model_update for changed components', async () => {
  const root = await makeTmp();
  await fsp.writeFile(path.join(root, '.oxford', 'activity.json'), '{}', 'utf8');
  const sink = new ActivitySink(root);
  await sink.receive(makeResult({ modelChanges: { changed: ['renderer'], unverified: [] } }));
  const activity = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'activity.json'), 'utf8'));
  assert.ok(activity.renderer.last_model_update);
  assert.equal(activity.renderer.last_model_update_verified, true);
});

test('ActivitySink: sets verified=false for unverified components', async () => {
  const root = await makeTmp();
  await fsp.writeFile(path.join(root, '.oxford', 'activity.json'), '{}', 'utf8');
  const sink = new ActivitySink(root);
  await sink.receive(makeResult({ modelChanges: { changed: ['renderer'], unverified: [{ id: 'renderer', missingFile: 'src/render.ts' }] } }));
  const activity = JSON.parse(await fsp.readFile(path.join(root, '.oxford', 'activity.json'), 'utf8'));
  assert.equal(activity.renderer.last_model_update_verified, false);
});
