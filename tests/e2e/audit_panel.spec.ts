import { test, expect } from '@playwright/test';
import * as path from 'node:path';

const HARNESS = `file://${path.join(__dirname, 'audit_harness.html')}`;

function post(page: any, msg: any) {
  return page.evaluate((m: any) => (window as any).__postToAuditView(m), msg);
}

function getMessages(page: any): Promise<any[]> {
  return page.evaluate(() => (window as any).__messages);
}

const EVENTS = {
  text: { id: 'e1', time: '14:00:01', kind: 'text', badge: '', content: 'Let me check the code', sessionId: 's1' },
  thinking: { id: 'e2', time: '14:00:02', kind: 'thinking', badge: '', content: 'I need to consider the edge cases', sessionId: 's1' },
  toolRead: { id: 'e3', time: '14:00:03', kind: 'tool_use', badge: 'Read', content: 'src/diagram/render.ts', sessionId: 's1' },
  toolEdit: { id: 'e4', time: '14:00:04', kind: 'tool_use', badge: 'Edit', content: 'src/diagram/render.ts', sessionId: 's1' },
  toolBash: { id: 'e5', time: '14:00:05', kind: 'tool_use', badge: 'Bash', content: 'npm test', sessionId: 's1' },
  userPrompt: { id: 'e6', time: '14:00:06', kind: 'user_prompt', badge: '', content: 'Can you fix the bug?', sessionId: 's1' },
  text2: { id: 'e7', time: '14:00:07', kind: 'text', badge: '', content: 'All tests pass now', sessionId: 's2' },
};

const SESSIONS = [
  { id: 's1', title: 'Fix render bug', path: '/tmp/s1.jsonl', lastLogged: '30s ago' },
  { id: 's2', title: 'Add walkthrough', path: '/tmp/s2.jsonl', lastLogged: '5m ago' },
];

test.beforeEach(async ({ page }) => {
  await page.goto(HARNESS);
  await page.waitForTimeout(300);
});

// --- Basic rendering ---

test('A1: empty state shows placeholder message', async ({ page }) => {
  const empty = page.locator('#empty-msg');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('No audit events');
});

test('A2: events render after init message', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: SESSIONS });
  const events = page.locator('.event');
  await expect(events).toHaveCount(7);
  await expect(page.locator('#empty-msg')).toBeHidden();
});

test('A3: event shows correct time and content', async ({ page }) => {
  await post(page, { type: 'init', events: [EVENTS.text], sessions: [] });
  const event = page.locator('.event').first();
  await expect(event.locator('.event-time')).toContainText('14:00:01');
  await expect(event.locator('.event-content')).toContainText('Let me check the code');
});

test('A4: tool_use events show badge', async ({ page }) => {
  await post(page, { type: 'init', events: [EVENTS.toolRead, EVENTS.toolEdit, EVENTS.toolBash], sessions: [] });
  const badges = page.locator('.badge');
  await expect(badges).toHaveCount(3);
  await expect(badges.nth(0)).toContainText('Read');
  await expect(badges.nth(1)).toContainText('Edit');
  await expect(badges.nth(2)).toContainText('Bash');
});

test('A5: thinking events have italic style', async ({ page }) => {
  await post(page, { type: 'init', events: [EVENTS.thinking], sessions: [] });
  const event = page.locator('.event-thinking');
  await expect(event).toHaveCount(1);
});

test('A6: streaming events append one at a time', async ({ page }) => {
  await post(page, { type: 'init', events: [], sessions: [] });
  await expect(page.locator('.event')).toHaveCount(0);

  await post(page, { type: 'event', event: EVENTS.text });
  await expect(page.locator('.event')).toHaveCount(1);

  await post(page, { type: 'event', event: EVENTS.toolRead });
  await expect(page.locator('.event')).toHaveCount(2);
});

// --- Filters ---

test('A7: text filter shows only text events', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await page.click('[data-filter="text"]');
  const events = page.locator('.event');
  const count = await events.count();
  for (let i = 0; i < count; i++) {
    await expect(events.nth(i)).toHaveClass(/event-text/);
  }
});

test('A8: tools filter shows only tool_use events', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await page.click('[data-filter="tool_use"]');
  const events = page.locator('.event');
  const count = await events.count();
  expect(count).toBe(3);
  for (let i = 0; i < count; i++) {
    await expect(events.nth(i)).toHaveClass(/event-tool_use/);
  }
});

test('A9: thinking filter shows only thinking events', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await page.click('[data-filter="thinking"]');
  await expect(page.locator('.event')).toHaveCount(1);
  await expect(page.locator('.event').first()).toHaveClass(/event-thinking/);
});

test('A10: all filter shows everything', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await page.click('[data-filter="text"]');
  await expect(page.locator('.event')).not.toHaveCount(7);
  await page.click('[data-filter="all"]');
  await expect(page.locator('.event')).toHaveCount(7);
});

