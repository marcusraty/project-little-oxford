import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { renderEventRow, AuditEventList } from '../src/ui/components';
import type { AuditEntry } from '../src/audit/types';

function makeEntry(kind: AuditEntry['kind'], content: Record<string, unknown>, overrides?: Partial<AuditEntry>): AuditEntry {
  return {
    id: 'test-id',
    session_id: 'sess-1',
    project_id: '/test',
    conversation_id: 'sess-1',
    turn_id: 'turn-1',
    timestamp: '2025-01-01T12:30:45Z',
    kind,
    content,
    ...overrides,
  };
}

test('renderEventRow: user_prompt shows chat icon and text', () => {
  const html = renderEventRow(makeEntry('user_prompt', { text: 'Fix the bug' }));
  assert.ok(html.includes('\u{1F4AC}'), 'has chat icon');
  assert.ok(html.includes('Fix the bug'), 'has prompt text');
  assert.ok(html.includes('data-kind="user_prompt"'), 'has data-kind attribute');
});

test('renderEventRow: thinking shows brain icon', () => {
  const html = renderEventRow(makeEntry('thinking', { text: 'Let me think...' }));
  assert.ok(html.includes('\u{1F9E0}'), 'has brain icon');
  assert.ok(html.includes('Let me think...'), 'has thinking text');
});

test('renderEventRow: text shows memo icon', () => {
  const html = renderEventRow(makeEntry('text', { text: 'Here is the answer' }));
  assert.ok(html.includes('\u{1F4DD}'), 'has memo icon');
});

test('renderEventRow: tool_use shows wrench icon and tool name', () => {
  const html = renderEventRow(makeEntry('tool_use', { tool_name: 'Read', input: { file_path: '/src/foo.ts' } }));
  assert.ok(html.includes('\u{1F527}'), 'has wrench icon');
  assert.ok(html.includes('Read'), 'has tool name');
  assert.ok(html.includes('/src/foo.ts'), 'has file path');
});

test('renderEventRow: system shows gear icon', () => {
  const html = renderEventRow(makeEntry('system', { text: 'System prompt' }));
  assert.ok(html.includes('\u{2699}'), 'has gear icon');
});

test('renderEventRow: escapes HTML in content', () => {
  const html = renderEventRow(makeEntry('text', { text: '<script>alert("xss")</script>' }));
  assert.ok(!html.includes('<script>'), 'script tag is escaped');
  assert.ok(html.includes('&lt;script&gt;'), 'angle brackets are escaped');
});

test('renderEventRow: truncates long text', () => {
  const longText = 'a'.repeat(200);
  const html = renderEventRow(makeEntry('text', { text: longText }));
  assert.ok(html.includes('…'), 'text is truncated with ellipsis');
  assert.ok(!html.includes('a'.repeat(200)), 'full text is not present');
});

test('AuditEventList: caps at 100 events', () => {
  const list = new AuditEventList();
  // Mock a minimal container
  const mock = {
    innerHTML: '',
    children: [] as unknown[],
    firstChild: null as unknown,
    scrollTop: 0,
    scrollHeight: 100,
    removeChild() { mock.children.pop(); return null; },
    insertAdjacentHTML(_pos: string, html: string) {
      mock.children.push(html);
      mock.innerHTML += html;
    },
  };
  const container = mock as unknown as HTMLElement;

  list.mount(container);

  for (let i = 0; i < 110; i++) {
    list.push(makeEntry('text', { text: `event ${i}` }));
  }

  assert.equal(list.count, 100, 'internal list capped at 100');
});
