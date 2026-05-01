// Project Viewer — webview panel.
//
// A "webview panel" is VS Code's escape hatch for showing arbitrary
// HTML/CSS/JS in an editor tab. Under the hood it's a sandboxed Chromium
// iframe — same browser engine VS Code itself uses to render its UI. The
// extension can hand it an HTML document, but it CAN'T directly poke the
// DOM inside it. They communicate via postMessage in both directions.
//
// This file owns:
//   - The panel singleton and its lifecycle
//   - The HTML shell loaded into the iframe
//   - The IPC dispatch (messages from the webview)
//   - The render loop: read diagram → renderDiagram → post SVG to webview
//   - Persisting drag-to-pin coordinates back into model.json

import * as vscode from 'vscode';
import { renderDiagram } from '../diagram/render';
import type { LayoutPreset, LayoutSpec } from '../diagram/layout';
import {
  diagramExists,
  diagramPath,
  mutateDiagram,
  readDiagram,
} from '../diagram/storage';
import { updateStatusBar } from './statusbar';
import { disposeWatcher, startWatcher } from './watcher';
import { recorder, DIAG_MESSAGE_TYPE, type DiagBridgeMessage } from '../diagnostics';
import { resolveAnchor } from './anchor';
import type { Diagram, Layout } from '../diagram/types';

let panel: vscode.WebviewPanel | undefined;

// Carries the trace id of an in-flight host-side operation across the
// async boundary between applyPin → fs write → watcher fire → rerender.
// Cleared on rerender completion. Single-slot is fine: a user drags one
// box at a time.
let pendingTraceId: string | undefined;

// Opens (or reveals) the diagram panel.
export function showPanel(context: vscode.ExtensionContext): void {
  // Already open? Just bring it to the front and re-render with the
  // current diagram. No need to recreate the webview.
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    void rerender();
    return;
  }

  // Create the panel. Args, in order:
  //   1. viewType — internal id for this panel kind (used for serialization)
  //   2. title — the tab title shown to the user
  //   3. ViewColumn.Active — open in the same editor column as the user's focus
  //   4. options:
  //      - enableScripts: required to run our webview JS bundle
  //      - localResourceRoots: directories the iframe is allowed to load
  //        files from. We restrict to dist/ so it can fetch our bundled
  //        webview.js but nothing else from disk.
  //      - retainContextWhenHidden: keep the iframe alive when hidden,
  //        so switching tabs and back doesn't reload/reset the diagram.
  panel = vscode.window.createWebviewPanel(
    'projectViewer',
    'Project Viewer',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      retainContextWhenHidden: true,
    },
  );

  // Hand the webview its HTML document. From the iframe's perspective this
  // is the entire page it's rendering.
  panel.webview.html = htmlShell(panel.webview, context.extensionUri);

  // Tear down our state when the user closes the tab.
  panel.onDidDispose(() => {
    panel = undefined;
    disposeWatcher();
  });

  // Messages FROM the webview land here. The webview is in a different
  // process — it can't call our functions directly. So we agree on a small
  // protocol where it sends `{type, ...payload}` JSON and we dispatch:
  //
  //   ready       → the iframe has loaded; send it the current diagram
  //   pin         → user dragged a box; persist its new x/y/w/h to disk
  //   open-anchor → user clicked a component; jump to its source file
  //   reset-layout→ user clicked the Reset button; wipe model.layout so
  //                 the next render does a fresh ELK pass
  //   open-settings→user clicked the gear icon; open VS Code's Settings
  //                 UI filtered to this extension
  //   __diag      → diagnostics event from the webview side; forward to
  //                 host recorder so webview + host events land in one log
  panel.webview.onDidReceiveMessage((msg) => {
    if (msg?.type === 'ready') void rerender();
    else if (msg?.type === 'pin') void applyPin(msg.id, msg.x, msg.y, msg.w, msg.h, msg.traceId);
    else if (msg?.type === 'open-anchor') void openAnchor(msg.value);
    else if (msg?.type === 'reset-layout') void resetLayout();
    else if (msg?.type === 'open-settings') {
      // VS Code accepts an `@ext:<publisher>.<name>` query that filters
      // the Settings UI to a single extension's contributions. Doing it
      // this way (rather than scrolling the user to a specific setting)
      // keeps the surface honest as we add more settings later.
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:marcusraty.project-viewer',
      );
    }
    else if (__DEBUG__ && msg?.type === DIAG_MESSAGE_TYPE) {
      recorder.ingest((msg as DiagBridgeMessage).event);
    }
  });

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    startWatcher(root, () => {
      if (__DEBUG__) recorder.emit('host', 'watcher-fired', {}, pendingTraceId);
      void rerender();
    });
  }
}

