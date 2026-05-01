// Tests for src/diagram/layout.ts — the pluggable-preset layer that
// sits between buildElkGraph and ELK.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  resolveLayoutSpec,
  applyLayoutSpec,
  tierForKind,
  UnknownPresetError,
  type ElkGraphRoot,
} from '../src/diagram/layout';
import { computeLayout } from '../src/diagram/render';
import type { Diagram } from '../src/diagram/types';

function bareGraph(...ids: string[]): ElkGraphRoot {
  return {
    id: '__root__',
    children: ids.map((id) => ({ id, width: 220, height: 80 })),
    edges: [],
  };
}

test('resolveLayoutSpec: defaults to tiered when no spec is passed', () => {
  const out = resolveLayoutSpec();
  assert.deepEqual(out, { preset: 'tiered' });
});

test('resolveLayoutSpec: passes through a valid preset', () => {
  assert.deepEqual(resolveLayoutSpec({ preset: 'tiered' }), { preset: 'tiered' });
  assert.deepEqual(resolveLayoutSpec({ preset: 'layered' }), { preset: 'layered' });
});

test('resolveLayoutSpec: unknown preset throws UnknownPresetError', () => {
  assert.throws(
    () => resolveLayoutSpec({ preset: 'nonsense' as never }),
    (err) => err instanceof UnknownPresetError && err.preset === 'nonsense',
  );
});

test('tierForKind: known kinds map to known tiers', () => {
  assert.equal(tierForKind('human_actor'), 0);
  assert.equal(tierForKind('document'), 1);
  assert.equal(tierForKind('external_host'), 2);
  assert.equal(tierForKind('extension'), 3);
  assert.equal(tierForKind('module'), 4);
  assert.equal(tierForKind('data_file'), 5);
});

test('tierForKind: unknown kind falls back to middle tier', () => {
  assert.equal(tierForKind('zogglefoo'), 3);
});

test('applyLayoutSpec (tiered): stamps elk.partitioning.partition on every node by kind', () => {
  const model: Diagram = {
    components: {
      a: { kind: 'human_actor', label: 'A', parent: null },
      b: { kind: 'data_file', label: 'B', parent: null },
    },
    relationships: {},
  };
  const graph = bareGraph('a', 'b');
  applyLayoutSpec(graph, { preset: 'tiered' }, model, 40);

  assert.equal(graph.layoutOptions?.['elk.partitioning.activate'], 'true');
  const aNode = graph.children!.find((n) => n.id === 'a')!;
  const bNode = graph.children!.find((n) => n.id === 'b')!;
  assert.equal(aNode.layoutOptions?.['elk.partitioning.partition'], '0');
  assert.equal(bNode.layoutOptions?.['elk.partitioning.partition'], '5');
});

test('applyLayoutSpec (layered): does NOT stamp partitions or activate partitioning', () => {
  const model: Diagram = {
    components: {
      a: { kind: 'human_actor', label: 'A', parent: null },
      b: { kind: 'data_file', label: 'B', parent: null },
    },
    relationships: {},
  };
  const graph = bareGraph('a', 'b');
  applyLayoutSpec(graph, { preset: 'layered' }, model, 40);

  assert.equal(graph.layoutOptions?.['elk.partitioning.activate'], undefined);
  for (const child of graph.children!) {
    assert.equal(
      child.layoutOptions?.['elk.partitioning.partition'],
      undefined,
      `child ${child.id} must not have a partition under 'layered'`,
    );
  }
});

test('applyLayoutSpec (tiered): stamps tiers on container children too', () => {
  const model: Diagram = {
    components: {
      box: { kind: 'extension', label: 'Box', parent: null },
      a: { kind: 'process', label: 'A', parent: 'box' },
      b: { kind: 'module', label: 'B', parent: 'box' },
    },
    relationships: {},
  };
  const graph: ElkGraphRoot = {
    id: '__root__',
    children: [
      {
        id: 'box',
        width: 220,
        height: 80,
        children: [
          { id: 'a', width: 220, height: 80 },
          { id: 'b', width: 220, height: 80 },
        ],
      },
    ],
    edges: [],
  };
  applyLayoutSpec(graph, { preset: 'tiered' }, model, 40);

  const box = graph.children!.find((n) => n.id === 'box')!;
  assert.equal(box.layoutOptions?.['elk.partitioning.partition'], '3'); // extension
  const a = box.children!.find((n) => n.id === 'a')!;
  const b = box.children!.find((n) => n.id === 'b')!;
  assert.equal(a.layoutOptions?.['elk.partitioning.partition'], '4'); // process
  assert.equal(b.layoutOptions?.['elk.partitioning.partition'], '4'); // module
});

// Regression: end-to-end through computeLayout. The semantic guarantee
// of the `tiered` preset is "actors render above data files." This is
// the production-shape thing the visible bug was failing.
test('computeLayout (tiered preset): actor renders above data_file', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'human_actor', label: 'A', parent: null },
      d: { kind: 'data_file', label: 'D', parent: null },
    },
    // Edge in BOTH directions to make sure tiering survives feedback.
    relationships: {
      ad: { kind: 'reads', from: 'a', to: 'd' },
      da: { kind: 'feedback', from: 'd', to: 'a' },
    },
  };

  const out = await computeLayout(model, { preset: 'tiered' });

  assert.ok(
    out.components.a.y < out.components.d.y,
    `actor.y (${out.components.a.y}) must be less than data_file.y (${out.components.d.y})`,
  );
});

test('computeLayout (layered preset): no tier guarantees, but layout still runs', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'human_actor', label: 'A', parent: null },
      d: { kind: 'data_file', label: 'D', parent: null },
    },
    relationships: { ad: { kind: 'reads', from: 'a', to: 'd' } },
  };

  const out = await computeLayout(model, { preset: 'layered' });

  // Both components placed; we don't assert anything about their
  // relative ordering — that's the whole point of opting out of tiers.
  assert.ok(out.components.a, 'a placed');
  assert.ok(out.components.d, 'd placed');
  assert.ok(out.canvasWidth > 0);
  assert.ok(out.canvasHeight > 0);
});
