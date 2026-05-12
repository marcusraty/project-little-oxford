// Generates the Playwright harness HTML files from production HTML.
//
// Production HTML lives in:
//   - panelBody()   (src/vscode_extension/panel_body.ts)   — diagram body
//   - buildHtml()   (src/vscode_extension/audit_view_html.ts) — audit panel doc
//
// Both functions are vscode-free. This script wraps each with a small
// mock for acquireVsCodeApi() and writes the result to tests/e2e/*.html.
//
// Run via `npm run build:harness`. The test:e2e script runs it before
// playwright so the harness can never go stale.

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { panelBody } from '../src/vscode_extension/panel_body';
import { buildHtml as auditBuildHtml } from '../src/vscode_extension/audit_view_html';

const HARNESS_DIR = join(__dirname, '..', 'tests', 'e2e');

function mockApi(postFnName: string): string {
  return `<script>
  // Harness-only: stub the webview API so the production webview JS can
  // run in plain Chromium. Tests capture postMessage via window.__messages
  // and inject host→webview messages via window.${postFnName}.
  window.__messages = [];
  window.acquireVsCodeApi = function() {
    return {
      postMessage: function(msg) { window.__messages.push(JSON.parse(JSON.stringify(msg))); }
    };
  };
  window.${postFnName} = function(msg) {
    window.dispatchEvent(new MessageEvent('message', { data: msg }));
  };
</script>`;
}

// Names matching existing test conventions:
//   diagram tests → window.__postToWebview
//   audit tests   → window.__postToAuditView
const MOCK_DIAGRAM = mockApi('__postToWebview');
const MOCK_AUDIT = mockApi('__postToAuditView');

export function generateDiagramHarness(): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
  </head>
  <body>
    ${panelBody()}
    ${MOCK_DIAGRAM}
    <script src="../../dist/webview.js"></script>
  </body>
</html>`;
}

export function generateAuditHarness(): string {
  // buildHtml() returns a complete doc with one inline <script> block that
  // calls acquireVsCodeApi(). Inject the mock right before it.
  const audit = auditBuildHtml();
  return audit.replace(/<script>/, `${MOCK_AUDIT}\n<script>`);
}

function main(): void {
  writeFileSync(join(HARNESS_DIR, 'harness.html'), generateDiagramHarness());
  writeFileSync(join(HARNESS_DIR, 'audit_harness.html'), generateAuditHarness());
  // eslint-disable-next-line no-console
  console.log('Generated tests/e2e/harness.html and tests/e2e/audit_harness.html');
}

// Only run when invoked directly, not when imported by tests.
if (require.main === module) {
  main();
}
