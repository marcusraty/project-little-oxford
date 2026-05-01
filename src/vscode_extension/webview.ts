import svgPanZoom from 'svg-pan-zoom';
import { recorder, installRecorder, bridgeSink } from '../diagnostics';
import { Disposables } from './disposables';
import {
  computeEdgeEndpoints,
  perpendicularLabelPos,
  type BoxRect,
} from '../diagram/geometry';

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

settingsButton.addEventListener('click', () => {
  vscode.postMessage({ type: 'open-settings' });
});
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
      "position you've dragged. The components and relationships in " +
      "model.json aren't touched — only the saved positions.",
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

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
  return `<svg width="20" height="14" viewBox="0 0 20 14"><rect x="1" y="1" width="18" height="12" rx="2" fill="${fill}" stroke="${stroke}" stroke-width="1.2"${dash}/></svg>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
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

diagSummary.addEventListener('click', () => {
  diagList.classList.toggle('hidden');
});

let panZoom: SvgPanZoom.Instance | undefined;
let mode: 'pan' | 'edit' = 'pan';

function setMode(next: 'pan' | 'edit'): void {
  mode = next;
  // The active-state styling is driven entirely by `body[data-mode]` and
  // CSS — no per-button class flipping here. Single source of truth.
  document.body.dataset.mode = mode;
  if (!panZoom) return;
  if (mode === 'pan') {
    panZoom.enablePan();
    panZoom.enableZoom();
    panZoom.enableDblClickZoom();
  } else {
    panZoom.disablePan();
    panZoom.disableDblClickZoom();
  }
}

modePanBtn.addEventListener('click', () => setMode('pan'));
modeEditBtn.addEventListener('click', () => setMode('edit'));

// Zoom slider <-> svg-pan-zoom binding.
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
  if (!panZoom) return;
  const zoom = Math.pow(10, Number(zoomSlider.value));
  panZoom.zoom(zoom);
  // svg-pan-zoom's onZoom callback updates the label; setting it here
  // too keeps the readout snappy during a continuous drag.
  zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
});

zoomInBtn.addEventListener('click', () => panZoom?.zoomBy(1.2));
zoomOutBtn.addEventListener('click', () => panZoom?.zoomBy(1 / 1.2));
zoomFitBtn.addEventListener('click', () => {
  if (!panZoom) return;
  // resize() picks up any container size change since init; reset()
  // restores the original fitted+centered view (zoom AND pan). Calling
  // fit() alone leaves the user's pan offset in place, which makes the
  // button feel broken — diagram is "fitted" by zoom but still shoved
  // into a corner.
  panZoom.resize();
  panZoom.reset();
});

function showEmpty(message: string): void {
  panZoom?.destroy();
  panZoom = undefined;
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

function showSvg(svg: string, traceId?: string): void {
  panZoom?.destroy();
  panZoom = undefined;
  stage.innerHTML = svg;
  empty.classList.add('hidden');
  modeToggle.classList.remove('hidden');
  zoomCtrl.classList.remove('hidden');
  resetButton.classList.remove('hidden');
  settingsButton.classList.remove('hidden');

  const svgEl = stage.querySelector('svg') as SVGSVGElement | null;
  if (!svgEl) return;
  svgEl.removeAttribute('width');
  svgEl.removeAttribute('height');
  svgEl.setAttribute('width', '100%');
  svgEl.setAttribute('height', '100%');
  panZoom = svgPanZoom(svgEl, {
    zoomEnabled: true,
    panEnabled: true,
    controlIconsEnabled: false,
    fit: true,
    center: true,
    minZoom: ZOOM_MIN,
    maxZoom: ZOOM_MAX,
    onZoom: syncZoomUI,
  });
  // Initial sync: svg-pan-zoom's `fit` adjusts zoom on creation but
  // doesn't fire onZoom for the initial fit, so we read it back manually.
  syncZoomUI(panZoom.getZoom());
  setMode(mode);
  wireDrag(svgEl);
  wireInteractions(svgEl);
  if (__DEBUG__) emitSvgApplied(svgEl, traceId);
}

// Reads back every component's rect coords as they actually exist in the
// DOM after the SVG is in the page. This is the "what does the user see"
// measurement — the final coord in the pipeline. If this disagrees with
// the host's rerender-end output layout, the bug is between SVG-build and
// DOM-paint (CSS, panZoom transforms, etc.). If it agrees, the bug is
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
    if (mode === 'edit') return;
    const target = e.target as Element | null;

    const componentGroup = target?.closest('[data-component-id]') as SVGGElement | null;
    if (componentGroup) {
      const id = componentGroup.getAttribute('data-component-id')!;
      const c = currentDiagram?.components[id];
      const codeAnchor = c?.anchors?.find((a) => a.type === 'file' || a.type === 'function' || a.type === 'symbol');
      if (codeAnchor) {
        vscode.postMessage({ type: 'open-anchor', value: codeAnchor.value });
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

    hidePopover();
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
  const known = new Set(['kind', 'label', 'description', 'parent', 'anchors']);
  const extras = Object.entries(c)
    .filter(([k]) => !known.has(k))
    .filter(([, v]) => v !== undefined && v !== null);
  if (extras.length) {
    const items = extras
      .map(([k, v]) => `<div style="margin-top:2px"><span style="color:#64748b">${escapeHtml(k)}:</span> ${escapeHtml(JSON.stringify(v))}</div>`)
      .join('');
    lines.push(`<div style="margin-top:6px;font-size:11px;color:#cbd5e1">${items}</div>`);
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
    'max-width:380px',
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
      const items = Object.entries(r.metadata)
        .map(
          ([k, v]) =>
            `<div style="margin-top:2px"><span style="color:var(--vscode-descriptionForeground)">${escapeHtml(k)}:</span> ${escapeHtml(JSON.stringify(v))}</div>`,
        )
        .join('');
      lines.push(`<div style="margin-top:6px;font-size:11px">${items}</div>`);
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

// Disposables for the listeners attached on each `wireDrag` call. The
// drag handlers live on `window` (not on the svg element) so the cursor
// keeps tracking when it leaves the canvas; without explicit removal,
// every rerender stacks a fresh pair on top of the previous ones and
// they leak for the lifetime of the panel.
let dragDisposables: Disposables | undefined;

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
  const ellipse = group.querySelector('ellipse');
  if (ellipse) {
    const cx = Number(ellipse.getAttribute('cx') ?? 0);
    const cy = Number(ellipse.getAttribute('cy') ?? 0);
    const rx = Number(ellipse.getAttribute('rx') ?? 0);
    const path = group.querySelector('path');
    const pd = path?.getAttribute('d') ?? '';
    const m = /L\d+,(\d+)/.exec(pd);
    const h = m ? Number(m[1]) - cy + 8 : 80;
    return { x: cx - rx, y: cy - 8, w: rx * 2, h };
  }
  return undefined;
}

// Walks the SVG once at drag-start, picks out every edge group whose
// `data-from` or `data-to` matches the dragging id, and snapshots the
// other end's box. Edges are repositioned per-frame via updateConnectedEdge.
function findConnectedEdges(svgEl: SVGSVGElement, id: string): ConnectedEdge[] {
  const result: ConnectedEdge[] = [];
  const groups = svgEl.querySelectorAll('[data-relationship-group]');
  groups.forEach((g) => {
    const from = g.getAttribute('data-from');
    const to = g.getAttribute('data-to');
    if (from !== id && to !== id) return;
    const otherId = from === id ? to : from;
    if (!otherId) return;
    const otherGroup = svgEl.querySelector(`[data-component-id="${otherId}"]`);
    if (!otherGroup) return;
    const otherBox = readBox(otherGroup);
    if (!otherBox) return;
    const path = g.querySelector('path.pv-edge-line') as SVGPathElement | null;
    if (!path) return;
    result.push({
      endIsFrom: from === id,
      otherBox,
      path,
      label: g.querySelector('text.pv-edge-label'),
      badgeBg: g.querySelector('circle.pv-edge-badge-bg'),
      badgeText: g.querySelector('text.pv-edge-badge-text'),
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
  dragDisposables?.dispose();
  const d = new Disposables();
  dragDisposables = d;

  let dragging:
    | {
        id: string;
        group: SVGGElement;
        startX: number;
        startY: number;
        initX: number;
        initY: number;
        w: number;
        h: number;
        dx: number;
        dy: number;
        traceId: string;
        edges: ConnectedEdge[];
      }
    | undefined;

  d.on(svgEl, 'mousedown', (ev) => {
    const e = ev as MouseEvent;
    if (mode !== 'edit') return;
    const target = e.target as Element | null;
    const group = target?.closest('[data-component-id]') as SVGGElement | null;
    if (!group) return;
    const id = group.getAttribute('data-component-id')!;
    const box = readBox(group);
    if (!box) return;
    e.preventDefault();
    e.stopPropagation();
    const traceId = newTraceId();
    dragging = {
      id,
      group,
      startX: e.clientX,
      startY: e.clientY,
      initX: box.x,
      initY: box.y,
      w: box.w,
      h: box.h,
      dx: 0,
      dy: 0,
      traceId,
      // Snapshot every edge connected to this box once at drag-start —
      // they're updated in place per mousemove. Cheap: an architecture
      // diagram has dozens of edges total, the connected subset is tiny.
      edges: findConnectedEdges(svgEl, id),
    };
    group.style.cursor = 'grabbing';
    if (__DEBUG__) {
      recorder.emit(
        'webview',
        'drag-start',
        {
          id,
          clientX: e.clientX,
          clientY: e.clientY,
          initBox: { ...box },
          zoom: panZoom?.getZoom() ?? 1,
        },
        traceId,
      );
    }
  });

  d.on(window, 'mousemove', (ev) => {
    const e = ev as MouseEvent;
    if (!dragging) return;
    const zoom = panZoom?.getZoom() ?? 1;
    dragging.dx = (e.clientX - dragging.startX) / zoom;
    dragging.dy = (e.clientY - dragging.startY) / zoom;
    dragging.group.setAttribute('transform', `translate(${dragging.dx} ${dragging.dy})`);
    // Recompute every connected edge's geometry so they stay attached to
    // the moving box. Same math the renderer uses, so the in-flight
    // shape matches what the next full render produces — no visible
    // snap when the drag finishes.
    if (dragging.edges.length) {
      const draggingBox: BoxRect = {
        x: dragging.initX + dragging.dx,
        y: dragging.initY + dragging.dy,
        w: dragging.w,
        h: dragging.h,
      };
      for (const edge of dragging.edges) updateConnectedEdge(edge, draggingBox);
    }
  });

  d.on(window, 'mouseup', () => {
    if (!dragging) return;
    const { id, dx, dy, group, initX, initY, w, h, traceId } = dragging;
    group.style.cursor = '';
    dragging = undefined;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) {
      group.removeAttribute('transform');
      if (__DEBUG__) recorder.emit('webview', 'drag-cancel', { id, dx, dy }, traceId);
      return;
    }
    const x = initX + dx;
    const y = initY + dy;
    if (__DEBUG__) {
      recorder.emit(
        'webview',
        'drag-end',
        { id, dx, dy, posted: { x, y, w, h }, zoom: panZoom?.getZoom() ?? 1 },
        traceId,
      );
    }
    vscode.postMessage({ type: 'pin', id, x, y, w, h, traceId });
  });
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
  switch (msg.type) {
    case 'svg':
      currentDiagram = (msg.diagram as CachedDiagram) ?? null;
      showSvg(msg.svg, msg.traceId);
      showDiagnostics(msg.diagnostics ?? []);
      showLegend(currentDiagram?.rules);
      break;
    case 'empty':
    case 'error':
      showEmpty(msg.message);
      break;
  }
});

window.addEventListener('resize', () => {
  panZoom?.resize();
  panZoom?.fit();
  panZoom?.center();
});

vscode.postMessage({ type: 'ready' });