export function disposePanel(): void {
  panel?.dispose();
  panel = undefined;
}

// Reads the user's chosen layout preset from VS Code's workspace
// configuration on every render. Falls back to "tiered" if the value is
// missing or malformed; the diagram engine validates the preset name
// itself and surfaces an `unknown-layout-preset` diagnostic on bad input.
function currentLayoutSpec(): LayoutSpec {
  const cfg = vscode.workspace.getConfiguration('projectViewer');
  const preset = cfg.get<string>('layout.preset', 'tiered');
  return { preset: preset as LayoutPreset };
}

// Re-render whenever the user changes a Project Viewer setting (e.g.,
// flips the layout preset in the Settings panel). Hooks once at module
// load — the listener is shared across panel open/close cycles.
//
// Disposable handle is exposed via this function so extension.ts can
// register it with context.subscriptions and have VS Code dispose it
// at deactivation.
export function watchConfigurationChanges(): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration('projectViewer.layout')) {
      void rerender();
    }
  });
}

async function persistNewlyPlaced(
  root: string,
  inputDiagram: Diagram,
  outputLayout: Layout,
  traceId?: string,
): Promise<void> {
  const inputPins = inputDiagram.layout?.components ?? {};
  const outputPins = outputLayout.components ?? {};
  const newlyPlaced: Record<string, { x: number; y: number; w: number; h: number }> = {};
  for (const id of Object.keys(inputDiagram.components)) {
    if (!inputPins[id] && outputPins[id]) {
      newlyPlaced[id] = outputPins[id];
    }
  }
  if (Object.keys(newlyPlaced).length === 0) return;

  await mutateDiagram(root, (d) => {
    const layout = d.layout ?? {};
    const components = layout.components ?? {};
    for (const [id, pos] of Object.entries(newlyPlaced)) {
      components[id] = pos;
    }
    d.layout = { ...layout, components };
  });

  if (__DEBUG__) {
    recorder.emit(
      'host',
      'layout-persisted',
      { ids: Object.keys(newlyPlaced), positions: newlyPlaced },
      traceId,
    );
  }
}

async function applyPin(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  traceId?: string,
): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root || !id) return;
  if (__DEBUG__) {
    recorder.emit('host', 'pin-received', { id, x, y, w, h }, traceId);
    pendingTraceId = traceId;
  }
  let written: { x: number; y: number; w: number; h: number } | undefined;
  await mutateDiagram(root, (d) => {
    const layout = d.layout ?? {};
    const components = layout.components ?? {};
    components[id] = {
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w),
      h: Math.round(h),
    };
    d.layout = { ...layout, components };
    written = components[id];
  });
  if (__DEBUG__) {
    recorder.emit('host', 'pin-written', { id, written }, traceId);
  }
}

// Wipe the persisted layout block so the next render does a fresh ELK
// pass. The webview is responsible for confirming with the user before
// posting `reset-layout` (since this discards their drag-pinned positions).
async function resetLayout(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;
  await mutateDiagram(root, (d) => {
    d.layout = {};
  });
}

