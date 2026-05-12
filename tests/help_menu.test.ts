import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HELP_EMAIL,
  HELP_DISCUSSIONS_URL,
  helpMailtoUrl,
  helpMenuItems,
} from '../src/vscode_extension/help';

test('HELP_DISCUSSIONS_URL points at the public little-oxford repo', () => {
  assert.match(HELP_DISCUSSIONS_URL, /^https:\/\/github\.com\//);
  assert.match(HELP_DISCUSSIONS_URL, /project-little-oxford/);
  assert.match(HELP_DISCUSSIONS_URL, /discussions/);
});

test('helpMenuItems returns at least two items', () => {
  const items = helpMenuItems();
  assert.ok(items.length >= 2, 'two or more options');
});

test('helpMenuItems includes an "Email maintainer" item with a mailto URL', () => {
  const items = helpMenuItems();
  const email = items.find((i) => /email/i.test(i.label));
  assert.ok(email, 'email item exists');
  assert.equal(email!.url, helpMailtoUrl());
  assert.match(email!.label, new RegExp(HELP_EMAIL.split('@')[0], 'i'));
});

test('helpMenuItems includes a "Start GitHub discussion" item with the discussions URL', () => {
  const items = helpMenuItems();
  const discussion = items.find((i) => /discussion/i.test(i.label));
  assert.ok(discussion, 'discussion item exists');
  assert.equal(discussion!.url, HELP_DISCUSSIONS_URL);
});

test('helpMenuItems labels are concise (under 60 chars) and have a distinguishing description', () => {
  for (const item of helpMenuItems()) {
    assert.ok(item.label.length <= 60, `label "${item.label}" under 60 chars`);
    assert.ok(typeof item.description === 'string' && item.description.length > 0, `${item.label} has description`);
  }
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const commandsSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'commands.ts'),
  'utf8',
);
const auditViewSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'audit_view.ts'),
  'utf8',
);
const panelSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'panel.ts'),
  'utf8',
);

test('openHelp command uses helpMenuItems + showQuickPick (not a direct mailto)', () => {
  const block = commandsSource.match(/registerCommand\([^)]*HELP_COMMAND_ID[\s\S]*?\)\s*,/);
  assert.ok(block, 'openHelp registration block found');
  assert.match(block![0], /helpMenuItems\(/);
  assert.match(block![0], /showQuickPick/);
});

test('audit view open-help handler delegates to the openHelp command', () => {
  const handler = auditViewSource.match(/open-help[\s\S]*?\}/);
  assert.ok(handler, 'open-help handler found in audit_view.ts');
  assert.match(handler![0], /executeCommand\(['"]little-oxford\.openHelp|executeCommand\(HELP_COMMAND_ID/);
});

test('diagram panel open-help handler delegates to the openHelp command', () => {
  const handler = panelSource.match(/case ['"]open-help['"][\s\S]*?return;/);
  assert.ok(handler, 'open-help case found in panel.ts');
  assert.match(handler![0], /executeCommand\(['"]little-oxford\.openHelp|executeCommand\(HELP_COMMAND_ID/);
});
