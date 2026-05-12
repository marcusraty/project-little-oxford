import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { Normalizer } from '../src/audit/normalizer';

const PROJECT = '/test/project';

function line(obj: Record<string, unknown>): string {
  return JSON.stringify(obj);
}

test('normalizer: real user prompt sets turn_id', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'u1',
    type: 'user',
    sessionId: 'sess-1',
    timestamp: '2025-01-01T00:00:00Z',
    isMeta: false,
    message: { role: 'user', content: 'Fix the bug' },
  }), PROJECT);

  assert.equal(entries.length, 1);
  const e = entries[0];
  assert.equal(e.kind, 'user_prompt');
  assert.equal(e.id, 'u1');
  assert.equal(e.turn_id, 'u1');
  assert.equal(e.conversation_id, 'sess-1');
  assert.deepEqual(e.content, { text: 'Fix the bug' });
});

test('normalizer: meta user message is skipped', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'u2',
    type: 'user',
    timestamp: '2025-01-01T00:00:00Z',
    isMeta: true,
    message: { role: 'user', content: 'some meta thing' },
  }), PROJECT);
  assert.equal(entries.length, 0);
});

test('normalizer: thinking content block', () => {
  const n = new Normalizer();
  n.normalize(line({
    uuid: 'u1', type: 'user', isMeta: false, timestamp: '2025-01-01T00:00:00Z',
    message: { role: 'user', content: 'prompt' },
  }), PROJECT);

  const entries = n.normalize(line({
    uuid: 'a1',
    type: 'assistant',
    timestamp: '2025-01-01T00:00:01Z',
    message: {
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'Let me think about this...' }],
    },
  }), PROJECT);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'thinking');
  assert.equal(entries[0].turn_id, 'u1');
  assert.deepEqual(entries[0].content, { text: 'Let me think about this...' });
});

test('normalizer: text content block', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'a2',
    type: 'assistant',
    timestamp: '2025-01-01T00:00:01Z',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: 'Here is my answer.' }],
    },
  }), PROJECT);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'text');
  assert.deepEqual(entries[0].content, { text: 'Here is my answer.' });
});

test('normalizer: tool_use + tool_result merge', () => {
  const n = new Normalizer();

  const assistantEntries = n.normalize(line({
    uuid: 'a3',
    type: 'assistant',
    timestamp: '2025-01-01T00:00:01Z',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tu-1',
        name: 'Read',
        input: { file_path: '/foo/bar.ts' },
      }],
    },
  }), PROJECT);

  assert.equal(assistantEntries.length, 0, 'tool_use is held until result arrives');

  const resultEntries = n.normalize(line({
    uuid: 'u3',
    type: 'user',
    timestamp: '2025-01-01T00:00:02Z',
    isMeta: false,
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: 'tu-1',
        content: 'file contents here',
      }],
    },
  }), PROJECT);

  assert.equal(resultEntries.length, 1);
  const e = resultEntries[0];
  assert.equal(e.kind, 'tool_use');
  assert.equal(e.id, 'tu-1');
  const c = e.content as { tool_name: string; input: Record<string, unknown>; result: unknown; is_error: boolean };
  assert.equal(c.tool_name, 'Read');
  assert.deepEqual(c.input, { file_path: '/foo/bar.ts' });
  assert.equal(c.result, 'file contents here');
  assert.equal(c.is_error, false);
  assert.ok(e.raw_event, 'tool_use entries keep raw_event');
});

test('normalizer: errored tool result', () => {
  const n = new Normalizer();
  n.normalize(line({
    uuid: 'a4', type: 'assistant', timestamp: '2025-01-01T00:00:01Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-2', name: 'Bash', input: { command: 'ls' } }] },
  }), PROJECT);

  const entries = n.normalize(line({
    uuid: 'u4', type: 'user', timestamp: '2025-01-01T00:00:02Z', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: 'permission denied', is_error: true }] },
  }), PROJECT);

  assert.equal(entries.length, 1);
  assert.equal((entries[0].content as { is_error: boolean }).is_error, true);
});

test('normalizer: system message', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 's1',
    type: 'system',
    timestamp: '2025-01-01T00:00:00Z',
    message: { role: 'system', content: 'You are a helpful assistant.' },
  }), PROJECT);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'system');
  assert.deepEqual(entries[0].content, { text: 'You are a helpful assistant.' });
});