async function openAnchor(value: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root || !value) return;
  const resolved = resolveAnchor(root, value);
  if ('error' in resolved) {
    vscode.window.showErrorMessage(`Project Viewer: ${resolved.error}`);
    return;
  }
  const fileUri = vscode.Uri.file(resolved.absPath);
  let editor: vscode.TextEditor;
  try {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  } catch (e) {
    vscode.window.showErrorMessage(`Project Viewer: couldn't open ${value}: ${(e as Error).message}`);
    return;
  }
  if (!resolved.symbol) return;
  const text = editor.document.getText();
  const offset = text.indexOf(resolved.symbol);
  if (offset >= 0) {
    const line = editor.document.positionAt(offset).line;
    const pos = new vscode.Position(line, 0);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
    editor.selection = new vscode.Selection(pos, pos);
  }
}

// Reads the diagram, runs it through the renderer, and ships the resulting
// SVG (or an error/empty message) to the webview via postMessage. Called
// whenever something changes: panel opened, file watcher fired, drag-to-pin
// finished, etc.
async function rerender(): Promise<void> {
  if (!panel) return;
  const traceId = pendingTraceId;
  if (__DEBUG__) recorder.emit('host', 'rerender-start', {}, traceId);

  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {
    panel.webview.postMessage({
      type: 'empty',
      message: 'Open a folder to use Project Viewer.',
    });
    return;
  }
  if (!(await diagramExists(root))) {
    panel.webview.postMessage({
      type: 'empty',
      message: `No diagram yet.\nDrop a model at:\n${diagramPath(root)}`,
    });
    return;
  }
  const diagram = await readDiagram(root);
  if (!diagram) {
    panel.webview.postMessage({ type: 'error', message: `Couldn't read or parse model.json` });
    return;
  }

  if (__DEBUG__) {
    // Snapshot the layout block we just read off disk. This is the input
    // to renderDiagram — comparing it against the output's `layout` tells
    // us whether the renderer/ELK shifted any pinned coords.
    recorder.emit(
      'host',
      'rerender-read',
      { layout: diagram.layout ?? null },
      traceId,
    );
  }

  try {
    const output = await renderDiagram(diagram, currentLayoutSpec());
    const { svg, layout, diagnostics } = output;
    const errors = diagnostics.filter((d) => d.level === 'error');
    if (errors.length > 0) {
      panel.webview.postMessage({
        type: 'error',
        message: errors.map((e) => `• ${e.message}`).join('\n'),
      });
      if (__DEBUG__) {
        recorder.emit('host', 'rerender-error', { errors }, traceId);
        pendingTraceId = undefined;
      }
      return;
    }

    panel.webview.postMessage({ type: 'svg', svg, diagnostics, diagram, traceId });

    const componentCount = Object.keys(diagram.components).length;
    const warningCount = diagnostics.filter((d) => d.level === 'warning').length;
    void updateStatusBar(componentCount, warningCount);

    // Auto-persist any positions ELK just produced for components that
    // weren't yet pinned. This is the "ELK runs, results stick" half of
    // the contract: once a component has been laid out, its coord is
    // written to model.json so future renders take the all-pinned fast
    // path. Only previously-MISSING ids are written — never any that
    // already had a layout entry. That guard protects an in-flight drag
    // (whose updated coord lives on disk and in the just-read diagram)
    // from being clobbered by ELK's re-arrangement of pinned neighbors
    // during the same render cycle.
    await persistNewlyPlaced(root, diagram, layout, traceId);

    if (__DEBUG__) {
      // Output side of the renderer black box. Pair this with
      // `rerender-read` (input) and `pin-written` (the disk side) to see
      // where coords change across the pipeline.
      recorder.emit(
        'host',
        'rerender-end',
        {
          components: Object.keys(diagram.components).length,
          warnings: warningCount,
          outputLayout: layout,
        },
        traceId,
      );
      pendingTraceId = undefined;
    }
  } catch (e) {
    panel.webview.postMessage({ type: 'error', message: `Render failed: ${(e as Error).message}` });
    if (__DEBUG__) {
      recorder.emit('host', 'rerender-throw', { error: (e as Error).message }, traceId);
      pendingTraceId = undefined;
    }
  }
}

