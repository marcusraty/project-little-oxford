// little-oxford diagram webview script.
//
// d3-zoom, d3-drag, tooltip, focus, legend, popover — all sharing
// module-scope DOM refs and SVG state. Pure metadata-table rendering
// lives in webview_metadata.ts; the rest stays here because the
// DOM-bound functions can't easily be extracted without passing every
// element ref through.
import { select, type Selection } from 'd3-selection';
import 'd3-transition';
import { zoom as d3Zoom, zoomIdentity, type ZoomBehavior, type ZoomTransform } from 'd3-zoom';
import { drag as d3Drag } from 'd3-drag';
import { recorder, installRecorder, bridgeSink } from '../diagnostics';
import { collectDescendants } from '../diagram/descendants';
import { renderMetadataTable } from './webview_metadata';
import {
  computeEdgeEndpoints,
  perpendicularLabelPos,
  type BoxRect,
} from '../diagram/geometry';
import { timeAgo } from '../diagram/time';
import { escapeHtml, escapeAttr } from '../audit/html_escape';

declare function acquireVsCodeApi(): { postMessage: (msg: unknown) => void };
const vscode = acquireVsCodeApi();

// Diagnostics: only wires under `__DEBUG__`. The bridge sink posts each
// event back to the extension host as a `__diag` message; the host
// ingests it into the same recorder that owns the file sink, so webview
// + host events land interleaved in one log.
//
// Callers emit via `if (__DEBUG__) recorder.emit(...)` at the use site —
// inlining the guard so esbuild's syntax DCE drops both the call AND its
// argument expression (data payloads, string literals) from prod bundles.
// A wrapper helper would defeat that — esbuild can't see through a
// function call to elide the args.
if (__DEBUG__) {
  const r = installRecorder();
  r.use(bridgeSink((msg) => vscode.postMessage(msg)));
  r.emit('webview', 'webview-loaded', {});
}

const stage = document.getElementById('stage') as HTMLDivElement;
const empty = document.getElementById('empty') as HTMLDivElement;
const modeToggle = document.getElementById('mode-toggle') as HTMLDivElement;
const modePanBtn = document.getElementById('mode-pan') as HTMLButtonElement;
const modeEditBtn = document.getElementById('mode-edit') as HTMLButtonElement;
const diagBox = document.getElementById('diagnostics') as HTMLDivElement;
const diagSummary = document.getElementById('diagnostics-summary') as HTMLDivElement;
const diagCount = document.getElementById('diagnostics-count') as HTMLSpanElement;
const diagList = document.getElementById('diagnostics-list') as HTMLDivElement;
const zoomCtrl = document.getElementById('zoom-control') as HTMLDivElement;
const zoomSlider = document.getElementById('zoom-slider') as HTMLInputElement;
const zoomLabel = document.getElementById('zoom-label') as HTMLSpanElement;
const zoomInBtn = document.getElementById('zoom-in') as HTMLButtonElement;
const zoomOutBtn = document.getElementById('zoom-out') as HTMLButtonElement;
const zoomFitBtn = document.getElementById('zoom-fit') as HTMLButtonElement;
const legendBox = document.getElementById('legend') as HTMLDivElement;
const legendHeader = document.getElementById('legend-header') as HTMLDivElement;
const legendBody = document.getElementById('legend-body') as HTMLDivElement;
const legendToggle = document.getElementById('legend-toggle') as HTMLButtonElement;
const resetButton = document.getElementById('reset-button') as HTMLButtonElement;
const settingsButton = document.getElementById('settings-button') as HTMLButtonElement;

const modelPicker = document.getElementById('model-picker') as HTMLSelectElement;

settingsButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'open-settings' });
});

const helpButton = document.getElementById('help-button') as HTMLButtonElement | null;
if (helpButton) helpButton.addEventListener('click', () => vscode.postMessage({ type: 'open-help' }));


modelPicker.addEventListener('change', () => {
  vscode.postMessage({ type: 'set-active-model', name: modelPicker.value });
});

// Reflects the host's view of which .oxford/*.json files exist and which
// one is currently active. Hidden when there's nothing to pick from
// (single file or no folder open). The `data-known-list` cache avoids
// rebuilding <option> nodes every render — the dropdown's open state is
// preserved in the common case where the file list hasn't changed.
function updateModelPicker(activeModel: string | undefined, availableModels: string[] | undefined): void {
  if (!availableModels || availableModels.length === 0) {
    modelPicker.classList.add('hidden');
    return;
  }
  const desired = availableModels.join('|');
  if (modelPicker.dataset.knownList !== desired) {
    modelPicker.innerHTML = availableModels
      .map((n) => `<option value="${escapeAttr(n)}">${escapeHtml(n)}</option>`)
      .join('');
    modelPicker.dataset.knownList = desired;
  }
  if (activeModel) modelPicker.value = activeModel;
  modelPicker.classList.remove('hidden');
}
const modalBackdrop = document.getElementById('modal-backdrop') as HTMLDivElement;
const modalMessage = document.getElementById('modal-message') as HTMLDivElement;
const modalOk = document.getElementById('modal-ok') as HTMLButtonElement;
const modalCancel = document.getElementById('modal-cancel') as HTMLButtonElement;

// VS Code webviews disable native window.confirm() / alert() — clicking
// the button with confirm() does nothing because the browser dialog is
// blocked. We render our own modal instead.
function customConfirm(message: string): Promise<boolean> {
  return new Promise((resolve) => {
    modalMessage.textContent = message;
    modalBackdrop.classList.remove('hidden');
    modalOk.focus();

    const cleanup = () => {
      modalBackdrop.classList.add('hidden');
      modalOk.removeEventListener('click', onOk);
      modalCancel.removeEventListener('click', onCancel);
      modalBackdrop.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKeydown);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onBackdrop = (e: MouseEvent) => {
      if (e.target === modalBackdrop) onCancel();
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      else if (e.key === 'Enter') onOk();
    };

    modalOk.addEventListener('click', onOk);
    modalCancel.addEventListener('click', onCancel);
    modalBackdrop.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKeydown);
  });
}

