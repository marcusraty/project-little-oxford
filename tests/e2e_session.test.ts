// E2E test: JSONL transcript → normalizer → audit entries → activity updates.
// Tests the AuditEngine's core processing pipeline without VS Code APIs
// (no file watchers — we call processSession directly).

import { test, afterEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { Normalizer } from '../src/audit/normalizer';
import type { AuditEntry, ToolUseContent } from '../src/audit/types';
import { buildAnchorMap, updateActivity, readActivity } from '../src/diagram/activity';
import { readDiagram } from '../src/diagram/storage';

const SESSION_MODEL = require('./fixtures/session_model.json');
const TRANSCRIPT_PATH = path.join(__dirname, '..', 'tests', 'fixtures', 'session_transcript.jsonl');

let cleanup: (() => Promise<void>) | undefined;

afterEach(async () => {
  if (cleanup) {
    await cleanup();
    cleanup = undefined;
  }
});

async function setup(): Promise<{ root: string; transcriptPath: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'lo-e2e-'));
  await fsp.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fsp.writeFile(
    path.join(root, '.oxford', 'model.json'),
    JSON.stringify(SESSION_MODEL, null, 2),
    'utf8',
  );

  const transcriptSrc = path.join(__dirname, '..', 'tests', 'fixtures', 'session_transcript.jsonl');
  const transcriptDest = path.join(root, 'transcript.jsonl');
  await fsp.copyFile(transcriptSrc, transcriptDest);

  cleanup = async () => {
    await fsp.rm(root, { recursive: true, force: true });
  };

  return { root, transcriptPath: transcriptDest };
}

async function processTranscript(
  transcriptPath: string,
  projectId: string,
): Promise<{ entries: AuditEntry[]; sessionTitle: string; conversationId: string }> {
  const normalizer = new Normalizer('test-session');
  const raw = await fsp.readFile(transcriptPath, 'utf8');
  const lines = raw.split('\n').filter((l) => l.trim());
  const entries: AuditEntry[] = [];
  let sessionTitle = '';
  let conversationId = '';

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type === 'custom-title' && typeof parsed.customTitle === 'string') {
        sessionTitle = parsed.customTitle;
        continue;
      }
    } catch { /* normalizer handles */ }

    const normalized = normalizer.normalize(line, projectId);
    for (const entry of normalized) {
      entries.push(entry);
      if (!conversationId && entry.conversation_id) {
        conversationId = entry.conversation_id;
      }
    }
  }

  return { entries, sessionTitle, conversationId };
}

test('e2e: transcript produces expected audit entry kinds', async () => {
  const { root, transcriptPath } = await setup();
  const { entries } = await processTranscript(transcriptPath, 'test-project');

  const kinds = entries.map((e) => e.kind);
  assert.ok(kinds.includes('user_prompt'), 'has user_prompt');
  assert.ok(kinds.includes('thinking'), 'has thinking');
  assert.ok(kinds.includes('text'), 'has text');
  assert.ok(kinds.includes('tool_use'), 'has tool_use');
});

test('e2e: custom-title event is extracted', async () => {
  const { root, transcriptPath } = await setup();
  const { sessionTitle } = await processTranscript(transcriptPath, 'test-project');

  assert.equal(sessionTitle, 'Test session');
});

test('e2e: tool_use entries have touched_paths', async () => {
  const { root, transcriptPath } = await setup();
  const { entries } = await processTranscript(transcriptPath, 'test-project');

  const toolUses = entries.filter((e) => e.kind === 'tool_use');
  assert.ok(toolUses.length >= 1, 'at least one tool_use');

  for (const tu of toolUses) {
    const content = tu.content as unknown as ToolUseContent;
    assert.ok(content.tool_name, 'has tool_name');
    assert.ok(Array.isArray(content.touched_paths), 'has touched_paths array');
    assert.ok(content.touched_paths.length > 0, 'touched_paths not empty');
  }
});

