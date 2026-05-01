// Project Viewer — diagram type definitions.
//
// Pure shapes only. No imports, no fs, no behavior. Anything that operates
// on a Diagram (read/write, render) lives in sibling files.

// An Anchor pins a component to a real-world thing. The renderer
// doesn't interpret these — it just hands them to the webview, which uses
// "file" / "function" / "symbol" anchors to jump into the editor on click.
// Other types (host, external_service, etc.) appear only in the hover
// tooltip; they aren't clickable.
//   { type: "file", value: "src/extension.ts" }
//   { type: "function", value: "src/extension.ts:activate" }
export interface Anchor {
  type: string;
  value: string;
}

// One node in the diagram. `kind` is a free-form tag (e.g., "service",
// "datastore") that the renderer maps to a style via `rules`. `parent`
// points to another component id when this node nests inside a container;
// null means it sits at the top level.
export interface Component {
  kind: string;
  label: string;
  description?: string;
  parent: string | null;
  anchors?: Anchor[];
}

// One edge in the diagram. `from` and `to` are component ids. `kind` is
// a free-form tag that styles the edge. `metadata` is arbitrary JSON the
// webview can show in a popover when the edge is clicked.
//
// Note: relationships do NOT carry anchors. Anchors are a component-only
// concept. If you need to surface where an edge crosses in source, put
// the location into `metadata` instead.
export interface Relationship {
  kind: string;
  from: string;
  to: string;
  metadata?: Record<string, unknown>;
}

// Visual styling for one component kind. All fields optional — anything
// missing falls back to renderer defaults.
//   symbol: "rectangle" | "cylinder"  (drawing shape)
//   color:  CSS color string for the border
//   border: "dashed" makes the border dashed; otherwise solid
//   fill:   CSS color string for the interior
export interface ComponentStyle {
  symbol?: string;
  color?: string;
  border?: string;
  fill?: string;
}

// Visual styling for one relationship kind. All edges render in a
// neutral theme color regardless of kind — color used to be a per-kind
// option but produced visually noisy diagrams without aiding
// comprehension. The remaining options are line styling (dashed) and
// metadata-surfacing hints.
//   style:         "dashed" → dashed stroke; default solid.
//   show_metadata: list of metadata keys the webview should surface in
//                  tooltips/popovers (rest stay hidden behind a click).
export interface RelationshipStyle {
  style?: string;
  show_metadata?: string[];
}

// Container for all the per-kind style overrides. Two flat dictionaries:
// one keyed by component kind, one by relationship kind.
export interface Rules {
  component_styles?: Record<string, ComponentStyle>;
  relationship_styles?: Record<string, RelationshipStyle>;
}

// Persisted layout — written by the renderer after each layout pass and
// read back on the next render. Storing it makes the diagram stable: ELK
// is deterministic-given-input, but small input changes can shuffle every
// box. Pinning positions stops that.
//
// `components` maps component id → a parent-relative box. The convention
// matches ELK's native input format so we can feed it straight back in.
export interface Layout {
  canvasWidth?: number;
  canvasHeight?: number;
  components?: Record<string, { x: number; y: number; w: number; h: number }>;
}

// The whole diagram, as it lives on disk. `_notes` is a bag the wizard /
// other tools can write freeform context into without it polluting the
// rest of the schema.
export interface Diagram {
  components: Record<string, Component>;
  relationships: Record<string, Relationship>;
  rules?: Rules;
  overrides?: Record<string, unknown>;
  layout?: Layout;
  _notes?: string;
}