resetButton.addEventListener('click', async () => {
  const ok = await customConfirm(
    'Reset the layout?\n\n' +
      'This re-runs the layout engine (ELK) and discards every box ' +
      "position you've dragged. The diagram definition " +
      "isn't touched — only the saved positions in layout.json.",
  );
  if (!ok) return;
  vscode.postMessage({ type: 'reset-layout' });
});

interface Diagnostic {
  level: 'error' | 'warning';
  rule: string;
  message: string;
  path?: string;
}

interface ComponentStyle {
  symbol?: string;
  color?: string;
  border?: string;
  fill?: string;
}

interface RelationshipStyle {
  style?: string;
  show_metadata?: string[];
}

function showDiagnostics(items: Diagnostic[]): void {
  if (!items || items.length === 0) {
    diagBox.classList.add('hidden');
    diagList.classList.add('hidden');
    return;
  }
  diagCount.textContent = `⚠️ ${items.length} ${items.length === 1 ? 'warning' : 'warnings'}`;
  diagList.innerHTML = items
    .map(
      (d) =>
        `<div class="diag-item"><span class="diag-rule">${d.rule}</span>${escapeHtml(d.message)}</div>`,
    )
    .join('');
  diagBox.classList.remove('hidden');
}


// Renders the legend overlay from the diagram's `rules` block. One row
// per component kind: a swatch matching the kind's symbol/color/border
// next to the kind name. We don't show a relationships section — every
// edge renders the same way regardless of kind, so a relationship-kind
// list adds nothing.
//
// Hidden when there are no component styles to show.
function showLegend(rules: CachedDiagram['rules']): void {
  const compStyles = rules?.component_styles ?? {};
  const compKinds = Object.entries(compStyles);

  if (compKinds.length === 0) {
    legendBox.classList.add('hidden');
    return;
  }

  let html = '';
  for (const [kind, style] of compKinds) {
    html += `<div class="legend-row">${componentSwatch(style)}<span>${escapeHtml(kind)}</span></div>`;
  }
  legendBody.innerHTML = html;
  legendBox.classList.remove('hidden');

  // After populating (and after any expand), re-clamp into the viewport.
  // The legend's natural size depends on its contents; we measure
  // post-render and shift the box if it would overflow.
  ensureLegendInViewport();
}

// Mini SVG matching the renderer's box shape so the swatch communicates
// both color and symbol (rectangle vs cylinder).
function componentSwatch(style: ComponentStyle): string {
  const fill = escapeAttr(style.fill ?? 'transparent');
  const stroke = escapeAttr(style.color ?? 'currentColor');
  const dash = style.border === 'dashed' ? ' stroke-dasharray="3 2"' : '';
  if (style.symbol === 'cylinder') {
    return `<svg width="20" height="14" viewBox="0 0 20 14"><ellipse cx="10" cy="3" rx="8" ry="2.5" fill="${fill}" stroke="${stroke}" stroke-width="1.2"${dash}/><path d="M2,3 L2,11 A8,2.5 0 0 0 18,11 L18,3" fill="${fill}" stroke="${stroke}" stroke-width="1.2"${dash}/><ellipse cx="10" cy="11" rx="8" ry="2.5" fill="${fill}" stroke="${stroke}" stroke-width="1.2"${dash}/></svg>`;
  }
  if (style.symbol === 'diamond') {
    return `<svg width="20" height="14" viewBox="0 0 20 14"><path d="M10,1 L19,7 L10,13 L1,7 Z" fill="${fill}" stroke="${stroke}" stroke-width="1.2"${dash}/></svg>`;
  }
  return `<svg width="20" height="14" viewBox="0 0 20 14"><rect x="1" y="1" width="18" height="12" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="1.2"${dash}/></svg>`;
}


// ── Legend: drag + collapse ────────────────────────────────────────────────
//
// The legend is a fixed-position overlay that the user can drag around the
// viewport and collapse to a small header. State is per-session (no
// persistence). On every render-change and every expand, we re-clamp the
// box into the viewport so it can't end up partly off-screen.

function ensureLegendInViewport(): void {
  // Skip if hidden or collapsed (collapsed shrinks the box but the header
  // is small and unlikely to overflow; we still clamp on expand).
  if (legendBox.classList.contains('hidden')) return;
  const r = legendBox.getBoundingClientRect();
  const margin = 6;
  let x = r.left;
  let y = r.top;
  if (x + r.width > window.innerWidth - margin) x = window.innerWidth - r.width - margin;
  if (y + r.height > window.innerHeight - margin) y = window.innerHeight - r.height - margin;
  if (x < margin) x = margin;
  if (y < margin) y = margin;
  legendBox.style.left = x + 'px';
  legendBox.style.top = y + 'px';
}

let legendDrag:
  | { startX: number; startY: number; offsetX: number; offsetY: number }
  | undefined;

legendHeader.addEventListener('mousedown', (e) => {
  // Don't start a drag if the user clicked the toggle button.
  if (e.target instanceof HTMLButtonElement) return;
  e.preventDefault();
  const r = legendBox.getBoundingClientRect();
  legendDrag = {
    startX: e.clientX,
    startY: e.clientY,
    offsetX: e.clientX - r.left,
    offsetY: e.clientY - r.top,
  };
});

