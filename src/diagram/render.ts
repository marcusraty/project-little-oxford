// little-oxford — diagram renderer (Diagram → SVG string).
//
// Pipeline, end to end:
//   1. collectDiagnostics(): walks the diagram and produces warnings/errors
//      (cycles in parent chains, missing styles, orphan entries, etc.).
//   2. computeLayout(): hands the diagram off to ELK, an external layout
//      engine that decides where every box and arrow goes.
//   3. emitSvg(): serializes the laid-out boxes/arrows into an SVG string
//      by concatenating tag literals.
//
// The output is plain text: an SVG document the webview drops into the DOM.
// Nothing here touches the filesystem or VS Code APIs — this module is
// pure (Diagram in, {svg, layout, diagnostics} out).
//
// What's ELK? Eclipse Layout Kernel — a graph layout library originally
// written in Java for the Eclipse IDE. `elkjs` is a JS port of it. We give
// it nodes + edges, it returns x/y coordinates that minimize edge crossings
// and keep the graph readable. We use the "layered" algorithm (top-to-
// bottom flow, like a flowchart).

// @ts-ignore — elkjs bundled entry has no subpath type export
import ELKModule from 'elkjs/lib/elk.bundled.js';
import type { Diagram, Layout, Rules, ComponentStyle, RelationshipStyle, ActivityEntry } from './types';
import { computeStaleness } from './activity';
import { computeEdgeEndpoints, perpendicularLabelPos } from './geometry';
import {
  applyLayoutSpec,
  resolveLayoutSpec,
  UnknownPresetError,
  type LayoutSpec,
  type ElkGraphRoot,
} from './layout';

// elkjs's bundled entry exposes the constructor under `.default`. The
// awkward double-cast through `unknown` is how TypeScript lets you assert
// a type when the real shape doesn't match the imported one — we know the
// runtime shape, the bundled .js file just doesn't ship matching .d.ts.
const ELK = (ELKModule as unknown as { default: new () => { layout: (g: unknown) => Promise<unknown> } }).default;
const elk = new ELK();

// RD2: elkjs is single-threaded WASM under the hood; we serialize calls to
// avoid any chance of interleaved state in long-running engine instances.
// A model watcher fire + an audit-pipeline-triggered render can both call
// computeLayout in the same tick; without this queue they'd race.
let elkQueue: Promise<unknown> = Promise.resolve();

// Visual constants. Box dimensions are fixed for v0.1 — every leaf node is
// the same size — so ELK sees a uniform grid and produces tidy layouts.
// PAD is the canvas padding on all sides plus the spacing between
// containers.
const BOX_W = 220;
const BOX_H = 80;
const PAD = 40;
const FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// Fallback styles applied when a component or relationship references a
// kind that has no entry in the diagram's `rules`. We also emit a
// diagnostic in that case so the user knows their styles are incomplete.
//
// Note: default *colors* are no longer carried here — when no rule fill
// or stroke is given, the renderer emits `class="pv-default-…"` and the
// webview's CSS resolves those against `var(--vscode-…)` so the diagram
// matches the active editor theme. Hard-coding hex defaults would mean
// a single chrome accent regardless of light/dark theme.
const DEFAULT_COMPONENT: ComponentStyle = { symbol: 'rectangle' };
const DEFAULT_RELATIONSHIP: RelationshipStyle = {};

// Diagnostics are non-fatal hints/errors surfaced to the user. `error`
// prevents the diagram from rendering (the webview shows the message
// instead); `warning` renders the diagram and shows the warnings in a
// collapsible bottom-left tray.
export type DiagnosticLevel = 'error' | 'warning';

export interface Diagnostic {
  level: DiagnosticLevel;
  rule: string;       // stable id, e.g., "parent-cycle" — useful for filtering
  message: string;    // human-readable
  path?: string;      // dotted JSON path into the diagram, for navigation
}

export interface RenderOutput {
  svg: string;
  layout: Layout;
  diagnostics: Diagnostic[];
}

