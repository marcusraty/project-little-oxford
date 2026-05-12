import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { panelBody } from '../src/vscode_extension/panel_body';

const panelBodySource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'panel_body.ts'),
  'utf8',
);
const panelHtmlSource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'panel_html.ts'),
  'utf8',
);

test('panelBody is a pure function — no vscode import', () => {
  assert.doesNotMatch(panelBodySource, /from\s+['"]vscode['"]/);
  assert.doesNotMatch(panelBodySource, /import\s+\*\s+as\s+vscode/);
});

test('panelBody returns body content, not a full HTML document', () => {
  const body = panelBody();
  assert.doesNotMatch(body, /<!DOCTYPE/i);
  assert.doesNotMatch(body, /<html\b/i);
  assert.doesNotMatch(body, /<head\b/i);
  // Body content may have `<body>` wrapper or not — accept both, but no doc tags above it.
});

test('panelBody includes every toolbar element production needs', () => {
  const body = panelBody();
  for (const id of [
    'stage', 'empty', 'help-button', 'settings-button', 'reset-button',
    'session-button', 'model-picker', 'mode-toggle', 'zoom-control',
    'diagnostics', 'legend',
  ]) {
    assert.match(body, new RegExp(`id="${id}"`), `${id} present in panelBody`);
  }
});

test('panelBody includes its own styles (self-contained for the harness)', () => {
  const body = panelBody();
  assert.match(body, /<style[\s\S]*#help-button\b/);
});

test('htmlShell uses panelBody — the two are the single source of truth', () => {
  assert.match(panelHtmlSource, /from\s+['"]\.\/panel_body['"]/);
  assert.match(panelHtmlSource, /panelBody\(\)/);
});
