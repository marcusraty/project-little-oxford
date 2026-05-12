import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const statusBarSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'statusbar.ts'),
  'utf8',
);
const commandsSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'commands.ts'),
  'utf8',
);

// The standalone "Help" status bar item is being removed — having a
// bare help pill in the status bar with no project context is confusing.
// Instead, clicking the existing little-oxford pill opens a quick-pick
// menu offering Open Diagram, Help, etc.

test('main status bar pill binds to the pillMenu command, not show', () => {
  // Find the main statusBar (not helpStatusBar) assignment.
  // We accept either an explicit `statusBar.command = 'little-oxford.pillMenu'`
  // or a constant referencing the same id.
  assert.match(statusBarSource, /statusBar\.command\s*=\s*['"]little-oxford\.pillMenu['"]/);
  assert.doesNotMatch(statusBarSource, /statusBar\.command\s*=\s*['"]little-oxford\.show['"]/);
});

test('standalone helpStatusBar item is removed', () => {
  // No createStatusBarItem followed by a help-related command anywhere.
  assert.doesNotMatch(statusBarSource, /helpStatusBar/);
});

test('commands.ts registers little-oxford.pillMenu', () => {
  assert.match(commandsSource, /registerCommand\(['"]little-oxford\.pillMenu['"]/);
});

test('pillMenu offers at least Open Diagram and Help options', () => {
  // The menu's items live in the registered command's body. Crude but
  // adequate: assert both target command ids appear in the same function.
  const pillMenuBody = commandsSource.match(
    /registerCommand\(['"]little-oxford\.pillMenu['"][\s\S]*?\)\s*,/,
  );
  assert.ok(pillMenuBody, 'pillMenu command body found');
  assert.match(pillMenuBody![0], /little-oxford\.show/);
  assert.match(pillMenuBody![0], /little-oxford\.openHelp/);
});