// Top-level entry point. Pure function: same diagram in → same output out
// (modulo ELK, which is itself deterministic given the same input).
export async function renderDiagram(
  model: Diagram,
  spec?: LayoutSpec,
  activity?: Record<string, ActivityEntry>,
): Promise<RenderOutput> {
  const diagnostics: Diagnostic[] = [];
  collectDiagnostics(model, diagnostics);
  // Validate the spec up front so an unknown preset name surfaces as
  // a render error rather than blowing up mid-layout.
  let resolved: LayoutSpec;
  try {
    resolved = resolveLayoutSpec(spec);
  } catch (e) {
    if (e instanceof UnknownPresetError) {
      diagnostics.push({
        level: 'error',
        rule: 'unknown-layout-preset',
        message: e.message,
      });
      return {
        svg: '',
        layout: { canvasWidth: 0, canvasHeight: 0, components: {} },
        diagnostics,
      };
    }
    throw e;
  }
  const computed = await computeLayout(model, resolved);
  applyPinnedOverrides(model, computed);
  const svg = emitSvg(model, computed, activity);
  // The returned layout uses PARENT-RELATIVE coords (matching ELK's native
  // convention). When a caller writes this back to model.json, the next
  // render feeds these coords back as interactive-mode pins.
  const layout: Layout = {
    canvasWidth: computed.canvasWidth,
    canvasHeight: computed.canvasHeight,
    components: computed.relative,
  };
  return { svg, layout, diagnostics };
}

// Walks the diagram looking for problems. Pushes onto `out` rather than
// returning a list because callers append from multiple checks; passing
// the accumulator in lets each check be a self-contained block.
function collectDiagnostics(model: Diagram, out: Diagnostic[]): void {
  const componentIds = new Set(Object.keys(model.components));
  const usedComponentKinds = new Set<string>();

  // Cycles in parent chain. A → B → A would render as infinite nesting,
  // so we walk each component's parent pointer until we hit null or revisit
  // a node. The `seen` set is per-start-id, not global, because two
  // separate chains can legitimately share an ancestor.
  for (const id of componentIds) {
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur) {
      if (seen.has(cur)) {
        out.push({
          level: 'error',
          rule: 'parent-cycle',
          message: `Cycle in parent chain reaches "${id}".`,
          path: `components.${id}.parent`,
        });
        break;
      }
      seen.add(cur);
      const next: string | null | undefined = model.components[cur]?.parent ?? null;
      cur = next;
    }
  }

  for (const c of Object.values(model.components)) {
    usedComponentKinds.add(c.kind);
  }

  // Self-loops only. Multiple relationships between the same pair are
  // legitimate (e.g., reads + writes between extension and model.json,
  // or hosts + ipc between extension host and webview) — don't warn.
  for (const [id, r] of Object.entries(model.relationships)) {
    if (r.from === r.to) {
      out.push({
        level: 'warning',
        rule: 'self-loop',
        message: `Relationship "${id}" connects "${r.from}" to itself.`,
        path: `relationships.${id}`,
      });
    }
  }

  // Missing styles for COMPONENT kinds in use. Relationships intentionally
  // don't need styles per kind — every edge renders the same way — so we
  // don't lint missing relationship_styles entries.
  const compStyles = model.rules?.component_styles ?? {};
  for (const kind of usedComponentKinds) {
    if (!(kind in compStyles)) {
      out.push({
        level: 'warning',
        rule: 'missing-component-style',
        message: `No style defined for component kind "${kind}". Using default.`,
        path: `rules.component_styles.${kind}`,
      });
    }
  }

  // Orphan layout / overrides entries (component no longer exists).
  for (const id of Object.keys(model.layout?.components ?? {})) {
    if (!componentIds.has(id)) {
      out.push({
        level: 'warning',
        rule: 'orphan-layout',
        message: `Layout entry for "${id}" has no matching component.`,
        path: `layout.components.${id}`,
      });
    }
  }
  for (const id of Object.keys(model.overrides ?? {})) {
    if (!componentIds.has(id)) {
      out.push({
        level: 'warning',
        rule: 'orphan-override',
        message: `Override entry for "${id}" has no matching component.`,
        path: `overrides.${id}`,
      });
    }
  }
}

// ── Layout ────────────────────────────────────────────────────────────────────