window.addEventListener('mousemove', (e) => {
  if (!legendDrag) return;
  const r = legendBox.getBoundingClientRect();
  let x = e.clientX - legendDrag.offsetX;
  let y = e.clientY - legendDrag.offsetY;
  // Clamp during drag so you can't drop it off-screen.
  const margin = 6;
  if (x + r.width > window.innerWidth - margin) x = window.innerWidth - r.width - margin;
  if (y + r.height > window.innerHeight - margin) y = window.innerHeight - r.height - margin;
  if (x < margin) x = margin;
  if (y < margin) y = margin;
  legendBox.style.left = x + 'px';
  legendBox.style.top = y + 'px';
});

window.addEventListener('mouseup', () => {
  legendDrag = undefined;
});

legendToggle.addEventListener('click', () => {
  const collapsed = legendBox.classList.toggle('collapsed');
  legendToggle.textContent = collapsed ? '+' : '−';
  legendToggle.title = collapsed ? 'Expand' : 'Collapse';
  // After expanding, the box is taller — re-clamp so the (potentially
  // newly visible) bottom edge stays inside the viewport.
  if (!collapsed) ensureLegendInViewport();
});

window.addEventListener('resize', ensureLegendInViewport);

interface CachedDiagram {
  components: Record<string, {
    kind: string;
    label: string;
    description?: string;
    parent: string | null;
    anchors?: Array<{ type: string; value: string }>;
    [extra: string]: unknown;
  }>;
  relationships: Record<string, {
    kind: string;
    from: string;
    to: string;
    metadata?: Record<string, unknown>;
    [extra: string]: unknown;
  }>;
  rules?: {
    component_styles?: Record<string, ComponentStyle>;
    relationship_styles?: Record<string, RelationshipStyle>;
  };
}

let currentDiagram: CachedDiagram | null = null;
let currentActivity: Record<string, { last_read: string; last_read_session: string; last_edit?: string; last_edit_session?: string; last_model_update?: string; last_model_update_verified?: boolean }> = {};

// Click-toggle focus: which component (if any) the user has selected to
// "spotlight." Connected edges/components stay full-color; the rest fade.
// Cleared on rerender (the new SVG won't carry the previous focus class
// anyway, and the focused id might no longer exist after a model edit).
let focusedComponentId: string | null = null;

diagSummary.addEventListener('click', () => {
  diagList.classList.toggle('hidden');
});

let zoomBehavior: ZoomBehavior<SVGSVGElement, unknown> | undefined;
let currentTransform: ZoomTransform = zoomIdentity;
let svgSelection: Selection<SVGSVGElement, unknown, null, undefined> | undefined;
let viewportG: SVGGElement | undefined;
let savedViewBox: { x: number; y: number; w: number; h: number } | undefined;
let mode: 'pan' | 'edit' = 'pan';

function setMode(next: 'pan' | 'edit'): void {
  mode = next;
  document.body.dataset.mode = mode;
}

modePanBtn.addEventListener('click', () => setMode('pan'));
modeEditBtn.addEventListener('click', () => setMode('edit'));

// Zoom slider <-> d3-zoom binding.
//
// Slider position is mapped to zoom level via log10 because the zoom range
// is multiplicative (0.1 → 20 spans 2.3 orders of magnitude). Linear
// mapping would put 100% at value=5 and 1000% at value=50 — a tiny bump
// near 1.0 zooms a lot, the rest of the slider does almost nothing. Log
// makes each slider increment a constant ratio, which is the "fine
// control everywhere" the user actually wants.
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 20;
zoomSlider.min = String(Math.log10(ZOOM_MIN));   // -1
zoomSlider.max = String(Math.log10(ZOOM_MAX));   //  ~1.301
zoomSlider.step = '0.001';
zoomSlider.value = '0';                           // 10^0 = 100%

function syncZoomUI(zoom: number): void {
  const clamped = Math.min(Math.max(zoom, ZOOM_MIN), ZOOM_MAX);
  zoomSlider.value = String(Math.log10(clamped));
  zoomLabel.textContent = `${Math.round(clamped * 100)}%`;
}

zoomSlider.addEventListener('input', () => {
  if (!svgSelection || !zoomBehavior) return;
  const k = Math.pow(10, Number(zoomSlider.value));
  svgSelection.call(zoomBehavior.scaleTo, k);
  zoomLabel.textContent = `${Math.round(k * 100)}%`;
});

zoomInBtn.addEventListener('click', () => {
  if (svgSelection && zoomBehavior) svgSelection.call(zoomBehavior.scaleBy, 1.2);
});
zoomOutBtn.addEventListener('click', () => {
  if (svgSelection && zoomBehavior) svgSelection.call(zoomBehavior.scaleBy, 1 / 1.2);
});
zoomFitBtn.addEventListener('click', () => {
  if (!svgSelection || !zoomBehavior) return;
  const fit = computeFitTransform(svgSelection.node()!);
  svgSelection.transition().duration(300).call(zoomBehavior.transform, fit);
});

function showEmpty(message: string): void {
  svgSelection?.on('.zoom', null);
  svgSelection = undefined;
  zoomBehavior = undefined;
  viewportG = undefined;
  stage.innerHTML = '';
  empty.textContent = message;
  empty.classList.remove('hidden');
  modeToggle.classList.add('hidden');
  zoomCtrl.classList.add('hidden');
  resetButton.classList.add('hidden');
  settingsButton.classList.add('hidden');
  showDiagnostics([]);
  legendBox.classList.add('hidden');
}

function computeFitTransform(svgEl: SVGSVGElement): ZoomTransform {
  const vb = savedViewBox;
  if (!vb) return zoomIdentity;
  const cw = svgEl.clientWidth || svgEl.parentElement!.clientWidth;
  const ch = svgEl.clientHeight || svgEl.parentElement!.clientHeight;
  const scale = Math.min(cw / vb.w, ch / vb.h);
  const tx = (cw - vb.w * scale) / 2 - vb.x * scale;
  const ty = (ch - vb.h * scale) / 2 - vb.y * scale;
  return zoomIdentity.translate(tx, ty).scale(scale);
}