test('normalizer: skips metadata event types', () => {
  const n = new Normalizer();
  for (const type of ['file-history-snapshot', 'permission-mode', 'lock', 'unlock', 'summary', 'config']) {
    const entries = n.normalize(line({
      uuid: 'x', type, timestamp: '2025-01-01T00:00:00Z',
      message: { role: 'system', content: 'whatever' },
    }), PROJECT);
    assert.equal(entries.length, 0, `${type} should be skipped`);
  }
});

test('normalizer: turn_id carries forward across assistant messages', () => {
  const n = new Normalizer();
  n.normalize(line({
    uuid: 'turn-a', type: 'user', isMeta: false, timestamp: '2025-01-01T00:00:00Z',
    message: { role: 'user', content: 'first prompt' },
  }), PROJECT);

  const e1 = n.normalize(line({
    uuid: 'a1', type: 'assistant', timestamp: '2025-01-01T00:00:01Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
  }), PROJECT);
  assert.equal(e1[0].turn_id, 'turn-a');

  n.normalize(line({
    uuid: 'turn-b', type: 'user', isMeta: false, timestamp: '2025-01-01T00:00:02Z',
    message: { role: 'user', content: 'second prompt' },
  }), PROJECT);

  const e2 = n.normalize(line({
    uuid: 'a2', type: 'assistant', timestamp: '2025-01-01T00:00:03Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] },
  }), PROJECT);
  assert.equal(e2[0].turn_id, 'turn-b');
});

test('normalizer: multiple content blocks in one assistant message', () => {
  const n = new Normalizer();
  const entries = n.normalize(line({
    uuid: 'a5',
    type: 'assistant',
    timestamp: '2025-01-01T00:00:01Z',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'ok here' },
      ],
    },
  }), PROJECT);

  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'thinking');
  assert.equal(entries[0].id, 'a5-0');
  assert.equal(entries[1].kind, 'text');
  assert.equal(entries[1].id, 'a5-1');
});

test('normalizer: invalid JSON line returns empty', () => {
  const n = new Normalizer();
  assert.deepEqual(n.normalize('not json at all', PROJECT), []);
});

test('normalizer: flush emits unmatched tool_use entries', () => {
  const n = new Normalizer();
  n.normalize(line({
    uuid: 'a6', type: 'assistant', timestamp: '2025-01-01T00:00:01Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-orphan', name: 'Bash', input: { command: 'echo hi' } }] },
  }), PROJECT);

  const flushed = n.flush();
  assert.equal(flushed.length, 1);
  assert.equal(flushed[0].id, 'tu-orphan');
});

// --- touched_paths extraction ---

test('normalizer: Read tool_use extracts file_path into touched_paths', () => {
  const n = new Normalizer();
  n.normalize(line({
    uuid: 'a7', type: 'assistant', timestamp: '2025-01-01T00:00:01Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-read', name: 'Read', input: { file_path: '/src/foo.ts' } }] },
  }), PROJECT);

  const entries = n.normalize(line({
    uuid: 'u7', type: 'user', timestamp: '2025-01-01T00:00:02Z', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-read', content: 'file contents' }] },
  }), PROJECT);

  assert.equal(entries.length, 1);
  const c = entries[0].content as { touched_paths: string[] };
  assert.ok(c.touched_paths.includes('/src/foo.ts'));
});

test('normalizer: Edit tool_use extracts file_path into touched_paths', () => {
  const n = new Normalizer();
  n.normalize(line({
    uuid: 'a8', type: 'assistant', timestamp: '2025-01-01T00:00:01Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-edit', name: 'Edit', input: { file_path: '/src/bar.ts', old_string: 'a', new_string: 'b' } }] },
  }), PROJECT);

  const entries = n.normalize(line({
    uuid: 'u8', type: 'user', timestamp: '2025-01-01T00:00:02Z', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-edit', content: 'ok' }] },
  }), PROJECT);

  const c = entries[0].content as { touched_paths: string[] };
  assert.ok(c.touched_paths.includes('/src/bar.ts'));
});

test('normalizer: Bash tool_use extracts paths from command heuristically', () => {
  const n = new Normalizer();
  n.normalize(line({
    uuid: 'a9', type: 'assistant', timestamp: '2025-01-01T00:00:01Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-bash', name: 'Bash', input: { command: 'grep -rn foo /src/main.ts' } }] },
  }), PROJECT);

  const entries = n.normalize(line({
    uuid: 'u9', type: 'user', timestamp: '2025-01-01T00:00:02Z', isMeta: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-bash', content: 'results' }] },
  }), PROJECT);

  const c = entries[0].content as { touched_paths: string[] };
  assert.ok(c.touched_paths.includes('/src/main.ts'));
});

// --- real JSONL fixture ---