// The renderer returns TWO layouts:
//   - `absolute` — used internally for SVG drawing (everything in canvas coords)
//   - `relative` — what we put back into the returned Layout block, so storage
//                  matches ELK's native convention (parent-relative). This is
//                  what gets fed BACK into ELK as interactive-mode pins on the
//                  next render. Symmetry on input/output is the contract.
//
// For v0.1 every component has parent: null, so absolute === relative. The
// distinction matters when we add nested containers in later stages.
type LayoutEntry = { x: number; y: number; w: number; h: number };
type WalkOutput = {
  absolute: Record<string, LayoutEntry>;
  relative: Record<string, LayoutEntry>;
};

// Layout pipeline broken into three steps so replay/tests can observe each
// stage. `computeLayout` composes them; nothing else changes.
//
//   buildElkGraph  — model + saved pins → ELK input graph (pure)
//   runElk         — graph → ELK output tree (the only step that calls elkjs)
//   readElkResult  — output tree → flat absolute + relative coord maps + canvas size

// Builds the ELK input graph from a Diagram.
//
// "Container" = any component another component points at via `parent`.
// Components whose parent is missing/unknown are top-level orphans laid
// out at the root. Saved layout entries are passed through as initial
// node x/y; this only biases ELK's `layered` algorithm toward similar
// arrangements — it does NOT pin coords exactly. (Exact pinning is
// handled upstream in computeLayout, which skips ELK entirely when every
// component is already laid out.)
export function buildElkGraph(model: Diagram, spec?: LayoutSpec): unknown {
  const containers = containerIds(model);

  const childrenOf = new Map<string, string[]>();
  for (const cid of containers) childrenOf.set(cid, []);
  const orphans: string[] = [];
  for (const [id, c] of Object.entries(model.components)) {
    if (containers.has(id)) continue;
    if (c.parent && containers.has(c.parent)) {
      childrenOf.get(c.parent)!.push(id);
    } else {
      orphans.push(id);
    }
  }

  const pin = (id: string): { x: number; y: number } | undefined => {
    const p = model.layout?.components?.[id];
    return p ? { x: p.x, y: p.y } : undefined;
  };
  const leafChild = (id: string) => {
    const p = pin(id);
    return p
      ? { id, width: BOX_W, height: BOX_H, x: p.x, y: p.y }
      : { id, width: BOX_W, height: BOX_H };
  };

  // Structural pass — node tree + edges only. Algorithm-specific options
  // are layered on by applyLayoutSpec below, so we can swap presets
  // without touching this code.
  const graph: ElkGraphRoot = {
    id: '__root__',
    children: [
      ...Array.from(containers).map((cid) => {
        const p = pin(cid);
        return {
          id: cid,
          ...(p ? { x: p.x, y: p.y } : {}),
          layoutOptions: {
            'elk.padding': `[top=${PAD + 16},left=${PAD},bottom=${PAD},right=${PAD}]`,
          },
          children: childrenOf.get(cid)!.map(leafChild),
        };
      }),
      ...orphans.map(leafChild),
    ],
    edges: Object.entries(model.relationships)
      .filter(([, r]) => r.from in model.components && r.to in model.components)
      .map(([id, r]) => ({ id, sources: [r.from], targets: [r.to] })),
  };

  applyLayoutSpec(graph, resolveLayoutSpec(spec), model, PAD);
  return graph;
}

// Calls elkjs. Isolated as its own function so replay.ts can wrap or
// substitute the engine without touching graph-building or result-walking.
// Concurrent calls serialize through `elkQueue`.
export async function runElk(graph: unknown): Promise<unknown> {
  const job = elkQueue.then(() => elk.layout(graph));
  elkQueue = job.catch(() => undefined);
  return job;
}

// Walks the ELK output tree, builds flat absolute + relative coord maps,
// and computes the canvas bounding box.
//
// ELK returns a TREE that mirrors the input — each node has its own
// {x, y} relative to its parent, and a `children` list. The walk
// accumulates offsets to compute absolute coordinates while ALSO keeping
// the original parent-relative coords.
export function readElkResult(result: unknown): FullLayout {
  const out: WalkOutput = { absolute: {}, relative: {} };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function walk(node: any, ox = 0, oy = 0): void {
    const nx = ox + node.x;
    const ny = oy + node.y;
    if (node.id !== '__root__') {
      out.absolute[node.id] = {
        x: Math.round(nx),
        y: Math.round(ny),
        w: Math.round(node.width),
        h: Math.round(node.height),
      };
      out.relative[node.id] = {
        x: Math.round(node.x),
        y: Math.round(node.y),
        w: Math.round(node.width),
        h: Math.round(node.height),
      };
    }
    for (const child of node.children ?? []) walk(child, nx, ny);
  }
  walk(result);

  return {
    ...boundsOf(out.absolute),
    components: out.absolute,
    relative: out.relative,
  };
}