function showSvg(svg: string, traceId?: string): void {
  const hadPriorView = !!svgSelection;
  const savedT = hadPriorView ? currentTransform : undefined;
  svgSelection?.on('.zoom', null);
  svgSelection = undefined;
  zoomBehavior = undefined;
  viewportG = undefined;

  focusedComponentId = null;
  stage.innerHTML = svg;
  empty.classList.add('hidden');
  modeToggle.classList.remove('hidden');
  zoomCtrl.classList.remove('hidden');
  resetButton.classList.remove('hidden');
  settingsButton.classList.remove('hidden');

  const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
  if (!svgEl) return;

  const vb = svgEl.viewBox.baseVal;
  savedViewBox = { x: vb.x, y: vb.y, w: vb.width, h: vb.height };

  svgEl.removeAttribute('viewBox');
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');
  svgEl.setAttribute('width', '100%');
  svgEl.setAttribute('height', '100%');

  const vg = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  const children = Array.from(svgEl.childNodes).filter(
    (n) => n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName !== 'defs',
  );
  for (const child of children) vg.appendChild(child);
  svgEl.appendChild(vg);
  viewportG = vg;

  const sel = select(svgEl);
  svgSelection = sel as any;

  const zb = d3Zoom<SVGSVGElement, unknown>()
    .scaleExtent([ZOOM_MIN, ZOOM_MAX])
    .filter((event) => {
      if (event.type === 'wheel') return true;
      if (mode === 'edit') return false;
      return true;
    })
    .on('zoom', (event) => {
      currentTransform = event.transform;
      vg.setAttribute('transform', event.transform.toString());
      syncZoomUI(event.transform.k);
    });
  zoomBehavior = zb;

  sel.call(zb);

  if (hadPriorView && savedT) {
    sel.call(zb.transform, savedT);
  } else {
    const fit = computeFitTransform(svgEl);
    sel.call(zb.transform, fit);
  }

  setMode(mode);
  wireDrag(svgEl);
  wireInteractions(svgEl);
  if (__DEBUG__) emitSvgApplied(svgEl, traceId);
}

// Reads back every component's rect coords as they actually exist in the
// DOM after the SVG is in the page. This is the "what does the user see"
// measurement — the final coord in the pipeline. If this disagrees with
// the host's rerender-end output layout, the bug is between SVG-build and
// DOM-paint (CSS, d3-zoom transforms, etc.). If it agrees, the bug is
// upstream.
function emitSvgApplied(svgEl: SVGSVGElement, traceId?: string): void {
  const groups = svgEl.querySelectorAll('[data-component-id]');
  const components: Record<string, { x: number; y: number; w: number; h: number }> = {};
  groups.forEach((g) => {
    const id = g.getAttribute('data-component-id');
    if (!id) return;
    const rect = g.querySelector('rect');
    if (rect) {
      components[id] = {
        x: Number(rect.getAttribute('x') ?? 0),
        y: Number(rect.getAttribute('y') ?? 0),
        w: Number(rect.getAttribute('width') ?? 0),
        h: Number(rect.getAttribute('height') ?? 0),
      };
    }
  });
  recorder.emit('webview', 'svg-applied', { components }, traceId);
}

function wireInteractions(svgEl: SVGSVGElement): void {
  svgEl.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    const componentGroup = target?.closest('[data-component-id]') as SVGGElement | null;
    if (__DEBUG__) {
      recorder.emit('webview', 'click', {
        mode,
        targetTag: target?.tagName,
        componentId: componentGroup?.getAttribute('data-component-id') ?? null,
        hasDiagram: !!currentDiagram,
        relCount: currentDiagram ? Object.keys(currentDiagram.relationships).length : 0,
        focusedBefore: focusedComponentId,
      });
    }
    if (mode === 'edit') return;

    if (componentGroup) {
      const id = componentGroup.getAttribute('data-component-id')!;

      if (e.metaKey || e.ctrlKey) {
        const c = currentDiagram?.components[id];
        const codeAnchor = c?.anchors?.find(
          (a) => a.type === 'file' || a.type === 'function' || a.type === 'symbol',
        );
        if (codeAnchor) {
          vscode.postMessage({ type: 'open-anchor', value: codeAnchor.value });
        }
        return;
      }

      // Plain click → toggle focus on this component. Re-clicking the
      // currently-focused component clears focus.
      if (focusedComponentId === id) {
        clearFocus();
        focusedComponentId = null;
      } else {
        applyFocus(id);
        focusedComponentId = id;
      }
      return;
    }

    const relGroup = target?.closest('[data-relationship-group]') as SVGGElement | null;
    if (relGroup) {
      const ids = (relGroup.getAttribute('data-relationship-group') ?? '').split(',').filter(Boolean);
      const rels = ids
        .map((id) => ({ id, r: currentDiagram?.relationships[id] }))
        .filter((x): x is { id: string; r: NonNullable<typeof x.r> } => !!x.r);
      if (rels.length > 0) showRelationshipGroupPopover(rels, e.clientX, e.clientY);
      return;
    }

    // Click on empty canvas → clear focus + dismiss popover.
    hidePopover();
    if (focusedComponentId) {
      clearFocus();
      focusedComponentId = null;
    }
  });

  svgEl.addEventListener('mouseenter', handleMouseEnter, true);
  svgEl.addEventListener('mousemove', handleMouseMove, true);
  svgEl.addEventListener('mouseleave', handleMouseLeave, true);
}

