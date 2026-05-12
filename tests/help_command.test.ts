import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HELP_COMMAND_ID } from '../src/vscode_extension/help';

const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf8'),
);
const statusBarSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'statusbar.ts'),
  'utf8',
);
const commandsSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'commands.ts'),
  'utf8',
);

test('HELP_COMMAND_ID is exported', () => {
  assert.equal(HELP_COMMAND_ID, 'little-oxford.openHelp');
});

test('package.json declares the openHelp command', () => {
  const cmds = packageJson.contributes.commands as Array<{ command: string }>;
  assert.ok(cmds.some((c) => c.command === HELP_COMMAND_ID), 'openHelp registered in package.json');
});

test('commands.ts registers little-oxford.openHelp', () => {
  // Either literal string or via the HELP_COMMAND_ID constant.
  const literal = /registerCommand\(['"]little-oxford\.openHelp['"]/.test(commandsSource);
  const viaConst = /registerCommand\(HELP_COMMAND_ID\b/.test(commandsSource);
  assert.ok(literal || viaConst, 'openHelp registered (literal or via constant)');
});

test('statusbar.ts no longer has a standalone help status bar item', () => {
  // Help is reached via the pillMenu quick-pick instead. A bare Help pill
  // with no project context was confusing in the status bar.
  assert.doesNotMatch(statusBarSource, /helpStatusBar/);
});