// Builds the ELK input graph, runs ELK, and walks the result back into
// our flat component-id → box maps. Composition of the three steps above.
//
// Fast path: when every component already has a saved layout entry, ELK
// is skipped entirely and saved coords are used as-is. This is the
// pinning contract — once you've placed everything, the renderer is the
// identity function on positions. ELK only runs when there is something
// to lay out (a brand-new component, or a model with no layout yet),
// at which point it may rearrange existing pins. Acceptable trade for
// the simplicity it buys.
export async function computeLayout(
  model: Diagram,
  spec?: LayoutSpec,
): Promise<FullLayout> {
  const fromSaved = layoutFromSavedPins(model);
  if (fromSaved) return fromSaved;
  const graph = buildElkGraph(model, spec);
  const result = await runElk(graph);
  return readElkResult(result);
}

// Returns a FullLayout built directly from `model.layout.components` if
// (and only if) every component in the model has a saved entry. Returns
// undefined otherwise, signalling the caller to fall back to ELK.
//
// Saved coords are PARENT-RELATIVE per the renderer's storage convention
// (matches what persistNewlyPlaced writes after ELK runs and what ELK
// itself returns for nested children). For a top-level component
// (parent: null) absolute equals relative. For a child of a container,
// absolute = parent.absolute + child.relative — accumulated by walking
// up the parent chain.
function layoutFromSavedPins(model: Diagram): FullLayout | undefined {
  const saved = model.layout?.components;
  if (!saved) return undefined;
  const ids = Object.keys(model.components);
  if (ids.length === 0) return undefined;
  for (const id of ids) {
    if (!saved[id]) return undefined;
  }

  // Resolve absolute (root-relative) coords by recursively walking up
  // the parent chain. Memoized so each component's absolute is computed
  // at most once even if many children share an ancestor.
  const absolute: Record<string, LayoutEntry> = {};
  const resolve = (id: string): LayoutEntry => {
    if (absolute[id]) return absolute[id];
    const p = saved[id];
    const parent = model.components[id]?.parent;
    if (!parent) {
      // Top-level: absolute === relative (the saved value).
      absolute[id] = { x: p.x, y: p.y, w: p.w, h: p.h };
    } else {
      const pa = resolve(parent);
      absolute[id] = { x: pa.x + p.x, y: pa.y + p.y, w: p.w, h: p.h };
    }
    return absolute[id];
  };
  for (const id of ids) resolve(id);

  // Relative coords are the saved values verbatim — they're already
  // parent-relative on disk, no transformation needed.
  const relative: Record<string, LayoutEntry> = {};
  for (const id of ids) {
    const p = saved[id];
    relative[id] = { x: p.x, y: p.y, w: p.w, h: p.h };
  }

  const bounds = boundsOf(absolute);
  return {
    ...bounds,
    components: absolute,
    relative,
  };
}

// Computes the SVG viewBox + canvas dimensions that exactly enclose every
// rendered box, with PAD breathing room on all sides. Handles negative
// coordinates (a component dragged to x=-200 produces a viewBox that
// reaches further left) — without this, anything outside the [0..max]
// range would render off-canvas.
function boundsOf(components: Record<string, LayoutEntry>): {
  viewBoxX: number;
  viewBoxY: number;
  canvasWidth: number;
  canvasHeight: number;
} {
  const entries = Object.values(components);
  if (entries.length === 0) {
    return { viewBoxX: 0, viewBoxY: 0, canvasWidth: PAD * 2, canvasHeight: PAD * 2 };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of entries) {
    if (e.x < minX) minX = e.x;
    if (e.y < minY) minY = e.y;
    if (e.x + e.w > maxX) maxX = e.x + e.w;
    if (e.y + e.h > maxY) maxY = e.y + e.h;
  }
  return {
    viewBoxX: minX - PAD,
    viewBoxY: minY - PAD,
    canvasWidth: maxX - minX + PAD * 2,
    canvasHeight: maxY - minY + PAD * 2,
  };
}