test('A11: prompts filter shows only user_prompt events', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await page.click('[data-filter="user_prompt"]');
  await expect(page.locator('.event')).toHaveCount(1);
  await expect(page.locator('.event-content').first()).toContainText('Can you fix the bug');
});

// --- Rule matches ---

test('A12: rule match highlights event with badge', async ({ page }) => {
  await post(page, { type: 'init', events: [EVENTS.text], sessions: [] });
  await post(page, { type: 'rule-match', entryId: 'e1', ruleId: 'F7', ruleName: 'Assumed-ok', severity: 'warning', matchedText: 'should work' });

  const event = page.locator('.event').first();
  await expect(event).toHaveClass(/event-rule/);
  await expect(event.locator('.badge')).toContainText('F7');
});

test('A13: error rule match has error styling', async ({ page }) => {
  await post(page, { type: 'init', events: [EVENTS.text], sessions: [] });
  await post(page, { type: 'rule-match', entryId: 'e1', ruleId: 'C2', ruleName: 'Test missing', severity: 'error', matchedText: 'render.ts' });

  const event = page.locator('.event').first();
  await expect(event).toHaveClass(/event-rule-error/);
  await expect(event.locator('.badge')).toHaveClass(/badge-rule-error/);
});

test('A14: rules filter shows only events with rule matches', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await post(page, { type: 'rule-match', entryId: 'e1', ruleId: 'F7', ruleName: 'Assumed-ok', severity: 'warning', matchedText: 'test' });
  await post(page, { type: 'rule-match', entryId: 'e4', ruleId: 'C2', ruleName: 'Test missing', severity: 'error', matchedText: 'render.ts' });

  await page.click('[data-filter="rules"]');
  await expect(page.locator('.event')).toHaveCount(2);
});

// --- Warning/Error toggles ---

test('A15: warning toggle shows only warnings', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await post(page, { type: 'rule-match', entryId: 'e1', ruleId: 'F7', ruleName: 'Assumed-ok', severity: 'warning', matchedText: 'test' });
  await post(page, { type: 'rule-match', entryId: 'e4', ruleId: 'C2', ruleName: 'Test missing', severity: 'error', matchedText: 'render.ts' });

  await page.click('[data-filter="warnings"]');
  await expect(page.locator('.event')).toHaveCount(1);
  await expect(page.locator('.event .badge')).toContainText('F7');
});

test('A16: error toggle shows only errors', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await post(page, { type: 'rule-match', entryId: 'e1', ruleId: 'F7', ruleName: 'X', severity: 'warning', matchedText: 'x' });
  await post(page, { type: 'rule-match', entryId: 'e4', ruleId: 'C2', ruleName: 'Y', severity: 'error', matchedText: 'y' });

  await page.click('[data-filter="errors"]');
  await expect(page.locator('.event')).toHaveCount(1);
  await expect(page.locator('.event .badge')).toContainText('C2');
});

test('A17: warning toggle deactivates error toggle', async ({ page }) => {
  await post(page, { type: 'init', events: Object.values(EVENTS), sessions: [] });
  await page.click('[data-filter="errors"]');
  await page.click('[data-filter="warnings"]');
  const errBtn = page.locator('[data-filter="errors"]');
  await expect(errBtn).not.toHaveClass(/err-active/);
});

// --- Sessions ---

test('A18: sessions render from init', async ({ page }) => {
  await post(page, { type: 'init', events: [], sessions: SESSIONS });
  const sessions = page.locator('.session');
  await expect(sessions).toHaveCount(2);
  await expect(sessions.first()).toContainText('Fix render bug');
  await expect(sessions.first()).toContainText('last logged 30s ago');
});

test('A19: clicking session posts open-jsonl message', async ({ page }) => {
  await post(page, { type: 'init', events: [], sessions: SESSIONS });
  await page.locator('.session').first().click();
  const msgs = await getMessages(page);
  const openMsg = msgs.find((m: any) => m.type === 'open-jsonl');
  expect(openMsg).toBeTruthy();
  expect(openMsg.path).toBe('/tmp/s1.jsonl');
});

test('A20: sessions update dynamically', async ({ page }) => {
  await post(page, { type: 'init', events: [], sessions: [SESSIONS[0]] });
  await expect(page.locator('.session')).toHaveCount(1);

  await post(page, { type: 'sessions', sessions: SESSIONS });
  await expect(page.locator('.session')).toHaveCount(2);
});

// --- Click to open JSONL ---

test('A21: clicking event posts open-jsonl message', async ({ page }) => {
  await post(page, { type: 'init', events: [EVENTS.text], sessions: SESSIONS });
  await page.locator('.event').first().click();
  const msgs = await getMessages(page);
  const openMsg = msgs.find((m: any) => m.type === 'open-jsonl');
  expect(openMsg).toBeTruthy();
  expect(openMsg.path).toBe('/tmp/s1.jsonl');
});

// --- Rules link ---