test('normalizer: parses real Claude Code assistant tool_use event', () => {
  const n = new Normalizer();
  const realLine = '{"parentUuid":"f6f48e3b","isSidechain":false,"message":{"model":"claude-opus-4-6","id":"msg_01MSY8K","type":"message","role":"assistant","content":[{"type":"tool_use","id":"toolu_01QqGW","name":"Read","input":{"file_path":"/Users/marcus/Desktop/testttt/Project-Viewer/.viewer/WORKPACKAGES.md"},"caller":{"type":"direct"}}],"stop_reason":"tool_use","usage":{"input_tokens":3}},"type":"assistant","uuid":"dcbc832e-79a9-4a00-8ddc-eb35b636db0f","timestamp":"2026-05-05T05:16:00.174Z","sessionId":"698a1e83-02d2-41ea-8e85-5f1a812c49e0"}';

  const entries = n.normalize(realLine, PROJECT);
  assert.equal(entries.length, 0, 'tool_use held pending result');

  const resultLine = '{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_01QqGW","type":"tool_result","content":"file contents here"}]},"uuid":"8151fd03","timestamp":"2026-05-05T05:16:00.195Z","sessionId":"698a1e83-02d2-41ea-8e85-5f1a812c49e0"}';
  const merged = n.normalize(resultLine, PROJECT);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].kind, 'tool_use');
  assert.equal(merged[0].conversation_id, '698a1e83-02d2-41ea-8e85-5f1a812c49e0');
  const c = merged[0].content as { tool_name: string; touched_paths: string[] };
  assert.equal(c.tool_name, 'Read');
  assert.ok(c.touched_paths.includes('/Users/marcus/Desktop/testttt/Project-Viewer/.viewer/WORKPACKAGES.md'));
});

test('normalizer: parses real Claude Code user prompt event', () => {
  const n = new Normalizer();
  const realLine = '{"type":"user","message":{"role":"user","content":"hey can we start working on the workpackages?"},"uuid":"2a672a24-b3f9-4cfc-8b48-09da884c0a2d","timestamp":"2026-05-05T05:14:28.299Z","isMeta":false,"sessionId":"698a1e83-02d2-41ea-8e85-5f1a812c49e0"}';

  const entries = n.normalize(realLine, PROJECT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'user_prompt');
  assert.equal(entries[0].turn_id, '2a672a24-b3f9-4cfc-8b48-09da884c0a2d');
  assert.equal(entries[0].conversation_id, '698a1e83-02d2-41ea-8e85-5f1a812c49e0');
});

test('normalizer: bash grep does not extract bare filenames as touched_paths', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'test' }, sessionId: 's1' }), PROJECT);

  n.normalize(line({
    uuid: 'a1',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tu1',
        name: 'Bash',
        input: { command: "grep -n 'webview.ts' /some/dir/*.jsonl | tail -5" },
      }],
    },
    sessionId: 's1',
  }), PROJECT);

  const entries = n.normalize(line({
    uuid: 'r1',
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: '' }],
    },
    sessionId: 's1',
  }), PROJECT);

  const toolEntry = entries.find(e => e.kind === 'tool_use');
  assert.ok(toolEntry, 'tool_use entry exists');
  const paths = (toolEntry!.content as any).touched_paths ?? [];
  assert.ok(!paths.some((p: string) => p === 'webview.ts'), `bare 'webview.ts' should not be in touched_paths, got: ${JSON.stringify(paths)}`);
});

test('normalizer: Read with absolute path IS a touched_path', () => {
  const n = new Normalizer();
  n.normalize(line({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'test' }, sessionId: 's1' }), PROJECT);

  n.normalize(line({
    uuid: 'a1',
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: 'tu1',
        name: 'Read',
        input: { file_path: '/Users/test/project/src/vscode_extension/webview.ts' },
      }],
    },
    sessionId: 's1',
  }), PROJECT);

  const entries = n.normalize(line({
    uuid: 'r1',
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'file contents...' }],
    },
    sessionId: 's1',
  }), PROJECT);

  const toolEntry = entries.find(e => e.kind === 'tool_use');
  assert.ok(toolEntry, 'tool_use entry returned after tool_result');
  const paths = (toolEntry!.content as any).touched_paths ?? [];
  assert.ok(paths.includes('/Users/test/project/src/vscode_extension/webview.ts'), 'absolute path from Read should be in touched_paths');
});

// --- compact_boundary (Phase 1) ---