function handleMouseEnter(e: Event): void {
  const target = e.target as Element | null;
  const group = target?.closest('[data-component-id]') as SVGGElement | null;
  if (!group) return;
  const id = group.getAttribute('data-component-id')!;
  const c = currentDiagram?.components[id];
  if (!c) return;
  showTooltip(id, c);
}

function handleMouseMove(e: MouseEvent): void {
  if (tooltipEl && tooltipEl.style.display !== 'none') {
    positionTooltip(e.clientX, e.clientY);
  }
}

function handleMouseLeave(): void {
  hideTooltip();
}

// Hover-focus: dim every component and edge that isn't directly connected
// to the hovered one, so the focused node's neighborhood stands out.
// Connected = the hovered component itself + any component reachable in one
// edge hop. Edges that touch the hovered component keep full opacity; the
// rest get the .pv-faded class.
function applyFocus(id: string): void {
  const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
  if (!svgEl) return;

  const connected = new Set<string>([id]);
  if (currentDiagram) {
    for (const r of Object.values(currentDiagram.relationships)) {
      if (r.from === id) connected.add(r.to);
      else if (r.to === id) connected.add(r.from);
    }
  }
  if (__DEBUG__) {
    recorder.emit('webview', 'apply-focus-before', {
      id, connected: [...connected],
    });
  }

  svgEl.querySelectorAll<SVGGElement>('[data-relationship-group]').forEach((g) => {
    const from = g.getAttribute('data-from');
    const to = g.getAttribute('data-to');
    if (from === id || to === id) g.classList.remove('pv-faded');
    else g.classList.add('pv-faded');
  });

  svgEl.querySelectorAll<SVGGElement>('[data-component-id]').forEach((g) => {
    const cid = g.getAttribute('data-component-id');
    if (!cid || connected.has(cid)) g.classList.remove('pv-faded');
    else g.classList.add('pv-faded');
  });

  if (__DEBUG__) {
    const faded: string[] = [];
    const visible: string[] = [];
    svgEl.querySelectorAll<SVGGElement>('[data-component-id]').forEach((g) => {
      const cid = g.getAttribute('data-component-id')!;
      const isFaded = g.classList.contains('pv-faded');
      const opacity = getComputedStyle(g).opacity;
      const classAttr = g.getAttribute('class') ?? '';
      (isFaded ? faded : visible).push(`${cid}(op=${opacity},cls=${classAttr})`);
    });
    const fadedEdges = svgEl.querySelectorAll('[data-relationship-group].pv-faded').length;
    const totalEdges = svgEl.querySelectorAll('[data-relationship-group]').length;
    recorder.emit('webview', 'apply-focus-after', {
      id, visible, faded, fadedEdges, totalEdges,
    });
  }
}

function clearFocus(): void {
  const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
  if (!svgEl) return;
  svgEl.querySelectorAll<SVGGElement>('.pv-faded').forEach((el) => el.classList.remove('pv-faded'));
}

let tooltipEl: HTMLDivElement | undefined;

function ensureTooltip(): HTMLDivElement {
  if (tooltipEl) return tooltipEl;
  const el = document.createElement('div');
  el.id = 'tooltip';
  el.style.cssText = [
    'position:fixed',
    'z-index:12',
    'background:#0f172a',
    'color:#e2e8f0',
    'border:1px solid #334155',
    'border-radius:6px',
    'padding:8px 10px',
    'font-size:12px',
    'font-family:inherit',
    'max-width:380px',
    'pointer-events:none',
    'box-shadow:0 4px 12px rgba(0,0,0,0.5)',
    'display:none',
  ].join(';');
  document.body.appendChild(el);
  tooltipEl = el;
  return el;
}

function showTooltip(id: string, c: CachedDiagram['components'][string]): void {
  const el = ensureTooltip();
  const lines: string[] = [];
  lines.push(`<div style="font-weight:600">${escapeHtml(c.label)}</div>`);
  lines.push(`<div style="color:#94a3b8;font-size:11px;margin-top:2px">${escapeHtml(c.kind)} · ${escapeHtml(id)}</div>`);
  if (c.description) {
    lines.push(`<div style="margin-top:6px">${escapeHtml(c.description)}</div>`);
  }
  if (c.anchors?.length) {
    const items = c.anchors
      .map((a) => `<div style="margin-top:2px"><span style="color:#64748b">${escapeHtml(a.type)}:</span> ${escapeHtml(a.value)}</div>`)
      .join('');
    lines.push(`<div style="margin-top:6px;font-size:11px">${items}</div>`);
  }
  const act = currentActivity[id];
  if (act?.last_read) {
    const readSession = act.last_read_session ? ` (${act.last_read_session.slice(0, 8)})` : '';
    lines.push(`<div style="margin-top:6px;font-size:11px;color:#94a3b8">Last read ${escapeHtml(timeAgo(act.last_read))}${escapeHtml(readSession)}</div>`);
    if (act.last_edit) {
      const editSession = act.last_edit_session ? ` (${act.last_edit_session.slice(0, 8)})` : '';
      lines.push(`<div style="font-size:11px;color:#94a3b8">Last edited ${escapeHtml(timeAgo(act.last_edit))}${escapeHtml(editSession)}</div>`);
    }
    let statusText: string;
    let statusColor: string;
    if (act.last_model_update) {
      const updatedAgo = escapeHtml(timeAgo(act.last_model_update));
      const verified = act.last_model_update_verified !== false;
      const olderThanEdit = act.last_edit && act.last_edit > act.last_model_update;
      if (!verified) {
        statusText = `Diagram updated ${updatedAgo} (unverified)`;
        statusColor = '#ef4444';
      } else if (olderThanEdit) {
        statusText = `Diagram updated ${updatedAgo} — older than last file edit`;
        statusColor = '#ef4444';
      } else {
        statusText = `Diagram updated ${updatedAgo} (verified)`;
        statusColor = '#22c55e';
      }
    } else if (act.last_edit && act.last_edit > act.last_read) {
      statusText = 'Diagram never updated for this component';
      statusColor = '#ef4444';
    } else {
      statusText = 'No edits since read';
      statusColor = '#22c55e';
    }
    lines.push(`<div style="font-size:11px;color:${statusColor}">${statusText}</div>`);
  }
  const known = new Set(['kind', 'label', 'description', 'parent', 'anchors']);
  const extras = Object.entries(c)
    .filter(([k]) => !known.has(k))
    .filter(([, v]) => v !== undefined && v !== null);
  if (extras.length) {
    lines.push(renderMetadataTable(Object.fromEntries(extras)));
  }
  el.innerHTML = lines.join('');
  el.style.display = 'block';
}

