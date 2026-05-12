// little-oxford — webview panel (direct library calls, no daemon).
//
// HTML shell lives in panel_html.ts; this file is just the orchestration:
// state, message dispatch, applyPin / resetLayout / openAnchor handlers,
// and the rerender pipeline.

import * as vscode from 'vscode';
import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';
import { updateStatusBar } from './statusbar';
import { recorder, DIAG_MESSAGE_TYPE, type DiagBridgeMessage } from '../diagnostics';
import { resolveAnchor } from './anchor';
import { readDiagram, mutateLayout, listDiagramFiles, readLayout } from '../diagram/storage';
import { readActivity, checkOrphanActivity } from '../diagram/activity';
import { filterActivityToComponents } from '../diagram/activity_filter';
import { renderDiagram } from '../diagram/render';
import { PANEL_SHOW_DEBOUNCE_MS } from './timing';
import { htmlShell } from './panel_html';
import { parsePanelMessage } from './panel_messages';

let panel: vscode.WebviewPanel | undefined;
let extensionContext: vscode.ExtensionContext | undefined;
let activeModelFile = 'model.json';
let pendingTraceId: string | undefined;

let showDebounce: ReturnType<typeof setTimeout> | undefined;

export function showPanel(context: vscode.ExtensionContext): void {
  extensionContext = context;
  if (__DEBUG__) recorder.emit('host', 'panel-show', { existed: !!panel });

  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    if (showDebounce) clearTimeout(showDebounce);
    showDebounce = setTimeout(() => { showDebounce = undefined; void rerender(); }, PANEL_SHOW_DEBOUNCE_MS);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'little-oxford',
    'little-oxford',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist')],
      retainContextWhenHidden: true,
    },
  );

  panel.webview.html = htmlShell(panel.webview, context.extensionUri);

  panel.onDidDispose(() => {
    panel = undefined;
  });

  panel.webview.onDidReceiveMessage((raw) => {
    const msg = parsePanelMessage(raw, DIAG_MESSAGE_TYPE);
    if (!msg) return;
    switch (msg.type) {
      case 'ready':
        void rerender();
        return;
      case 'pin':
        void applyPin(msg.id, msg.x, msg.y, msg.w, msg.h, msg.traceId, msg.parentRelative);
        return;
      case 'open-anchor':
        void openAnchor(msg.value);
        return;
      case 'reset-layout':
        void resetLayout();
        return;
      case 'open-settings':
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:marcusraty.little-oxford',
        );
        return;
      case 'open-help':
        void vscode.commands.executeCommand('little-oxford.openHelp');
        return;
      case 'set-active-model':
        activeModelFile = msg.name;
        void rerender();
        return;
      case 'diag':
        if (__DEBUG__) recorder.ingest((msg.event as DiagBridgeMessage['event']));
        return;
    }
  });
}

export async function triggerRerender(): Promise<void> {
  await rerender();
}

export function disposePanel(): void {
  if (showDebounce) { clearTimeout(showDebounce); showDebounce = undefined; }
  panel?.dispose();
  panel = undefined;
}

async function applyPin(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  traceId?: string,
  parentRelative = false,
): Promise<void> {
  if (!id) return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  if (__DEBUG__) {
    recorder.emit('host', 'pin-received', { id, x, y, w, h, parentRelative }, traceId);
    pendingTraceId = traceId;
  }

  const rounded = {
    x: Math.round(x),
    y: Math.round(y),
    w: Math.round(w),
    h: Math.round(h),
  };

  const diagram = await readDiagram(root);
  const componentIds = diagram ? new Set(Object.keys(diagram.components)) : new Set<string>();

  await mutateLayout(root, (layout) => {
    const components = layout.components ?? {};
    // If the webview already computed parent-relative coords, save them
    // directly. Otherwise fall back to the older absolute-to-relative
    // conversion using the parent's saved position (works only when the
    // parent is already pinned).
    if (!parentRelative) {
      const parentId = diagram?.components?.[id]?.parent;
      if (parentId && components[parentId]) {
        const parent = components[parentId];
        rounded.x -= parent.x;
        rounded.y -= parent.y;
      }
    }
    components[id] = rounded;
    layout.components = components;
  }, componentIds);

  if (__DEBUG__) {
    recorder.emit('host', 'pin-written', { id, position: rounded, parentRelative }, traceId);
  }
}