test('normalizer: compact_boundary event preserves subtype and metadata', () => {
  const n = new Normalizer('sess-1');
  const raw = JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    content: 'Conversation compacted',
    timestamp: '2026-05-10T10:00:00Z',
    uuid: 'abc-123',
    compactMetadata: { trigger: 'manual', preTokens: 100000, postTokens: 5000 },
  });
  const entries = n.normalize(raw, PROJECT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'system');
  assert.equal(entries[0].subtype, 'compact_boundary');
  const content = entries[0].content as any;
  assert.equal(content.compactMetadata.trigger, 'manual');
  assert.equal(content.compactMetadata.preTokens, 100000);
});

test('normalizer: turn_duration system events are filtered out', () => {
  const n = new Normalizer('sess-1');
  const raw = JSON.stringify({
    type: 'system',
    subtype: 'turn_duration',
    timestamp: '2026-05-10T10:00:00Z',
    uuid: 'td-123',
  });
  const entries = n.normalize(raw, PROJECT);
  assert.equal(entries.length, 0, 'turn_duration should be filtered');
});

test('normalizer: local_command system events are filtered out', () => {
  const n = new Normalizer('sess-1');
  const raw = JSON.stringify({
    type: 'system',
    subtype: 'local_command',
    content: '/context\n            context',
    timestamp: '2026-05-10T10:00:00Z',
    uuid: 'lc-123',
  });
  const entries = n.normalize(raw, PROJECT);
  assert.equal(entries.length, 0, 'local_command should be filtered');
});

test('normalizer: non-compact system events still normalize as before', () => {
  const n = new Normalizer('sess-1');
  const raw = JSON.stringify({
    type: 'system',
    content: 'Some system message',
    timestamp: '2026-05-10T10:00:00Z',
    uuid: 'def-456',
  });
  const entries = n.normalize(raw, PROJECT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'system');
  assert.equal(entries[0].subtype, undefined);
  const content = entries[0].content as any;
  assert.ok(content.text.includes('Some system message'));
});

test('loadHistory logic: reads last 500 of all kinds from large audit.jsonl', async () => {
  const fsp = require('node:fs/promises') as typeof import('node:fs/promises');
  const fs = require('node:fs') as typeof import('node:fs');
  const { createReadStream } = fs;
  const { createInterface } = require('node:readline') as typeof import('node:readline');
  const os = require('node:os') as typeof import('node:os');
  const pathMod = require('node:path') as typeof import('node:path');

  // Copy real audit.jsonl to temp
  const realPath = pathMod.join(process.cwd(), '.oxford', 'audit.jsonl');
  const tmpDir = await fsp.mkdtemp(pathMod.join(os.tmpdir(), 'lo-hist-'));
  const tmpPath = pathMod.join(tmpDir, 'audit.jsonl');

  const stat = await fsp.stat(realPath);
  assert.ok(stat.size > 1_000_000, `real audit.jsonl is ${(stat.size / 1024 / 1024).toFixed(1)}MB`);

  await fsp.copyFile(realPath, tmpPath);

  // Replicate exactly what loadHistory does
  const CHUNK = 4 * 1024 * 1024;
  const startPos = Math.max(0, stat.size - CHUNK);
  const stream = createReadStream(tmpPath, { start: startPos, encoding: 'utf8' });
  const rl = createInterface({ input: stream });

  const lines: string[] = [];
  let first = true;
  for await (const line of rl) {
    if (first && startPos > 0) { first = false; continue; }
    first = false;
    if (line.trim()) lines.push(line);
  }

  const last500 = lines.slice(-500);
  const kindCounts: Record<string, number> = {};
  let loaded = 0;
  let errors = 0;
  for (const line of last500) {
    try {
      const entry = JSON.parse(line);
      kindCounts[entry.kind] = (kindCounts[entry.kind] ?? 0) + 1;
      loaded++;
    } catch { errors++; }
  }

  await fsp.rm(tmpDir, { recursive: true, force: true });

  assert.ok(loaded > 0, `loaded ${loaded} events`);
  assert.ok(loaded <= 500, `capped at 500, got ${loaded}`);
  assert.ok((kindCounts.text ?? 0) >= 1, `expected text events, got ${kindCounts.text ?? 0}`);
  assert.ok((kindCounts.thinking ?? 0) >= 1, `expected thinking events, got ${kindCounts.thinking ?? 0}`);
  assert.ok((kindCounts.tool_use ?? 0) >= 1, `expected tool_use events, got ${kindCounts.tool_use ?? 0}`);
  assert.ok((kindCounts.user_prompt ?? 0) >= 1, `expected user_prompt events, got ${kindCounts.user_prompt ?? 0}`);
});