function hideTooltip(): void {
  if (tooltipEl) tooltipEl.style.display = 'none';
}

function positionTooltip(x: number, y: number): void {
  if (!tooltipEl) return;
  const padding = 12;
  const tw = tooltipEl.offsetWidth;
  const th = tooltipEl.offsetHeight;
  const w = window.innerWidth;
  const h = window.innerHeight;
  let left = x + padding;
  if (left + tw > w - padding) left = x - padding - tw;
  let top = y + padding;
  if (top + th > h - padding) top = y - padding - th;
  tooltipEl.style.left = left + 'px';
  tooltipEl.style.top = top + 'px';
}

let popoverEl: HTMLDivElement | undefined;

function ensurePopover(): HTMLDivElement {
  if (popoverEl) return popoverEl;
  const el = document.createElement('div');
  el.id = 'popover';
  el.style.cssText = [
    'position:fixed',
    'z-index:12',
    'background:#0f172a',
    'color:#e2e8f0',
    'border:1px solid #334155',
    'border-radius:6px',
    'padding:8px 10px',
    'font-size:12px',
    'font-family:inherit',
    'max-width:460px',
    'max-height:70vh',
    'overflow-y:auto',
    'box-shadow:0 4px 12px rgba(0,0,0,0.5)',
    'display:none',
  ].join(';');
  document.body.appendChild(el);
  popoverEl = el;
  el.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hidePopover();
  });
  return el;
}

// Renders one or more relationships into the click-popover. Single-edge
// groups produce a one-row popover (matches the previous click-on-edge
// behavior); multi-edge groups produce a list, one row per relationship,
// each with its kind in its rule color, the direction, and any metadata.
function showRelationshipGroupPopover(
  rels: Array<{ id: string; r: CachedDiagram['relationships'][string] }>,
  x: number,
  y: number,
): void {
  const el = ensurePopover();
  const sections: string[] = [];

  if (rels.length > 1) {
    sections.push(`<div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--vscode-descriptionForeground);margin-bottom:6px">${rels.length} relationships</div>`);
  }

  for (let i = 0; i < rels.length; i++) {
    const { r } = rels[i];
    const lines: string[] = [];
    lines.push(`<div style="font-weight:600">${escapeHtml(r.kind)}</div>`);
    lines.push(
      `<div style="color:var(--vscode-descriptionForeground);font-size:11px;margin-top:2px">${escapeHtml(r.from)} → ${escapeHtml(r.to)}</div>`,
    );
    if (r.metadata && Object.keys(r.metadata).length > 0) {
      lines.push(renderMetadataTable(r.metadata));
    }
    sections.push(lines.join(''));
    if (i < rels.length - 1) {
      sections.push(`<div style="border-top:1px solid var(--vscode-widget-border, var(--vscode-panel-border));margin:8px 0"></div>`);
    }
  }

  el.innerHTML = sections.join('');
  el.style.display = 'block';
  const padding = 12;
  el.style.left = '0px';
  el.style.top = '0px';
  const pw = el.offsetWidth;
  const ph = el.offsetHeight;
  const w = window.innerWidth;
  const h = window.innerHeight;
  let left = x + padding;
  if (left + pw > w - padding) left = x - padding - pw;
  let top = y + padding;
  if (top + ph > h - padding) top = y - padding - ph;
  el.style.left = left + 'px';
  el.style.top = top + 'px';
}

function hidePopover(): void {
  if (popoverEl) popoverEl.style.display = 'none';
}

// One edge that's connected to the currently-dragging component. Cached
// on drag-start so per-frame updates don't have to re-walk the SVG. The
// `otherBox` is fixed for the duration of the drag (only one component
// moves at a time), and `endIsFrom` records which end of the path the
// dragging box owns so we can pass the right pair of rects into
// computeEdgeEndpoints.
interface ConnectedEdge {
  endIsFrom: boolean;
  otherBox: BoxRect;
  path: SVGPathElement;
  label: SVGTextElement | null; // single-edge groups
  badgeBg: SVGCircleElement | null; // multi-edge groups
  badgeText: SVGTextElement | null;
}

