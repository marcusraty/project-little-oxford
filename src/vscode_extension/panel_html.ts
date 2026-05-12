// Production wrapper for the diagram panel webview. Composes the
// pure-HTML body from panel_body.ts with the vscode-coupled head
// (CSP, scriptUri). The same panel_body is consumed by the Playwright
// harness generator, so production and the harness share one source.

import * as vscode from 'vscode';
import { panelBody } from './panel_body';

export function htmlShell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
  </head>
  <body>
    ${panelBody()}
    <script src="${scriptUri}"></script>
  </body>
</html>`;
}