test('e2e: tool_use Read has result merged from tool_result', async () => {
  const { root, transcriptPath } = await setup();
  const { entries } = await processTranscript(transcriptPath, 'test-project');

  const readEntry = entries.find(
    (e) => e.kind === 'tool_use' && (e.content as unknown as ToolUseContent).tool_name === 'Read',
  );
  assert.ok(readEntry, 'Read tool_use found');
  const content = readEntry!.content as unknown as ToolUseContent;
  assert.ok(content.result !== undefined, 'result merged from tool_result');
  assert.equal(content.is_error, false, 'not an error');
});

test('e2e: tool_use Edit has result merged from tool_result', async () => {
  const { root, transcriptPath } = await setup();
  const { entries } = await processTranscript(transcriptPath, 'test-project');

  const editEntry = entries.find(
    (e) => e.kind === 'tool_use' && (e.content as unknown as ToolUseContent).tool_name === 'Edit',
  );
  assert.ok(editEntry, 'Edit tool_use found');
  const content = editEntry!.content as unknown as ToolUseContent;
  assert.ok(content.result !== undefined, 'result merged from tool_result');
});

test('e2e: activity updates when tool_use paths match component anchors', async () => {
  const { root, transcriptPath } = await setup();
  const { entries } = await processTranscript(transcriptPath, 'test-project');

  const diagram = await readDiagram(root);
  assert.ok(diagram);
  const anchorMap = buildAnchorMap(diagram);

  const toolUses = entries.filter((e) => e.kind === 'tool_use');
  for (const tu of toolUses) {
    const content = tu.content as unknown as ToolUseContent;
    if (content.touched_paths?.length) {
      await updateActivity(root, anchorMap, content.touched_paths, tu.timestamp, 'test-session');
    }
  }

  const activity = await readActivity(root);
  assert.ok(activity.server, 'server component has activity (src/server.ts was touched)');
  assert.ok(activity.server.last_read, 'has last_read timestamp');
  assert.equal(activity.server.last_read_session, 'test-session', 'session ID recorded');
});

test('e2e: activity does NOT update for unmatched paths', async () => {
  const { root, transcriptPath } = await setup();
  const { entries } = await processTranscript(transcriptPath, 'test-project');

  const diagram = await readDiagram(root);
  assert.ok(diagram);
  const anchorMap = buildAnchorMap(diagram);

  const toolUses = entries.filter((e) => e.kind === 'tool_use');
  for (const tu of toolUses) {
    const content = tu.content as unknown as ToolUseContent;
    if (content.touched_paths?.length) {
      await updateActivity(root, anchorMap, content.touched_paths, tu.timestamp, 'test-session');
    }
  }

  const activity = await readActivity(root);
  assert.equal(activity.client, undefined, 'client component has no activity (src/client.ts was NOT touched)');
});

test('e2e: audit log is appendable', async () => {
  const { root, transcriptPath } = await setup();
  const { entries } = await processTranscript(transcriptPath, 'test-project');

  const auditLogPath = path.join(root, '.oxford', 'audit.jsonl');
  const lines = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await fsp.writeFile(auditLogPath, lines, 'utf8');

  const written = await fsp.readFile(auditLogPath, 'utf8');
  const parsedBack = written.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(parsedBack.length, entries.length, 'all entries roundtrip');
  assert.equal(parsedBack[0].kind, entries[0].kind, 'first entry kind matches');
});

test('e2e: normalizer handles partial lines gracefully', async () => {
  const { root } = await setup();
  const normalizer = new Normalizer('test-session');

  const entries = normalizer.normalize('{"broken json', 'test-project');
  assert.equal(entries.length, 0, 'partial JSON produces no entries');

  const entries2 = normalizer.normalize('', 'test-project');
  assert.equal(entries2.length, 0, 'empty line produces no entries');

  const valid = normalizer.normalize(
    JSON.stringify({ type: 'user', uuid: 'x', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } }),
    'test-project',
  );
  assert.equal(valid.length, 1, 'valid line still works after partial lines');
});

test('e2e: multiple sessions produce separate entries', async () => {
  const n1 = new Normalizer('session-1');
  const n2 = new Normalizer('session-2');

  const line = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hello' } });

  const e1 = n1.normalize(line, 'proj');
  const e2 = n2.normalize(line, 'proj');

  assert.equal(e1[0].session_id, 'session-1');
  assert.equal(e2[0].session_id, 'session-2');
});
