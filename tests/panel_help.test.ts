import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePanelMessage } from '../src/vscode_extension/panel_messages';

// The diagram body markup lives in panel_body.ts (a pure function,
// shared by production htmlShell and the Playwright harness generator).
const panelBodySource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'panel_body.ts'),
  'utf8',
);

test('parsePanelMessage accepts open-help', () => {
  const result = parsePanelMessage({ type: 'open-help' }, 'diag-x');
  assert.deepEqual(result, { type: 'open-help' });
});

test('parsePanelMessage rejects open-help with extra junk', () => {
  // open-help carries no payload — extra fields are still parsed but the
  // result must remain a bare { type: 'open-help' }.
  const result = parsePanelMessage({ type: 'open-help', wat: 'no' }, 'diag-x');
  assert.deepEqual(result, { type: 'open-help' });
});

test('panel HTML source declares a help-button element', () => {
  assert.match(panelBodySource, /id="help-button"/);
});

test('panel HTML source labels the help button with "Help"', () => {
  assert.match(panelBodySource, /id="help-button"[^>]*>[^<]*[Hh]elp/);
});