// ── SVG ───────────────────────────────────────────────────────────────────────

export type FullLayout = {
  canvasWidth: number;
  canvasHeight: number;
  // Top-left origin of the SVG viewBox in component-coordinate space.
  // Usually 0,0 (ELK normalizes its output to start there) but can go
  // negative when the user has dragged components to negative coords —
  // the viewBox must extend to include them, or they render off-canvas
  // and the "fit to screen" control shows a misleading partial view.
  viewBoxX: number;
  viewBoxY: number;
  components: Record<string, LayoutEntry>;  // absolute (for SVG drawing)
  relative: Record<string, LayoutEntry>;     // parent-relative (for storage)
};

// Builds the SVG document by concatenating tag literals. We don't use a
// templating library — the grammar is small enough that string-building
// stays readable, and it keeps the bundle tiny. The one risk is XSS-by-
// label-injection; esc() handles that for any user-supplied string we
// drop into the output.
export function emitSvg(model: Diagram, layout: FullLayout, activity?: Record<string, ActivityEntry>): string {
  const { canvasWidth: w, canvasHeight: h, viewBoxX: vx, viewBoxY: vy, components: coords } = layout;
  const containers = containerIds(model);

  // No background rect — the SVG is transparent and the webview's
  // `#stage` element provides the canvas color via `var(--vscode-editor-
  // background)`. That way the canvas matches the active editor theme
  // automatically and there's no hex fill to maintain here.
  //
  // viewBox can start at negative coords when components have been
  // dragged into negative space, so the SVG element itself accepts a
  // possibly-negative origin.
  //
  // <defs><marker> defines the reusable arrowhead shape that every edge's
  // `marker-end="url(#arrow)"` references. Defining it once and reusing is
  // standard SVG practice; defining it inline per edge would bloat the doc.
  //
  // `fill="context-stroke"` makes the arrowhead match the using path's
  // stroke color. (We tried `currentColor` first; Chromium doesn't reliably
  // propagate `currentColor` from a using element through to a marker
  // defined in <defs> — it falls back to the SVG root's color, leaving
  // arrowheads visibly gray on colored lines.)
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${w} ${h}" width="${w}" height="${h}" font-family="${FONT}">`,
    `<defs><marker id="arrow" markerWidth="10" markerHeight="8" refX="9" refY="4" orient="auto-start-reverse" markerUnits="userSpaceOnUse"><path d="M0,0 L10,4 L0,8 z" fill="context-stroke"/></marker></defs>`,
  ];

  // Containers first, leaves second. SVG paints in document order, so
  // emitting containers first means leaf boxes render ON TOP of their
  // parent backgrounds. The `data-component-id` attribute is what the
  // webview reads to know which box was clicked or dragged.
  for (const [id, c] of Object.entries(model.components)) {
    if (!containers.has(id)) continue;
    parts.push(`<g data-component-id="${esc(id)}" data-container="1">${drawContainer(coords[id], c.label)}</g>`);
  }

  for (const [id, c] of Object.entries(model.components)) {
    if (containers.has(id)) continue;
    const staleness = activity?.[id] ? computeStaleness(activity[id]) : undefined;
    parts.push(`<g data-component-id="${esc(id)}">${drawBox(coords[id], c.label, c.kind, model.rules, staleness)}</g>`);
  }

  // Group relationships by unordered {from, to} pair. Multiple edges
  // between the same components render as ONE visual line with a count
  // badge — the underlying relationships stay distinct in the JSON, but
  // the visual collapses for readability. Click the badge / line to open
  // a popover that lists every relationship in the group.
  //
  // Bidirectional groups (edges going both A→B and B→A) get arrowheads
  // at both ends of the merged line.
  for (const group of buildEdgeGroups(model.relationships, coords)) {
    parts.push(drawEdgeGroup(group, coords, model));
  }

  parts.push('</svg>');
  return parts.join('');
}

function drawContainer(p: { x: number; y: number; w: number; h: number }, label: string): string {
  return (
    `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="10" class="pv-container-fill pv-container-stroke" stroke-width="1" stroke-dasharray="6 4"/>` +
    `<text x="${p.x + 12}" y="${p.y - 6}" font-size="11" class="pv-container-label">${esc(label)}</text>`
  );
}

