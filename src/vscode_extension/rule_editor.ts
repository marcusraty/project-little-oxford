import * as vscode from 'vscode';
import { serializeRulesForScript } from '../audit/rule_serialize';

export class RuleEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = 'little-oxford.ruleEditor';

  resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): void {
    webviewPanel.webview.options = { enableScripts: true };
    webviewPanel.webview.html = buildEditorHtml(document);

    // RE2: debounce save so a fast typist doesn't trigger a workspaceEdit
    // (+ disk write under auto-save) per keystroke.
    let saveDebounce: ReturnType<typeof setTimeout> | undefined;
    let lastDataFromWebview: unknown = null;
    const flushSave = () => {
      saveDebounce = undefined;
      if (lastDataFromWebview === null) return;
      const edit = new vscode.WorkspaceEdit();
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length),
      );
      edit.replace(document.uri, fullRange, JSON.stringify(lastDataFromWebview, null, 2) + '\n');
      void vscode.workspace.applyEdit(edit);
      lastDataFromWebview = null;
    };

    // RE3: instead of rebuilding the entire webview HTML on every doc
    // change (which loses scroll, focus, partially-typed input), only
    // re-rebuild if the change came from OUTSIDE the editor (e.g. the
    // user edited the JSON in a separate text view).
    const docSub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document.uri.toString() !== document.uri.toString()) return;
      if (e.contentChanges.length === 0) return;
      // If the change was caused by our own applyEdit (lastDataFromWebview
      // just flushed), skip — the webview already reflects this state.
      if (e.reason !== undefined) {
        // Undo / redo — content the webview doesn't know about. Refresh.
        webviewPanel.webview.html = buildEditorHtml(document);
        return;
      }
      // Other source: probably an external editor. Refresh.
      webviewPanel.webview.html = buildEditorHtml(document);
    });

    webviewPanel.onDidDispose(() => {
      if (saveDebounce) clearTimeout(saveDebounce);
      docSub.dispose();
    });

    webviewPanel.webview.onDidReceiveMessage((msg) => {
      if (msg.type === 'update') {
        lastDataFromWebview = msg.data;
        if (saveDebounce) clearTimeout(saveDebounce);
        saveDebounce = setTimeout(flushSave, 250);
      }
    });
  }
}