function relocateGroup(group: Element, x: number, y: number, w: number, h: number): void {
  const isContainer = group.getAttribute('data-container') === '1';

  const rect = group.querySelector('rect');
  if (rect) {
    rect.setAttribute('x', String(x));
    rect.setAttribute('y', String(y));
  }

  const ellipses = group.querySelectorAll('ellipse');
  if (ellipses.length === 2) {
    const rx = Number(ellipses[0].getAttribute('rx') ?? w / 2);
    const ry = Number(ellipses[0].getAttribute('ry') ?? 8);
    ellipses[0].setAttribute('cx', String(x + rx));
    ellipses[0].setAttribute('cy', String(y + ry));
    ellipses[1].setAttribute('cx', String(x + rx));
    ellipses[1].setAttribute('cy', String(y + h - ry));
  } else if (ellipses.length === 1) {
    const rx = Number(ellipses[0].getAttribute('rx') ?? 0);
    ellipses[0].setAttribute('cx', String(x + rx));
    ellipses[0].setAttribute('cy', String(y + 8));
  }

  const path = group.querySelector('path');
  if (path && ellipses.length === 2) {
    const rx = Number(ellipses[0].getAttribute('rx') ?? w / 2);
    const ry = Number(ellipses[0].getAttribute('ry') ?? 8);
    path.setAttribute('d',
      `M${x},${y + ry} L${x},${y + h - ry} A${rx},${ry} 0 0 0 ${x + w},${y + h - ry} L${x + w},${y + ry}`);
  } else if (path && ellipses.length === 0) {
    const cx = x + w / 2;
    const cy = y + h / 2;
    path.setAttribute('d', `M${cx},${y} L${x + w},${cy} L${cx},${y + h} L${x},${cy} Z`);
  }

  const text = group.querySelector('text');
  if (text) {
    text.setAttribute('x', String(isContainer ? x + 12 : x + w / 2));
    text.setAttribute('y', String(isContainer ? y - 6 : y + h / 2));
  }

  // Staleness dot — same offset constants as the renderer at
  // src/diagram/render.ts:drawBox. Without this, drag leaves the dot
  // behind at its original (cx, cy). See chaos test C15.
  const dot = group.querySelector('.pv-staleness-dot') as SVGCircleElement | null;
  if (dot) {
    dot.setAttribute('cx', String(x + w - 10));
    dot.setAttribute('cy', String(y + 10));
  }
}

function readBox(group: Element): BoxRect | undefined {
  const rect = group.querySelector('rect');
  if (rect) {
    return {
      x: Number(rect.getAttribute('x') ?? 0),
      y: Number(rect.getAttribute('y') ?? 0),
      w: Number(rect.getAttribute('width') ?? 0),
      h: Number(rect.getAttribute('height') ?? 0),
    };
  }
  const ellipses = group.querySelectorAll('ellipse');
  if (ellipses.length === 2) {
    const rx = Number(ellipses[0].getAttribute('rx') ?? 0);
    const ry = Number(ellipses[0].getAttribute('ry') ?? 8);
    const topCy = Number(ellipses[0].getAttribute('cy') ?? 0);
    const botCy = Number(ellipses[1].getAttribute('cy') ?? 0);
    const cx = Number(ellipses[0].getAttribute('cx') ?? 0);
    return { x: cx - rx, y: topCy - ry, w: rx * 2, h: botCy - topCy + 2 * ry };
  }
  if (ellipses.length === 1) {
    const cx = Number(ellipses[0].getAttribute('cx') ?? 0);
    const cy = Number(ellipses[0].getAttribute('cy') ?? 0);
    const rx = Number(ellipses[0].getAttribute('rx') ?? 0);
    return { x: cx - rx, y: cy - 8, w: rx * 2, h: 80 };
  }
  // Path-only shapes (diamond and any future polygonal kind). getBBox()
  // returns the SVG-local bounding rect — same coordinate system as the
  // rect/ellipse branches above, so connected-edge geometry stays consistent.
  const path = group.querySelector('path');
  if (path && typeof (path as SVGGraphicsElement).getBBox === 'function') {
    const bb = (path as SVGGraphicsElement).getBBox();
    return { x: bb.x, y: bb.y, w: bb.width, h: bb.height };
  }
  return undefined;
}

// Walks the SVG once at drag-start, picks out every edge group whose
// `data-from` or `data-to` matches the dragging id, and snapshots the
// other end's box. Edges are repositioned per-frame via updateConnectedEdge.
function findConnectedEdges(svgEl: SVGSVGElement, id: string): ConnectedEdge[] {
  const result: ConnectedEdge[] = [];
  select(svgEl).selectAll<SVGGElement, unknown>('[data-relationship-group]').each(function() {
    const g = this;
    const from = g.getAttribute('data-from');
    const to = g.getAttribute('data-to');
    if (from !== id && to !== id) return;
    const otherId = from === id ? to : from;
    if (!otherId) return;
    const otherGroup = svgEl.querySelector(`[data-component-id="${otherId}"]`);
    if (!otherGroup) return;
    const otherBox = readBox(otherGroup);
    if (!otherBox) return;
    const s = select(g);
    const path = s.select<SVGPathElement>('path.pv-edge-line').node();
    if (!path) return;
    result.push({
      endIsFrom: from === id,
      otherBox,
      path,
      label: s.select<SVGTextElement>('text.pv-edge-label').node(),
      badgeBg: s.select<SVGCircleElement>('circle.pv-edge-badge-bg').node(),
      badgeText: s.select<SVGTextElement>('text.pv-edge-badge-text').node(),
    });
  });
  return result;
}

function updateConnectedEdge(edge: ConnectedEdge, draggingBox: BoxRect): void {
  const { x1, y1, x2, y2 } = edge.endIsFrom
    ? computeEdgeEndpoints(draggingBox, edge.otherBox)
    : computeEdgeEndpoints(edge.otherBox, draggingBox);
  edge.path.setAttribute('d', `M${x1},${y1} L${x2},${y2}`);
  if (edge.label) {
    const { x, y } = perpendicularLabelPos(x1, y1, x2, y2);
    edge.label.setAttribute('x', String(x));
    edge.label.setAttribute('y', String(y));
  }
  if (edge.badgeBg && edge.badgeText) {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    edge.badgeBg.setAttribute('cx', String(cx));
    edge.badgeBg.setAttribute('cy', String(cy));
    edge.badgeText.setAttribute('x', String(cx));
    edge.badgeText.setAttribute('y', String(cy));
  }
}