// Builds the fill/stroke/class attributes for a shape. Rule-driven hex
// colors land in inline `fill=`/`stroke=` attrs; missing ones get class
// names that the webview CSS resolves to var(--vscode-…). The two never
// collide on the same element because we only emit the class when the
// matching attr is absent.
function paintAttrs(fill: string | undefined, stroke: string | undefined): string {
  const parts: string[] = [];
  const classes: string[] = [];
  // esc() the user-supplied color values: a hostile model.json could otherwise
  // close the attribute and inject siblings (e.g. event handlers). CSP blocks
  // those from firing today, but the renderer must not emit invalid markup.
  if (fill) parts.push(`fill="${esc(fill)}"`);
  else classes.push('pv-default-fill');
  if (stroke) parts.push(`stroke="${esc(stroke)}"`);
  else classes.push('pv-default-stroke');
  if (classes.length) parts.push(`class="${classes.join(' ')}"`);
  return ' ' + parts.join(' ');
}

// Renders one component as a shape + a centered label. Descriptions don't
// render in the box itself — they can be arbitrarily long and SVG text
// doesn't wrap. The full description still surfaces in the hover tooltip
// (built in webview.ts), so no information is lost.
function drawBox(
  p: { x: number; y: number; w: number; h: number },
  label: string,
  kind: string,
  rules?: Rules,
  staleness?: 'fresh' | 'stale' | 'unknown',
): string {
  const style = rules?.component_styles?.[kind] ?? DEFAULT_COMPONENT;
  const paint = paintAttrs(style.fill, style.color);
  const dash = style.border === 'dashed' ? ' stroke-dasharray="5 3"' : '';
  const shape =
    style.symbol === 'cylinder' ? cylinder(p, paint, dash) :
    style.symbol === 'diamond'  ? diamond(p, paint, dash)  :
                                  rounded(p, paint, dash);

  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  const title = `<text x="${cx}" y="${cy}" font-size="13" font-weight="600" class="pv-title" text-anchor="middle" dominant-baseline="central">${esc(label)}</text>`;

  let dot = '';
  if (staleness === 'fresh' || staleness === 'stale') {
    const fill = staleness === 'fresh' ? '#22c55e' : '#ef4444';
    dot = `<circle class="pv-staleness-dot" cx="${p.x + p.w - 10}" cy="${p.y + 10}" r="5" fill="${fill}" stroke="none"/>`;
  }

  return shape + title + dot;
}

function rounded(p: { x: number; y: number; w: number; h: number }, paint: string, dash: string): string {
  return `<rect x="${p.x}" y="${p.y}" width="${p.w}" height="${p.h}" rx="8"${paint} stroke-width="1.5"${dash}/>`;
}

function cylinder(p: { x: number; y: number; w: number; h: number }, paint: string, dash: string): string {
  const rx = p.w / 2;
  const ry = 8;
  return (
    `<ellipse cx="${p.x + rx}" cy="${p.y + ry}" rx="${rx}" ry="${ry}"${paint} stroke-width="1.5"${dash}/>` +
    `<path d="M${p.x},${p.y + ry} L${p.x},${p.y + p.h - ry} A${rx},${ry} 0 0 0 ${p.x + p.w},${p.y + p.h - ry} L${p.x + p.w},${p.y + ry}"${paint} stroke-width="1.5"${dash}/>` +
    `<ellipse cx="${p.x + rx}" cy="${p.y + p.h - ry}" rx="${rx}" ry="${ry}"${paint} stroke-width="1.5"${dash}/>`
  );
}

// Diamond / rhombus — flowchart decision shape. Vertices at the midpoints
// of the bounding box's edges, so labels still center cleanly even though
// the shape's interior tapers toward the corners (keep labels short).
function diamond(p: { x: number; y: number; w: number; h: number }, paint: string, dash: string): string {
  const cx = p.x + p.w / 2;
  const cy = p.y + p.h / 2;
  return `<path d="M${cx},${p.y} L${p.x + p.w},${cy} L${cx},${p.y + p.h} L${p.x},${cy} Z"${paint} stroke-width="1.5"${dash}/>`;
}

