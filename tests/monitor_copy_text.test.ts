import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MONITOR_COPY_TEXT } from '../src/vscode_extension/monitor';

test('MONITOR_COPY_TEXT instructs the agent to use the Monitor tool', () => {
  assert.match(MONITOR_COPY_TEXT, /Monitor tool/);
});

test('MONITOR_COPY_TEXT references the monitor script path', () => {
  assert.match(MONITOR_COPY_TEXT, /\.oxford\/monitor\.sh/);
});

test('MONITOR_COPY_TEXT tells the agent to run it in the background', () => {
  assert.match(MONITOR_COPY_TEXT, /run_in_background/);
});

test('MONITOR_COPY_TEXT explains the feed and heartbeat files', () => {
  assert.match(MONITOR_COPY_TEXT, /\.monitor_feed/);
  assert.match(MONITOR_COPY_TEXT, /\.monitor_heartbeat/);
});

test('MONITOR_COPY_TEXT mentions behavioral filters and companion rules so the agent knows what kind of events to expect', () => {
  assert.match(MONITOR_COPY_TEXT, /behavioral/i);
  assert.match(MONITOR_COPY_TEXT, /companion/i);
});

test('MONITOR_COPY_TEXT warns the agent that streaming events use context / subscription quota', () => {
  // The user explicitly wants the model to know this before saying yes.
  assert.match(MONITOR_COPY_TEXT, /context|token|subscription|quota|usage/i);
});