function buildEditorHtml(document: vscode.TextDocument): string {
  let rules: any[] = [];
  try {
    const parsed = JSON.parse(document.getText());
    rules = parsed.rules ?? [];
  } catch { /* invalid JSON */ }

  const fileName = document.uri.path.split('/').pop() ?? '';

  const rulesHtml = rules.map((r: any, i: number) => `
    <div class="rule" data-index="${i}">
      <div class="rule-header" onclick="toggle(${i})">
        <span class="chevron" id="chev-${i}">▶</span>
        <span class="rule-id">${esc(r.id ?? '')}</span>
        <span class="rule-name">${esc(r.name ?? '')}</span>
        <span class="rule-severity sev-${r.severity ?? 'warning'}">${esc(r.severity ?? '')}</span>
      </div>
      <div class="rule-body hidden" id="body-${i}">
        <label>ID <input type="text" data-field="id" data-index="${i}" value="${esc(r.id ?? '')}" /></label>
        <label>Name <input type="text" data-field="name" data-index="${i}" value="${esc(r.name ?? '')}" /></label>
        <label>Kinds
          <div class="kinds-group">
            ${['text', 'thinking', 'tool_use', 'user_prompt', 'system'].map(k =>
              `<label class="kind-check"><input type="checkbox" data-kind="${k}" data-index="${i}" ${(r.kinds ?? []).includes(k) ? 'checked' : ''} /> ${k}</label>`
            ).join('')}
          </div>
        </label>
        ${r.pattern !== undefined || !r.trigger ? `<label>Pattern <input type="text" data-field="pattern" data-index="${i}" value="${esc(r.pattern ?? '')}" placeholder="regex" /></label>` : ''}
        ${r.trigger !== undefined || r.companions ? `
          <label>Trigger file <input type="text" data-field="trigger" data-index="${i}" value="${esc(r.trigger ?? '')}" placeholder="src/..." /></label>
          <label>Companion files <input type="text" data-field="companions" data-index="${i}" value="${esc((r.companions ?? []).join(', '))}" placeholder="tests/..., src/..." /></label>
          <label class="kind-check"><input type="checkbox" data-field="any" data-index="${i}" ${r.any ? 'checked' : ''} /> Any companion (vs all)</label>
        ` : ''}
        <label>Hook
          <select data-field="hook" data-index="${i}">
            <option value="" ${!r.hook ? 'selected' : ''}>None</option>
            <option value="Stop" ${r.hook === 'Stop' ? 'selected' : ''}>Stop</option>
            <option value="PostToolUse" ${r.hook === 'PostToolUse' ? 'selected' : ''}>PostToolUse</option>
            <option value="PreToolUse" ${r.hook === 'PreToolUse' ? 'selected' : ''}>PreToolUse</option>
          </select>
        </label>
        <label>Message <textarea data-field="message" data-index="${i}" rows="2" placeholder="What the agent sees">${esc(r.message ?? '')}</textarea></label>
        <div class="row">
          <label>Action
            <select data-field="action" data-index="${i}">
              <option value="hook" ${r.action === 'hook' ? 'selected' : ''}>hook</option>
              <option value="log" ${r.action === 'log' ? 'selected' : ''}>log</option>
            </select>
          </label>
          <label>Severity
            <select data-field="severity" data-index="${i}">
              <option value="info" ${r.severity === 'info' ? 'selected' : ''}>info</option>
              <option value="warning" ${r.severity === 'warning' ? 'selected' : ''}>warning</option>
              <option value="error" ${r.severity === 'error' ? 'selected' : ''}>error</option>
            </select>
          </label>
        </div>
        <button class="delete-btn" onclick="deleteRule(${i})">Delete rule</button>
      </div>
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family, system-ui);
    font-size: 13px;
    color: var(--vscode-foreground, #ccc);
    background: var(--vscode-editor-background, #1e1e1e);
    padding: 16px;
  }
  .file-header {
    font-size: 14px;
    font-weight: 600;
    margin-bottom: 12px;
    color: var(--vscode-foreground, #ccc);
  }
  .file-header span { color: var(--vscode-descriptionForeground, #888); font-weight: 400; font-size: 12px; }
  .rule {
    border: 1px solid var(--vscode-panel-border, #333);
    border-radius: 4px;
    margin-bottom: 8px;
  }
  .rule-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    user-select: none;
  }
  .rule-header:hover { background: var(--vscode-list-hoverBackground, #2a2d2e); }
  .chevron { font-size: 10px; width: 12px; transition: transform 0.15s; }
  .chevron.open { transform: rotate(90deg); }
  .rule-id { font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); min-width: 30px; }
  .rule-name { flex: 1; }
  .rule-severity {
    font-size: 10px; padding: 1px 6px; border-radius: 3px; font-weight: 600;
  }
  .sev-warning { background: #7d4e00; color: #fff; }
  .sev-error { background: #a1260d; color: #fff; }
  .sev-info { background: #1a5276; color: #fff; }
  .rule-body {
    padding: 12px;
    border-top: 1px solid var(--vscode-panel-border, #333);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .hidden { display: none !important; }
  label {
    display: flex;
    flex-direction: column;
    gap: 3px;
    font-size: 11px;
    color: var(--vscode-descriptionForeground, #888);
  }
  input, select, textarea {
    background: var(--vscode-input-background, #2a2d2e);
    color: var(--vscode-input-foreground, #ccc);
    border: 1px solid var(--vscode-input-border, #444);
    border-radius: 3px;
    padding: 4px 8px;
    font-size: 13px;
    font-family: var(--vscode-font-family, system-ui);
  }
  textarea { resize: vertical; }
  .row { display: flex; gap: 12px; }
  .row label { flex: 1; }
  .kinds-group { display: flex; gap: 8px; flex-wrap: wrap; }
  .kind-check {
    flex-direction: row;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--vscode-foreground, #ccc);
  }
  .kind-check input { width: auto; }
  .delete-btn {
    align-self: flex-start;
    background: transparent;
    color: var(--vscode-errorForeground, #f48771);
    border: 1px solid var(--vscode-errorForeground, #f48771);
    border-radius: 3px;
    padding: 3px 10px;
    cursor: pointer;
    font-size: 11px;
    margin-top: 4px;
  }
  .add-btn {
    background: var(--vscode-button-background, #0e639c);
    color: var(--vscode-button-foreground, #fff);
    border: none;
    border-radius: 4px;
    padding: 6px 14px;
    cursor: pointer;
    font-size: 12px;
    margin-top: 8px;
  }
</style>
</head>
<body>
  <div class="file-header">${esc(fileName)} <span>${rules.length} rule${rules.length !== 1 ? 's' : ''}</span></div>
  <div id="rules">${rulesHtml}</div>
  <button class="add-btn" onclick="addRule()">+ Add Rule</button>
<script>
  const vscode = acquireVsCodeApi();
  let rules = ${serializeRulesForScript(rules)};

  function esc(s) { return (s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

  function toggle(i) {
    const body = document.getElementById('body-' + i);
    const chev = document.getElementById('chev-' + i);
    body.classList.toggle('hidden');
    chev.classList.toggle('open');
  }

  function save() {
    vscode.postMessage({ type: 'update', data: { rules } });
  }

  function deleteRule(i) {
    rules.splice(i, 1);
    save();
  }

  function addRule() {
    rules.push({ id: '', name: 'New rule', kinds: ['text'], pattern: '', hook: 'Stop', message: '', action: 'hook', severity: 'warning' });
    save();
  }

  document.addEventListener('change', (e) => {
    const el = e.target;
    const i = parseInt(el.dataset.index);
    if (isNaN(i)) return;
    const field = el.dataset.field;
    const kind = el.dataset.kind;

    if (kind) {
      if (!rules[i].kinds) rules[i].kinds = [];
      if (el.checked) {
        if (!rules[i].kinds.includes(kind)) rules[i].kinds.push(kind);
      } else {
        rules[i].kinds = rules[i].kinds.filter(k => k !== kind);
      }
    } else if (field === 'companions') {
      rules[i].companions = el.value.split(',').map(s => s.trim()).filter(Boolean);
    } else if (field === 'any') {
      rules[i].any = el.checked;
    } else if (field === 'hook') {
      rules[i].hook = el.value || undefined;
    } else if (field) {
      rules[i][field] = el.value;
    }
    save();
  });

  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.tagName === 'TEXTAREA') {
      const i = parseInt(el.dataset.index);
      if (!isNaN(i) && el.dataset.field) {
        rules[i][el.dataset.field] = el.value;
        save();
      }
    }
  });
</script>
</body>
</html>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