test('A22: rules link posts open-rules message', async ({ page }) => {
  await page.click('#open-rules');
  const msgs = await getMessages(page);
  expect(msgs.some((m: any) => m.type === 'open-rules')).toBe(true);
});

// --- Splitter ---

test('A23: splitter resizes sessions pane', async ({ page }) => {
  const pane = page.locator('#sessions-pane');
  const widthBefore = await pane.evaluate((el: HTMLElement) => el.offsetWidth);

  const splitter = page.locator('#splitter');
  const box = await splitter.boundingBox();
  expect(box).toBeTruthy();

  // Drag left to make sessions pane wider
  await page.mouse.move(box!.x + 2, box!.y + 10);
  await page.mouse.down();
  await page.mouse.move(box!.x - 150, box!.y + 10, { steps: 5 });
  await page.mouse.up();

  const widthAfter = await pane.evaluate((el: HTMLElement) => el.offsetWidth);

  // Then drag right to make it narrower
  const box2 = await splitter.boundingBox();
  await page.mouse.move(box2!.x + 2, box2!.y + 10);
  await page.mouse.down();
  await page.mouse.move(box2!.x + 100, box2!.y + 10, { steps: 5 });
  await page.mouse.up();

  const widthFinal = await pane.evaluate((el: HTMLElement) => el.offsetWidth);
  expect(widthFinal).toBeLessThan(widthAfter);
});

// --- Edge cases ---

test('A24: 500+ events caps at 500', async ({ page }) => {
  await post(page, { type: 'init', events: [], sessions: [] });
  for (let i = 0; i < 510; i++) {
    await post(page, { type: 'event', event: { id: `bulk-${i}`, time: '00:00:00', kind: 'text', badge: '', content: `Event ${i}`, sessionId: 's1' } });
  }
  const count = await page.evaluate(() => (window as any).allEvents?.length ?? 0);
  expect(count).toBeLessThanOrEqual(500);
});

test('A25: empty filter result shows message', async ({ page }) => {
  await post(page, { type: 'init', events: [EVENTS.text], sessions: [] });
  await page.click('[data-filter="thinking"]');
  await expect(page.locator('.empty')).toBeVisible();
});

test('A26: XSS in event content is escaped', async ({ page }) => {
  await post(page, { type: 'init', events: [{ id: 'xss', time: '00:00:00', kind: 'text', badge: '', content: '<script>alert(1)</script>', sessionId: 's1' }], sessions: [] });
  const html = await page.locator('.event-content').first().innerHTML();
  expect(html).not.toContain('<script>');
  expect(html).toContain('&lt;script&gt;');
});

test('A27: monitor status row shows disconnected by default', async ({ page }) => {
  await post(page, { type: 'init', events: [], sessions: [] });
  const status = page.locator('.monitor-status');
  await expect(status).toBeVisible();
  await expect(status).toContainText('Monitor not connected');
});

test('A28: monitor status updates to connected', async ({ page }) => {
  await post(page, { type: 'init', events: [], sessions: [] });
  await post(page, { type: 'monitor-status', running: true });
  const status = page.locator('.monitor-status');
  await expect(status).toContainText('Monitor connected');
  await expect(status.locator('.monitor-dot')).toHaveClass(/connected/);
});

test('A29: monitor status has copy command button', async ({ page }) => {
  await post(page, { type: 'init', events: [], sessions: [] });
  const copyBtn = page.locator('.monitor-copy');
  await expect(copyBtn).toBeVisible();
});

// --- Initialize banner / gated copy button ---

test('A40: init banner is visible by default (uninitialized state)', async ({ page }) => {
  const banner = page.locator('#init-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Audit engine not initialized');
});

test('A41: copy button is disabled by default', async ({ page }) => {
  const copyBtn = page.locator('#monitor-copy');
  await expect(copyBtn).toHaveAttribute('disabled', /.*/);
});

test('A42: init-state initialized=true hides banner and enables copy button', async ({ page }) => {
  await post(page, { type: 'init-state', initialized: true, hasMonitor: true, hasRules: true });
  await expect(page.locator('#init-banner')).toBeHidden();
  const copyBtn = page.locator('#monitor-copy');
  await expect(copyBtn).not.toHaveAttribute('disabled', /.*/);
});

test('A43: clicking Initialize posts initialize message to host', async ({ page }) => {
  await page.click('#init-btn');
  const messages = await getMessages(page);
  const initMsg = messages.find((m: any) => m.type === 'initialize');
  expect(initMsg).toBeDefined();
});

test('A44: re-flipping to uninitialized restores banner and disables copy', async ({ page }) => {
  await post(page, { type: 'init-state', initialized: true, hasMonitor: true, hasRules: true });
  await expect(page.locator('#init-banner')).toBeHidden();

  await post(page, { type: 'init-state', initialized: false, hasMonitor: false, hasRules: false });
  await expect(page.locator('#init-banner')).toBeVisible();
  await expect(page.locator('#monitor-copy')).toHaveAttribute('disabled', /.*/);
});