// Builds the HTML document that the webview iframe loads.
//
// Two non-obvious things happening here:
//
// 1. asWebviewUri() — the iframe is sandboxed and CAN'T load arbitrary
//    file:// paths off disk. VS Code requires us to translate a file path
//    into a special vscode-webview:// URL the iframe is allowed to fetch.
//
// 2. Content-Security-Policy (CSP) — the iframe is a real browser, so we
//    set a strict policy on what it's allowed to load. `default-src 'none'`
//    blocks everything by default, then we explicitly allow scripts/styles/
//    fonts/images from `webview.cspSource` (a per-panel allowlist token VS
//    Code generates) and inline data: URIs for images. No external network.
function htmlShell(webview: vscode.Webview, extensionUri: vscode.Uri): string {
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
    <style>
      /* Theme inheritance: every chrome color reads from VS Code's
         workbench theme, so the panel matches whatever the user has
         active. The vscode-prefixed CSS custom properties are injected
         by VS Code into the webview root automatically. Where a
         fallback is given (the second arg to var), it covers older
         themes that don't define the more specialized token. */
      html, body {
        margin: 0; height: 100%;
        background: var(--vscode-editor-background);
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family, system-ui, sans-serif);
        font-size: var(--vscode-font-size, 13px);
        overflow: hidden;
      }
      #stage { width: 100vw; height: 100vh; background: var(--vscode-editor-background); }
      #empty {
        position: absolute; inset: 0;
        display: flex; align-items: center; justify-content: center;
        text-align: center; padding: 24px; white-space: pre-wrap;
        color: var(--vscode-descriptionForeground);
      }
      #empty.hidden { display: none; }
      #stage svg { width: 100%; height: 100%; }

      /* Defaults for renderer-emitted SVG nodes that don't have a rule
         from model.json (component_styles / relationship_styles).
         Rule-styled boxes/arrows still use their hex colors via inline
         attrs and these classes don't apply. */
      svg .pv-default-fill { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
      svg .pv-default-stroke { stroke: var(--vscode-panel-border, var(--vscode-foreground)); }
      svg .pv-default-arrow-stroke {
        stroke: var(--vscode-foreground);
        color: var(--vscode-foreground);
      }
      svg .pv-default-arrow-fill { fill: var(--vscode-foreground); }
      svg .pv-title { fill: var(--vscode-foreground); }
      svg .pv-container-fill { fill: var(--vscode-editorWidget-background, var(--vscode-editor-background)); }
      svg .pv-container-stroke { stroke: var(--vscode-panel-border, var(--vscode-foreground)); }
      svg .pv-container-label { fill: var(--vscode-descriptionForeground); }

      #reset-button {
        position: fixed; top: 12px; right: 168px; z-index: 10;
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 6px;
        padding: 6px 12px; cursor: pointer;
        font-family: inherit; font-size: 12px;
      }
      #reset-button:hover { background: var(--vscode-toolbar-hoverBackground); }
      #reset-button.hidden { display: none; }
      #settings-button {
        position: fixed; top: 12px; right: 286px; z-index: 10;
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 6px;
        padding: 6px 10px; cursor: pointer;
        font-family: inherit; font-size: 13px; line-height: 1;
      }
      #settings-button:hover { background: var(--vscode-toolbar-hoverBackground); }
      #settings-button.hidden { display: none; }
      /* Custom confirm modal — VS Code webviews block window.confirm()
         and alert(), so we render our own. */
      #modal-backdrop {
        position: fixed; inset: 0; z-index: 100;
        background: rgba(0, 0, 0, 0.5);
        display: flex; align-items: center; justify-content: center;
      }
      #modal-backdrop.hidden { display: none; }
      #modal {
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 6px;
        box-shadow: 0 4px 16px var(--vscode-widget-shadow, rgba(0, 0, 0, 0.5));
        max-width: 420px; padding: 16px 20px;
        font-family: inherit; font-size: 13px;
      }
      #modal-message { white-space: pre-wrap; line-height: 1.5; margin-bottom: 16px; }
      #modal-buttons {
        display: flex; justify-content: flex-end; gap: 8px;
      }
      #modal-buttons button {
        background: var(--vscode-button-secondaryBackground, transparent);
        color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 4px;
        padding: 6px 14px; cursor: pointer;
        font-family: inherit; font-size: 12px;
      }
      #modal-buttons button:hover {
        background: var(--vscode-button-secondaryHoverBackground, var(--vscode-toolbar-hoverBackground));
      }
      #modal-buttons #modal-ok {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        border-color: var(--vscode-button-background);
      }
      #modal-buttons #modal-ok:hover {
        background: var(--vscode-button-hoverBackground);
      }
      #mode-toggle {
        position: fixed; top: 12px; right: 12px; z-index: 10;
        display: inline-flex;
        background: var(--vscode-editorWidget-background);
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 6px; overflow: hidden;
        font-family: inherit; font-size: 12px;
      }
      #mode-toggle.hidden { display: none; }
      #mode-toggle button {
        background: transparent;
        color: var(--vscode-descriptionForeground);
        border: none;
        padding: 6px 12px; cursor: pointer; font-family: inherit;
        font-size: 12px;
        border-right: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      }
      #mode-toggle button:last-child { border-right: none; }
      #mode-toggle button:hover {
        background: var(--vscode-toolbar-hoverBackground);
        color: var(--vscode-foreground);
      }
      body[data-mode="pan"] #mode-pan,
      body[data-mode="edit"] #mode-edit {
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      #zoom-control {
        position: fixed; bottom: 12px; right: 12px; z-index: 10;
        display: flex; align-items: center; gap: 6px;
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        padding: 4px 8px; border-radius: 6px; font-size: 12px;
        font-family: inherit;
        box-shadow: 0 4px 12px var(--vscode-widget-shadow, transparent);
      }
      #zoom-control.hidden { display: none; }
      #zoom-control button {
        background: transparent;
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        width: 24px; height: 24px; border-radius: 4px; cursor: pointer;
        font-family: inherit; font-size: 14px; line-height: 1;
        display: inline-flex; align-items: center; justify-content: center;
      }
      #zoom-control button:hover { background: var(--vscode-toolbar-hoverBackground); }
      #zoom-slider {
        width: 160px; cursor: pointer;
        accent-color: var(--vscode-button-background);
      }
      #zoom-label {
        min-width: 44px; text-align: right;
        color: var(--vscode-descriptionForeground);
        font-variant-numeric: tabular-nums;
      }
      #zoom-fit { font-size: 11px; }
      #diagnostics {
        position: fixed; bottom: 12px; left: 12px; z-index: 10;
        max-width: calc(100vw - 24px);
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 6px; font-size: 12px;
        box-shadow: 0 4px 12px var(--vscode-widget-shadow, transparent);
      }
      #diagnostics.hidden { display: none; }
      #diagnostics-summary {
        padding: 6px 12px; cursor: pointer; user-select: none;
        display: flex; align-items: center; gap: 8px;
      }
      #diagnostics-summary:hover { background: var(--vscode-toolbar-hoverBackground); }
      #diagnostics-list {
        max-height: 240px; overflow-y: auto;
        border-top: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        padding: 8px 12px;
      }
      #diagnostics-list.hidden { display: none; }
      .diag-item { padding: 4px 0; line-height: 1.4; }
      .diag-rule {
        color: var(--vscode-descriptionForeground);
        font-family: var(--vscode-editor-font-family, ui-monospace, monospace);
        font-size: 10px; margin-right: 6px;
      }
      svg [data-component-id] { cursor: default; }
      svg [data-relationship-group] { cursor: pointer; }
      svg .pv-edge-badge-bg {
        fill: var(--vscode-badge-background, #444);
        stroke: var(--vscode-editor-background);
        stroke-width: 1.5;
      }
      svg .pv-edge-badge-text {
        fill: var(--vscode-badge-foreground, #fff);
        font-size: 11px;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
        pointer-events: none;
      }
      body[data-mode="edit"] svg [data-component-id]:not([data-container]) { cursor: grab; }
      body[data-mode="edit"] svg [data-component-id]:not([data-container]):hover rect,
      body[data-mode="edit"] svg [data-component-id]:not([data-container]):hover ellipse,
      body[data-mode="edit"] svg [data-component-id]:not([data-container]):hover path { stroke-width: 2.5; }
      #legend {
        position: fixed; top: 12px; left: 12px; z-index: 10;
        background: var(--vscode-editorWidget-background);
        color: var(--vscode-foreground);
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 6px;
        font-size: 12px;
        font-family: inherit;
        box-shadow: 0 4px 12px var(--vscode-widget-shadow, transparent);
        display: flex; flex-direction: column;
        max-width: min(280px, calc(100vw - 24px));
        max-height: calc(100vh - 24px);
        user-select: none;
      }
      #legend.hidden { display: none; }
      #legend-header {
        display: flex; align-items: center; gap: 8px;
        padding: 6px 8px 6px 10px;
        cursor: grab;
        border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
      }
      #legend-header:active { cursor: grabbing; }
      #legend.collapsed #legend-header { border-bottom: none; }
      #legend-title {
        flex: 1;
        font-size: 10px; font-weight: 600;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      #legend-toggle {
        background: transparent;
        color: var(--vscode-foreground);
        border: none; cursor: pointer;
        padding: 2px 6px; border-radius: 3px;
        font-family: inherit; font-size: 14px; line-height: 1;
        min-width: 20px;
      }
      #legend-toggle:hover { background: var(--vscode-toolbar-hoverBackground); }
      #legend-body {
        padding: 6px 10px 8px 10px;
        overflow-y: auto;
        min-width: 0;
      }
      #legend.collapsed #legend-body { display: none; }
      #legend h4 {
        margin: 0 0 4px 0;
        font-size: 10px;
        font-weight: 600;
        color: var(--vscode-descriptionForeground);
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      #legend h4:not(:first-child) { margin-top: 8px; }
      .legend-row {
        display: flex; align-items: center; gap: 8px;
        padding: 2px 0;
        line-height: 1.4;
        min-width: 0;
      }
      .legend-row svg { flex-shrink: 0; }
      .legend-row span {
        min-width: 0;
        overflow-wrap: anywhere;
      }
    </style>
  </head>
  <body>
    <div id="stage"></div>
    <div id="empty">Loading…</div>
    <button id="settings-button" class="hidden" type="button" title="Open Project Viewer settings">⚙</button>
    <button id="reset-button" class="hidden" type="button" title="Re-run layout from scratch (clears any positions you've dragged)">↻ Reset layout</button>
    <div id="modal-backdrop" class="hidden">
      <div id="modal">
        <div id="modal-message"></div>
        <div id="modal-buttons">
          <button id="modal-cancel" type="button">Cancel</button>
          <button id="modal-ok" type="button">OK</button>
        </div>
      </div>
    </div>
    <div id="mode-toggle" class="hidden">
      <button id="mode-pan" type="button">🖐 Pan</button>
      <button id="mode-edit" type="button">✏️ Edit</button>
    </div>
    <div id="zoom-control" class="hidden">
      <button id="zoom-out" title="Zoom out">−</button>
      <input type="range" id="zoom-slider" />
      <button id="zoom-in" title="Zoom in">+</button>
      <span id="zoom-label">100%</span>
      <button id="zoom-fit" title="Fit to screen">fit</button>
    </div>
    <div id="diagnostics" class="hidden">
      <div id="diagnostics-summary"><span id="diagnostics-count"></span><span style="color:var(--vscode-descriptionForeground)">click to expand</span></div>
      <div id="diagnostics-list" class="hidden"></div>
    </div>
    <div id="legend" class="hidden">
      <div id="legend-header">
        <span id="legend-title">Legend</span>
        <button id="legend-toggle" type="button" title="Collapse">−</button>
      </div>
      <div id="legend-body"></div>
    </div>
    <script src="${scriptUri}"></script>
  </body>
</html>`;
}
