// Project Viewer — pluggable layout strategies.
//
// The diagram engine supports multiple layout "presets" — opinionated
// bundles of ELK options + post-processing. Each preset captures a
// different visual story for the same underlying graph.
//
// Phase 1 ships two presets:
//
//   * `tiered` (default) — assigns each component a vertical tier
//     based on its `kind`. ELK's partitioning feature pins lower
//     tiers above higher ones in the layered output. Built for
//     architecture diagrams where actors-above-data-below is the
//     conventional reading. Containers take a tier; children take
//     their own tier inside the container.
//
//   * `layered` — pure topological layout, no partition constraints.
//     ELK figures out vertical position from edge directions alone.
//     Kept as an opt-out so users with non-architecture-shaped graphs
//     (e.g. a code-call graph) can still get a useful layout.
//
// The diagram engine itself stays VS Code-agnostic — the VS Code
// extension reads its workspace setting and passes the chosen preset
// in via the `LayoutSpec` argument to renderDiagram.

import type { Diagram } from './types';

export type LayoutPreset = 'tiered' | 'layered';

export interface LayoutSpec {
  preset: LayoutPreset;
}

// Default kind → tier mapping for the `tiered` preset. Lower numbers
// render higher in a top-down (DOWN) layout; tier 0 is the top row.
//
// Anything not listed falls through to DEFAULT_TIER_FALLBACK (middle).
// The mapping covers the kinds seen in user-oriented architecture
// diagrams; users with domain-specific kinds will see them clustered
// in the middle until/unless they extend the table.
export const DEFAULT_TIERS: Record<string, number> = {
  // Tier 0: actors — who initiates work
  human_actor: 0,
  ai_actor: 0,
  actor: 0,

  // Tier 1: artifacts the actors directly work on
  document: 1,
  codebase: 1,

  // Tier 2: external systems / hosts
  external_host: 2,
  external: 2,

  // Tier 3: top-level applications / services / extensions
  extension: 3,
  application: 3,
  service: 3,

  // Tier 4: internal modules / processes
  module: 4,
  process: 4,
  worker: 4,

  // Tier 5: data + external libs (bottom)
  data_file: 5,
  storage: 5,
  external_lib: 5,
  library: 5,
};

const DEFAULT_TIER_FALLBACK = 3;

// Resolves a (possibly missing) caller-supplied LayoutSpec into a
// concrete spec with all defaults filled in. Today this just defaults
// the preset to "tiered"; later phases can layer in `direction`,
// per-kind tier overrides, etc.
export function resolveLayoutSpec(spec?: LayoutSpec): LayoutSpec {
  if (!spec) return { preset: 'tiered' };
  if (spec.preset !== 'tiered' && spec.preset !== 'layered') {
    throw new UnknownPresetError(spec.preset);
  }
  return spec;
}

// Unknown preset names are upgraded to a real Error so the caller can
// surface them as a render diagnostic. We use a named error class so
// the caller can match by `instanceof` rather than string-sniffing.
export class UnknownPresetError extends Error {
  constructor(public readonly preset: string) {
    super(`Unknown layout preset: "${preset}". Expected "tiered" or "layered".`);
    this.name = 'UnknownPresetError';
  }
}

// Returns the tier that the `tiered` preset would assign to a given
// component. Exposed so the renderer can stamp partition options onto
// each ELK node.
export function tierForKind(kind: string): number {
  return DEFAULT_TIERS[kind] ?? DEFAULT_TIER_FALLBACK;
}

// Mutates an ELK graph (built by buildElkGraph's structural pass) by
// adding the layoutOptions appropriate to the given LayoutSpec.
// Returns the same graph for chaining.
//
// Both presets share the bulk of the ELK config (algorithm, direction,
// spacing, padding, hierarchy). The presets diverge only on
// partitioning — `tiered` activates it and stamps each node with a
// tier; `layered` leaves it off.
export function applyLayoutSpec(
  graph: ElkGraphRoot,
  spec: LayoutSpec,
  model: Diagram,
  pad: number,
): ElkGraphRoot {
  graph.layoutOptions = {
    'elk.algorithm': 'layered',
    'elk.direction': 'DOWN',
    'elk.layered.spacing.nodeNodeBetweenLayers': '70',
    'elk.spacing.nodeNode': '40',
    'elk.padding': `[top=${pad},left=${pad},bottom=${pad},right=${pad}]`,
    'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
    ...(spec.preset === 'tiered'
      ? { 'elk.partitioning.activate': 'true' }
      : {}),
  };

  if (spec.preset === 'tiered') {
    stampTiers(graph, model);
  }

  return graph;
}

// Walks every ELK node in the graph (both top-level and container
// children) and writes the tier number into its layoutOptions. ELK's
// partitioning then keeps tier 0 above tier 1 above tier 2, etc.
function stampTiers(graph: ElkGraphRoot, model: Diagram): void {
  const stamp = (node: ElkNode) => {
    if (node.id === '__root__') {
      for (const child of node.children ?? []) stamp(child);
      return;
    }
    const kind = model.components[node.id]?.kind;
    if (kind !== undefined) {
      const tier = tierForKind(kind);
      node.layoutOptions = {
        ...(node.layoutOptions ?? {}),
        'elk.partitioning.partition': String(tier),
      };
    }
    for (const child of node.children ?? []) stamp(child);
  };
  stamp(graph);
}

// ── Local ELK graph types ─────────────────────────────────────────────────
// Just enough to stamp options without dragging in elkjs's typings.

export interface ElkNode {
  id: string;
  width?: number;
  height?: number;
  x?: number;
  y?: number;
  layoutOptions?: Record<string, string>;
  children?: ElkNode[];
}

export interface ElkGraphRoot extends ElkNode {
  edges?: Array<{ id: string; sources: string[]; targets: string[] }>;
}