// An EdgeGroup is one or more relationships between the same pair of
// components. Used for visual collapsing: multiple edges between A and B
// render as ONE line with a numbered badge, click to expand.
type EdgeGroup = {
  rids: string[];           // every relationship id in the group
  fromId: string;           // primary direction's source (first edge wins)
  toId: string;             // primary direction's target
  bidirectional: boolean;   // true if any edge in the group goes opposite
                            // to the primary direction
};

// Walks model.relationships once and yields one EdgeGroup per unordered
// {from, to} pair. Filters out edges referencing missing components
// (defensive — they'd otherwise blow up coords lookups downstream).
function buildEdgeGroups(
  relationships: Diagram['relationships'],
  coords: Record<string, LayoutEntry>,
): EdgeGroup[] {
  const groups = new Map<string, EdgeGroup>();
  for (const [rid, r] of Object.entries(relationships)) {
    if (!coords[r.from] || !coords[r.to]) continue;
    const sortedKey = [r.from, r.to].sort().join('\x00');
    let g = groups.get(sortedKey);
    if (!g) {
      g = { rids: [], fromId: r.from, toId: r.to, bidirectional: false };
      groups.set(sortedKey, g);
    }
    g.rids.push(rid);
    if (r.from !== g.fromId || r.to !== g.toId) {
      g.bidirectional = true;
    }
  }
  return Array.from(groups.values());
}

