import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildHtml } from '../src/vscode_extension/audit_view_html';

const auditHtml = buildHtml();
const panelBodySource = readFileSync(
  join(__dirname, '..', 'src', 'vscode_extension', 'panel_body.ts'),
  'utf8',
);

// Help affordances now use the orange/yellow "warning" palette so they
// match the status bar pill and read as a single visual treatment for
// the user. The previous blue button-background blends with VS Code's
// own toolbar buttons.

function helpLinkCss(html: string): string {
  // Extract everything inside the `.help-link { ... }` block.
  const match = html.match(/\.help-link\s*\{([^}]+)\}/);
  return match ? match[1] : '';
}

function panelHelpCss(source: string): string {
  const match = source.match(/#help-button\s*\{([^}]+)\}/);
  return match ? match[1] : '';
}

test('audit panel help-link does NOT use the blue button-background', () => {
  const css = helpLinkCss(auditHtml);
  assert.ok(css.length > 0, '.help-link CSS block exists');
  assert.doesNotMatch(css, /--vscode-button-background/);
});

test('audit panel help-link uses a warning/orange theme variable or amber colour', () => {
  const css = helpLinkCss(auditHtml);
  const warningThemed = /--vscode-(statusBarItem-warning|inputValidation-warning|editorWarning|notificationsWarning)/.test(css);
  const orangeHex = /#[cd][a-f0-9][0-9a-f]{4}/i.test(css); // rough amber/orange range
  assert.ok(warningThemed || orangeHex, 'help-link uses warning theme variable or amber/orange hex');
});

test('diagram panel #help-button does NOT use the blue button-background', () => {
  const css = panelHelpCss(panelBodySource);
  assert.ok(css.length > 0, '#help-button CSS block exists');
  assert.doesNotMatch(css, /--vscode-button-background/);
});

test('diagram panel #help-button uses a warning/orange theme variable or amber colour', () => {
  const css = panelHelpCss(panelBodySource);
  const warningThemed = /--vscode-(statusBarItem-warning|inputValidation-warning|editorWarning|notificationsWarning)/.test(css);
  const orangeHex = /#[cd][a-f0-9][0-9a-f]{4}/i.test(css);
  assert.ok(warningThemed || orangeHex, '#help-button uses warning theme variable or amber/orange hex');
});
