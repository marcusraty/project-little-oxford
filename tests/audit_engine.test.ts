import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeMonitorMessage, readHeartbeat, isMonitorRunning } from '../src/vscode_extension/monitor';
import { routeActivityPaths } from '../src/audit/activity_routing';
import type { AuditEntry } from '../src/audit/types';

let tmpDir = '';

afterEach(async () => {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    tmpDir = '';
  }
});

async function makeTmp(): Promise<string> {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'oxford-audit-dedup-'));
  await fs.mkdir(path.join(tmpDir, '.oxford'), { recursive: true });
  return tmpDir;
}

test('audit dedup: duplicate entries in audit.jsonl are detectable by ID', async () => {
  const root = await makeTmp();
  const auditPath = path.join(root, '.oxford', 'audit.jsonl');
  const entries = [
    { id: 'a1', kind: 'text', content: { text: 'hello' }, timestamp: 1000, session_id: 's1' },
    { id: 'a2', kind: 'tool_use', content: { tool_name: 'Read' }, timestamp: 1001, session_id: 's1' },
    { id: 'a1', kind: 'text', content: { text: 'hello' }, timestamp: 1000, session_id: 's1' },
  ];
  await fs.writeFile(auditPath, entries.map(e => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const lines = (await fs.readFile(auditPath, 'utf8')).trim().split('\n');
  const ids = lines.map(l => JSON.parse(l).id);
  const unique = new Set(ids);
  assert.equal(ids.length, 3, '3 total lines');
  assert.equal(unique.size, 2, '2 unique IDs — duplicate detected');
});

test('audit dedup: seenIds set skips already-processed entries', async () => {
  const seenIds = new Set(['a1', 'a2']);
  const newEntries = [
    { id: 'a1', kind: 'text' },
    { id: 'a3', kind: 'text' },
    { id: 'a2', kind: 'tool_use' },
    { id: 'a4', kind: 'thinking' },
  ];
  const filtered = newEntries.filter(e => !seenIds.has(e.id));
  assert.equal(filtered.length, 2, 'only 2 new entries pass filter');
  assert.equal(filtered[0].id, 'a3');
  assert.equal(filtered[1].id, 'a4');
});

test('audit dedup: empty audit.jsonl yields empty seenIds', async () => {
  const root = await makeTmp();
  const auditPath = path.join(root, '.oxford', 'audit.jsonl');
  // File doesn't exist — should produce empty set
  const ids = new Set<string>();
  try {
    const content = await fs.readFile(auditPath, 'utf8');
    for (const line of content.trim().split('\n')) {
      if (!line) continue;
      try { ids.add(JSON.parse(line).id); } catch {}
    }
  } catch { /* file missing */ }
  assert.equal(ids.size, 0, 'no seen IDs when file is missing');
});

// --- activity routing: the audit engine must split Read vs Edit/Write ---

function makeToolEntry(tool: string, filePath: string, ts: string): AuditEntry {
  return {
    id: 'test-' + Math.random().toString(36).slice(2),
    session_id: 's1', project_id: 'p1', conversation_id: 'c1', turn_id: 't1',
    timestamp: ts, kind: 'tool_use',
    content: { tool_name: tool, input: { file_path: filePath }, touched_paths: [filePath] },
  };
}

test('routeActivityPaths: Edit goes to editPaths', () => {
  const result = routeActivityPaths([makeToolEntry('Edit', '/p/src/webview.ts', '2026-05-10T15:00:00Z')]);
  assert.equal(result.editPaths.length, 1);
  assert.equal(result.readPaths.length, 0);
  assert.ok(result.editPaths[0].includes('webview.ts'));
});

test('routeActivityPaths: Write goes to editPaths', () => {
  const result = routeActivityPaths([makeToolEntry('Write', '/p/src/webview.ts', '2026-05-10T15:00:00Z')]);
  assert.equal(result.editPaths.length, 1);
  assert.equal(result.readPaths.length, 0);
});

test('routeActivityPaths: Read goes to readPaths', () => {
  const result = routeActivityPaths([makeToolEntry('Read', '/p/src/render.ts', '2026-05-10T15:00:00Z')]);
  assert.equal(result.readPaths.length, 1);
  assert.equal(result.editPaths.length, 0);
});

test('routeActivityPaths: Bash goes to readPaths', () => {
  const result = routeActivityPaths([makeToolEntry('Bash', '/p/src/foo.ts', '2026-05-10T15:00:00Z')]);
  assert.equal(result.readPaths.length, 1);
  assert.equal(result.editPaths.length, 0);
});

test('routeActivityPaths: mixed entries split correctly', () => {
  const entries = [
    makeToolEntry('Read', '/p/src/a.ts', '2026-05-10T15:00:00Z'),
    makeToolEntry('Edit', '/p/src/b.ts', '2026-05-10T15:01:00Z'),
    makeToolEntry('Write', '/p/src/c.ts', '2026-05-10T15:02:00Z'),
    makeToolEntry('Bash', '/p/src/d.ts', '2026-05-10T15:03:00Z'),
  ];
  const result = routeActivityPaths(entries);
  assert.equal(result.readPaths.length, 2, 'Read + Bash');
  assert.equal(result.editPaths.length, 2, 'Edit + Write');
  assert.equal(result.editTimestamp, '2026-05-10T15:02:00Z');
  assert.equal(result.readTimestamp, '2026-05-10T15:03:00Z');
});

// --- Bash write detection ---

function makeBashEntry(command: string, touchedPaths: string[], ts: string): AuditEntry {
  return {
    id: 'test-' + Math.random().toString(36).slice(2),
    session_id: 's1', project_id: 'p1', conversation_id: 'c1', turn_id: 't1',
    timestamp: ts, kind: 'tool_use',
    content: { tool_name: 'Bash', input: { command }, touched_paths: touchedPaths },
  };
}

test('routeActivityPaths: Bash with > redirect goes to editPaths', () => {
  const entry = makeBashEntry('echo "hello" > /p/src/foo.ts', ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 1, '> redirect = write');
  assert.equal(result.readPaths.length, 0);
});

test('routeActivityPaths: Bash with >> append goes to editPaths', () => {
  const entry = makeBashEntry('echo "line" >> /p/src/foo.ts', ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 1, '>> append = write');
});

test('routeActivityPaths: Bash sed -i goes to editPaths', () => {
  const entry = makeBashEntry("sed -i 's/old/new/g' /p/src/foo.ts", ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 1, 'sed -i = write');
});

test('routeActivityPaths: Bash rm goes to editPaths', () => {
  const entry = makeBashEntry('rm /p/src/foo.ts', ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 1, 'rm = write');
});

test('routeActivityPaths: Bash mv goes to editPaths', () => {
  const entry = makeBashEntry('mv /p/src/old.ts /p/src/new.ts', ['/p/src/old.ts', '/p/src/new.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 2, 'mv = write');
});

test('routeActivityPaths: Bash cp goes to editPaths', () => {
  const entry = makeBashEntry('cp /p/src/a.ts /p/src/b.ts', ['/p/src/a.ts', '/p/src/b.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 2, 'cp = write');
});

test('routeActivityPaths: Bash tee goes to editPaths', () => {
  const entry = makeBashEntry('echo "data" | tee /p/src/foo.ts', ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 1, 'tee = write');
});

test('routeActivityPaths: Bash chmod goes to editPaths', () => {
  const entry = makeBashEntry('chmod +x /p/src/foo.sh', ['/p/src/foo.sh'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 1, 'chmod = write');
});

test('routeActivityPaths: Bash cat (read) stays in readPaths', () => {
  const entry = makeBashEntry('cat /p/src/foo.ts', ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.readPaths.length, 1, 'cat = read');
  assert.equal(result.editPaths.length, 0);
});

test('routeActivityPaths: Bash grep stays in readPaths', () => {
  const entry = makeBashEntry('grep -n "pattern" /p/src/foo.ts', ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.readPaths.length, 1, 'grep = read');
  assert.equal(result.editPaths.length, 0);
});

test('routeActivityPaths: Bash npm run stays in readPaths (ambiguous)', () => {
  const entry = makeBashEntry('npm run build 2>&1 | tail -3', [], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 0, 'npm run = ambiguous, default to read');
});

test('routeActivityPaths: Bash 2>/dev/null is NOT a write', () => {
  const entry = makeBashEntry('cat /p/src/foo.ts 2>/dev/null', ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.readPaths.length, 1, '2>/dev/null is suppression, not a write');
  assert.equal(result.editPaths.length, 0);
});

test('routeActivityPaths: Bash : > file (truncate) goes to editPaths', () => {
  const entry = makeBashEntry(': > /p/src/foo.ts', ['/p/src/foo.ts'], '2026-05-10T15:00:00Z');
  const result = routeActivityPaths([entry]);
  assert.equal(result.editPaths.length, 1, ': > = truncate = write');
});

test('routeActivityPaths: text entries are ignored', () => {
  const entry: AuditEntry = {
    id: 'x', session_id: 's1', project_id: 'p1', conversation_id: 'c1', turn_id: 't1',
    timestamp: '2026-05-10T15:00:00Z', kind: 'text', content: { text: 'hello' },
  };
  const result = routeActivityPaths([entry]);
  assert.equal(result.readPaths.length, 0);
  assert.equal(result.editPaths.length, 0);
});

// --- monitor feed (Phase 1) ---

test('monitor: writeMonitorMessage appends line to .monitor_feed', async () => {
  const root = await makeTmp();
  await writeMonitorMessage(root, '[F7] Assumed-ok: Run the tests.');
  const content = await fs.readFile(path.join(root, '.oxford', '.monitor_feed'), 'utf8');
  assert.equal(content, '[F7] Assumed-ok: Run the tests.\n');
});

test('monitor: writeMonitorMessage creates file if missing', async () => {
  const root = await makeTmp();
  await writeMonitorMessage(root, 'hello');
  const exists = await fs.access(path.join(root, '.oxford', '.monitor_feed')).then(() => true).catch(() => false);
  assert.ok(exists, '.monitor_feed created');
});

test('monitor: multiple messages appear on separate lines', async () => {
  const root = await makeTmp();
  await writeMonitorMessage(root, 'first');
  await writeMonitorMessage(root, 'second');
  await writeMonitorMessage(root, 'third');
  const content = await fs.readFile(path.join(root, '.oxford', '.monitor_feed'), 'utf8');
  assert.equal(content, 'first\nsecond\nthird\n');
});

// --- heartbeat (Phase 3) ---

test('monitor: readHeartbeat returns null when file missing', async () => {
  const root = await makeTmp();
  const result = await readHeartbeat(root);
  assert.equal(result, null);
});

test('monitor: readHeartbeat returns timestamp when file exists', async () => {
  const root = await makeTmp();
  const now = Math.floor(Date.now() / 1000);
  await fs.writeFile(path.join(root, '.oxford', '.monitor_heartbeat'), String(now), 'utf8');
  const result = await readHeartbeat(root);
  assert.equal(result, now);
});

test('monitor: isMonitorRunning returns true when heartbeat < 5s old', async () => {
  const root = await makeTmp();
  const now = Math.floor(Date.now() / 1000);
  await fs.writeFile(path.join(root, '.oxford', '.monitor_heartbeat'), String(now), 'utf8');
  const running = await isMonitorRunning(root);
  assert.equal(running, true);
});

test('monitor: isMonitorRunning returns false when heartbeat > 5s old', async () => {
  const root = await makeTmp();
  const old = Math.floor(Date.now() / 1000) - 10;
  await fs.writeFile(path.join(root, '.oxford', '.monitor_heartbeat'), String(old), 'utf8');
  const running = await isMonitorRunning(root);
  assert.equal(running, false);
});