async function resetLayout(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (root) {
    const layoutPath = nodePath.join(root, '.oxford', 'layout.json');
    try { await fsp.unlink(layoutPath); } catch { /* layout.json may not exist */ }
  }
  await rerender();
}

async function openAnchor(value: string): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root || !value) return;
  const resolved = resolveAnchor(root, value);
  if ('error' in resolved) {
    vscode.window.showErrorMessage(`little-oxford: ${resolved.error}`);
    return;
  }
  const fileUri = vscode.Uri.file(resolved.absPath);
  let editor: vscode.TextEditor;
  try {
    const doc = await vscode.workspace.openTextDocument(fileUri);
    editor = await vscode.window.showTextDocument(doc, { preview: false });
  } catch (e) {
    vscode.window.showErrorMessage(`little-oxford: couldn't open ${value}: ${(e as Error).message}`);
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

async function getModelPickerState(): Promise<{ availableModels: string[]; activeModel: string }> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const availableModels = root ? await listDiagramFiles(root) : [];
  return { availableModels, activeModel: activeModelFile };
}

async function rerender(): Promise<void> {
  if (!panel) return;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) return;

  const traceId = pendingTraceId;
  if (__DEBUG__) recorder.emit('host', 'rerender-start', {}, traceId);

  const pickerState = await getModelPickerState();

  const diagram = await readDiagram(root, activeModelFile);
  if (!diagram) {
    panel.webview.postMessage({
      type: 'empty',
      message: `No diagram found.\nCreate .oxford/${activeModelFile} to get started.`,
      ...pickerState,
    });
    if (__DEBUG__) recorder.emit('host', 'rerender-no-model', {}, traceId);
    // P4: clear traceId on every return path so a subsequent rerender
    // doesn't inherit a stale id.
    pendingTraceId = undefined;
    return;
  }

  if (__DEBUG__) recorder.emit('host', 'rerender-read', { layout: diagram.layout ?? null }, traceId);

  // Activity is read after the diagram snapshot, so it may contain entries
  // for components the diagram no longer has (a deletion landed in between).
  // Filter to the current component set so the webview can't reference
  // ghost components in its tooltips.
  const rawActivity = await readActivity(root);
  const activity = filterActivityToComponents(rawActivity, Object.keys(diagram.components));

  let output;
  try {
    output = await renderDiagram(diagram, undefined, activity);
  } catch (e) {
    panel.webview.postMessage({
      type: 'error',
      message: `Render error: ${(e as Error).message}`,
      ...pickerState,
    });
    pendingTraceId = undefined;
    return;
  }

  await mutateLayout(root, (layout) => {
    const elkRelative = output.layout.components ?? {};
    const saved = layout.components ?? {};
    const merged = { ...elkRelative, ...saved };

    if (diagram) {
      for (const [id, comp] of Object.entries(diagram.components)) {
        if (!comp.parent) continue;
        const parentSaved = saved[comp.parent];
        const parentElk = elkRelative[comp.parent];
        if (parentSaved && parentElk) {
          const dx = parentSaved.x - parentElk.x;
          const dy = parentSaved.y - parentElk.y;
          if ((dx !== 0 || dy !== 0) && elkRelative[id]) {
            merged[id] = { ...elkRelative[id], x: elkRelative[id].x + dx, y: elkRelative[id].y + dy };
          }
        }
      }
    }

    layout.canvasWidth = output.layout.canvasWidth;
    layout.canvasHeight = output.layout.canvasHeight;
    layout.components = merged;
  });

  const diagnostics = [...output.diagnostics];
  const errors = diagnostics.filter((d) => d.level === 'error');
  if (errors.length > 0) {
    panel.webview.postMessage({
      type: 'error',
      message: errors.map((e) => `• ${e.message}`).join('\n'),
      ...pickerState,
    });
    if (__DEBUG__) {
      recorder.emit('host', 'rerender-error', { errors }, traceId);
      pendingTraceId = undefined;
    }
    return;
  }

  const componentCount = Object.keys(diagram.components ?? {}).length;
  const warningCount = diagnostics.filter((d) => d.level === 'warning').length;

  panel.webview.postMessage({
    type: 'svg', svg: output.svg, diagnostics, diagram, activity, traceId,
    ...pickerState,
  });

  void updateStatusBar(componentCount, warningCount);

  if (__DEBUG__) {
    recorder.emit('host', 'rerender-end', { components: componentCount, warnings: warningCount }, traceId);
    pendingTraceId = undefined;
  }
}