// Renders one edge group: a single SVG line between the two components,
// with arrowheads (one or both ends), and either a kind label (group of
// 1) or a numbered badge (group of >1). Tagged with
// `data-relationship-group` containing comma-separated rids — the
// webview reads that on click to populate the group popover.
function drawEdgeGroup(
  group: EdgeGroup,
  coords: Record<string, LayoutEntry>,
  model: Diagram,
): string {
  const a = coords[group.fromId];
  const b = coords[group.toId];
  const rules = model.rules;

  // All edges render in a single neutral color (theme-driven via the
  // default class) regardless of relationship kind — per-kind colors
  // produced visually noisy diagrams without aiding comprehension.
  // The only per-kind variation that survives is the dashed-vs-solid
  // line style, applied when every relationship in the group shares
  // `style: "dashed"`.
  const kinds = group.rids.map((rid) => model.relationships[rid].kind);
  const styles = kinds.map((k) => rules?.relationship_styles?.[k] ?? DEFAULT_RELATIONSHIP);
  const allDashed = styles.every((s) => s.style === 'dashed');

  // The hook classes (pv-edge-line / pv-edge-label / pv-edge-badge-*) are
  // what the webview's live-drag code grabs to update edge geometry per
  // mousemove. The pv-default-* classes carry the theme-driven stroke /
  // fill colors. Keep both in a single `class=` attribute — emitting two
  // separate `class=` attributes on the same element drops the second
  // one silently in SVG/HTML (browsers take the first and ignore the
  // rest), which leaves edges invisible and labels black.
  const lineAttrs = ' class="pv-edge-line pv-default-arrow-stroke"';
  const textAttrs = ' class="pv-edge-label pv-default-arrow-fill"';
  const dashAttr = allDashed ? ' stroke-dasharray="6 4"' : '';

  // Clip the centerline to the boxes' edges so the arrowhead lands on
  // the visual edge instead of inside the box. Math lives in
  // ./geometry.ts so the webview can recompute the same numbers live
  // during drag without diverging from the rendered shape.
  const { x1, y1, x2, y2 } = computeEdgeEndpoints(a, b);

  // Markers: marker-end always; marker-start only for bidirectional
  // groups. The marker uses orient="auto-start-reverse" so the start
  // arrowhead auto-flips to point outward.
  const markers = group.bidirectional
    ? ` marker-start="url(#arrow)" marker-end="url(#arrow)"`
    : ` marker-end="url(#arrow)"`;
  const line = `<path d="M${x1},${y1} L${x2},${y2}" fill="none"${lineAttrs} stroke-width="1.5"${markers}${dashAttr}/>`;

  // Decoration: kind label for single-edge groups (matches the previous
  // single-edge behavior), count badge for multi-edge groups. The class
  // hooks (`pv-edge-label`, `pv-edge-badge-bg`, `pv-edge-badge-text`)
  // are also how the webview's drag-update finds these children to
  // reposition them as the box moves.
  let decoration = '';
  if (group.rids.length === 1) {
    const kind = kinds[0];
    if (kind) {
      const { x: mx, y: my } = perpendicularLabelPos(x1, y1, x2, y2);
      decoration = `<text x="${mx}" y="${my}" font-size="10"${textAttrs} text-anchor="middle">${esc(kind)}</text>`;
    }
  } else {
    const cx = (x1 + x2) / 2;
    const cy = (y1 + y2) / 2;
    decoration =
      `<circle class="pv-edge-badge-bg" cx="${cx}" cy="${cy}" r="10"/>` +
      `<text class="pv-edge-badge-text" x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central">${group.rids.length}</text>`;
  }

  // `data-from` / `data-to` carry the group's primary direction so the
  // webview can find every edge connected to a dragging component
  // without having to look up rids in the diagram model.
  const groupAttr =
    `data-relationship-group="${esc(group.rids.join(','))}" ` +
    `data-from="${esc(group.fromId)}" data-to="${esc(group.toId)}"`;
  return `<g ${groupAttr}>${line}${decoration}</g>`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

// "Container" isn't a flag on the Component type — it's INFERRED. Any id
// that another component points at via `parent` is a container. This lets
// the schema stay simple (no kind tag for containers), at the cost of
// requiring this small lookup pass.
// Applies the user's saved pins (`model.layout.components`) on top of the
// raw ELK layout. Two different semantics:
//
//   - Container pinned: shift the container + every direct child by the
//     same delta, so the children's relative positions inside the container
//     are preserved.
//   - Leaf pinned: set the leaf's relative position directly to the pin.
//     For a root-level leaf, relative == absolute. For a leaf inside a
//     container, absolute = parent.absolute + pin.
//
// Containers are processed first so a pinned leaf inside a pinned container
// sees the container's absolute position already updated.
function applyPinnedOverrides(model: Diagram, layout: FullLayout): number {
  const pins = model.layout?.components;
  if (!pins) return 0;

  let count = 0;
  const containers = containerIds(model);

  // Pass 1 — containers (shift + cascade to children).
  for (const cid of containers) {
    const pinned = pins[cid];
    const elkPos = layout.relative[cid];
    if (!pinned || !elkPos) continue;

    const dx = pinned.x - elkPos.x;
    const dy = pinned.y - elkPos.y;
    if (dx === 0 && dy === 0) continue;
    count++;

    layout.components[cid] = {
      ...layout.components[cid],
      x: layout.components[cid].x + dx,
      y: layout.components[cid].y + dy,
    };
    layout.relative[cid] = { ...elkPos, x: pinned.x, y: pinned.y };

    for (const [childId, comp] of Object.entries(model.components)) {
      if (comp.parent !== cid) continue;
      if (layout.components[childId]) {
        layout.components[childId] = {
          ...layout.components[childId],
          x: layout.components[childId].x + dx,
          y: layout.components[childId].y + dy,
        };
      }
    }
  }

  // Pass 2 — leaf pins (direct override of position).
  for (const [id, comp] of Object.entries(model.components)) {
    if (containers.has(id)) continue;
    const pinned = pins[id];
    if (!pinned) continue;
    const elkRel = layout.relative[id];
    if (!elkRel) continue;
    if (elkRel.x === pinned.x && elkRel.y === pinned.y) continue;
    count++;

    layout.relative[id] = { ...elkRel, x: pinned.x, y: pinned.y };
    const parentAbs = comp.parent ? layout.components[comp.parent] : undefined;
    if (parentAbs) {
      layout.components[id] = {
        ...layout.components[id],
        x: parentAbs.x + pinned.x,
        y: parentAbs.y + pinned.y,
      };
    } else {
      layout.components[id] = {
        ...layout.components[id],
        x: pinned.x,
        y: pinned.y,
      };
    }
  }

  return count;
}

function containerIds(model: Diagram): Set<string> {
  const ids = new Set<string>();
  for (const c of Object.values(model.components)) {
    if (c.parent) ids.add(c.parent);
  }
  return ids;
}

// XML escape. Component labels and ids come from the diagram JSON, which
// in turn often comes from user-controlled source files — without escaping,
// a label like `<script>` would inject markup into the SVG output.
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