function wireDrag(svgEl: SVGSVGElement): void {
  interface ChildSnapshot { group: SVGGElement; box: BoxRect; edges: ConnectedEdge[] }
  interface DragSubject { x: number; y: number; w: number; h: number; id: string; edges: ConnectedEdge[]; traceId: string; children: ChildSnapshot[] }

  const behavior = d3Drag<SVGGElement, unknown>()
    .filter(function(event) {
      if (mode !== 'edit') return false;
      if (event.button !== 0) return false;
      return true;
    })
    .subject(function(): DragSubject | null {
      const box = readBox(this);
      if (!box) return null;
      const id = this.getAttribute('data-component-id')!;
      // Issue #3: collect ALL descendants, not just direct children, so that
      // dragging a container moves deeply-nested grandchildren live too.
      const children: ChildSnapshot[] = [];
      if (currentDiagram) {
        const descendants = collectDescendants(currentDiagram.components, id);
        for (const cid of descendants) {
          const g = svgEl.querySelector(`[data-component-id="${cid}"]`) as SVGGElement | null;
          if (!g) continue;
          const cb = readBox(g);
          if (cb) children.push({ group: g, box: cb, edges: findConnectedEdges(svgEl, cid) });
        }
      }
      return { ...box, id, edges: findConnectedEdges(svgEl, id), traceId: newTraceId(), children };
    })
    .on('start', function(event) {
      const s = event.subject as DragSubject;
      this.style.cursor = 'grabbing';
      event.sourceEvent.stopPropagation();
      if (__DEBUG__) {
        recorder.emit('webview', 'drag-start', {
          id: s.id, initBox: { x: s.x, y: s.y, w: s.w, h: s.h }, zoom: currentTransform.k,
        }, s.traceId);
      }
    })
    .on('drag', function(event) {
      const s = event.subject as DragSubject;
      const dx = event.x - s.x;
      const dy = event.y - s.y;
      const t = `translate(${dx},${dy})`;
      select(this).attr('transform', t);
      if (s.edges.length) {
        const draggingBox: BoxRect = { x: event.x, y: event.y, w: s.w, h: s.h };
        for (const edge of s.edges) updateConnectedEdge(edge, draggingBox);
      }
      for (const child of s.children) {
        child.group.setAttribute('transform', t);
        if (child.edges.length) {
          const childBox: BoxRect = { x: child.box.x + dx, y: child.box.y + dy, w: child.box.w, h: child.box.h };
          for (const edge of child.edges) updateConnectedEdge(edge, childBox);
        }
      }
    })
    .on('end', function(event) {
      const s = event.subject as DragSubject;
      this.style.cursor = '';
      const dx = event.x - s.x;
      const dy = event.y - s.y;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
        select(this).attr('transform', null);
        for (const child of s.children) child.group.removeAttribute('transform');
        if (__DEBUG__) recorder.emit('webview', 'drag-cancel', { id: s.id, dx, dy }, s.traceId);
        return;
      }
      const x = event.x;
      const y = event.y;
      select(this).attr('transform', null);
      relocateGroup(this, x, y, s.w, s.h);
      for (const child of s.children) {
        child.group.removeAttribute('transform');
        relocateGroup(child.group, child.box.x + dx, child.box.y + dy, child.box.w, child.box.h);
      }
      // Issue #2 fix: if this is a nested component, compute its position
      // relative to its parent's CURRENT rendered box and post that
      // directly. Previously the host tried to convert absolute→relative
      // by reading the parent's saved layout entry, but if the parent
      // wasn't pinned yet, the conversion was skipped and the child's
      // absolute coords were stored as if they were parent-relative.
      let pinX = x;
      let pinY = y;
      let parentRelative = false;
      const parentId = currentDiagram?.components[s.id]?.parent;
      if (parentId) {
        const parentG = svgEl.querySelector(`[data-component-id="${parentId}"]`) as SVGGElement | null;
        const parentBox = parentG ? readBox(parentG) : null;
        if (parentBox) {
          pinX = x - parentBox.x;
          pinY = y - parentBox.y;
          parentRelative = true;
        }
      }
      if (__DEBUG__) {
        recorder.emit('webview', 'drag-end', {
          id: s.id, dx, dy, posted: { x: pinX, y: pinY, w: s.w, h: s.h }, parentRelative, zoom: currentTransform.k,
        }, s.traceId);
      }
      vscode.postMessage({ type: 'pin', id: s.id, x: pinX, y: pinY, w: s.w, h: s.h, parentRelative, traceId: s.traceId });
    });

  select(svgEl).selectAll<SVGGElement, unknown>('[data-component-id]').call(behavior);
}

function newTraceId(): string {
  // Webviews run in a modern Chromium with crypto.randomUUID. Falls back
  // to a coarse timestamp+random if anything else hosts this code.
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

window.addEventListener('message', (e) => {
  const msg = e.data;
  if (!msg || typeof msg !== 'object') return;
  // Every host → webview message carries the model-picker state, so
  // refreshing it here keeps it in sync regardless of which branch runs.
  updateModelPicker(msg.activeModel, msg.availableModels);
  switch (msg.type) {
    case 'svg':
      currentDiagram = (msg.diagram as CachedDiagram) ?? null;
      currentActivity = (msg.activity as typeof currentActivity) ?? {};
      showSvg(msg.svg, msg.traceId);
      showDiagnostics(msg.diagnostics ?? []);
      showLegend(currentDiagram?.rules);
      break;
    case 'empty':
    case 'error':
      showEmpty(msg.message);
      break;
    case 'session_connected':
      break;
  }
});

// No resize handler: the SVG has width/height = 100% so it resizes with its
// container automatically, and d3-zoom preserves the user's transform across
// DOM resizes. A previous version of this code force-refit on every resize,
// which clobbered the user's zoom whenever VS Code resized the panel
// (audit panel opening, editor split, etc) — that was issue #6.

vscode.postMessage({ type: 'ready' });
