import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { renderDiagram } from '../src/diagram/render';
import type { Diagram } from '../src/diagram/types';

// RD1: When some components are pinned and some aren't, ELK runs to lay out
// the unpinned ones. applyPinnedOverrides then shifts the layout so pinned
// components land where the user dragged them. Previously this only ran for
// CONTAINERS — leaf pins were silently ignored, so dragging a leaf and then
// adding any new component to the model would re-shuffle the leaf.

test('leaf pin: a leaf component stays at its pinned position when a new sibling is added', async () => {
  // Two pinned leaves, then a third component arrives unpinned.
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null },
      c: { kind: 'service', label: 'C-new', parent: null },
    },
    relationships: {
      ab: { kind: 'calls', from: 'a', to: 'b' },
    },
    rules: { component_styles: { service: { symbol: 'rectangle' } } },
    layout: {
      components: {
        a: { x: 500, y: 100, w: 220, h: 80 },
        b: { x: 500, y: 300, w: 220, h: 80 },
        // c intentionally NOT pinned — forces ELK to run.
      },
    },
  };

  const out = await renderDiagram(model);
  const aRel = out.layout.components?.a;
  const bRel = out.layout.components?.b;

  assert.ok(aRel, 'a in returned layout');
  assert.ok(bRel, 'b in returned layout');
  assert.equal(aRel.x, 500, `a.x should stay at pinned 500, got ${aRel.x}`);
  assert.equal(aRel.y, 100, `a.y should stay at pinned 100, got ${aRel.y}`);
  assert.equal(bRel.x, 500, `b.x should stay at pinned 500, got ${bRel.x}`);
  assert.equal(bRel.y, 300, `b.y should stay at pinned 300, got ${bRel.y}`);
});

test('leaf pin: pinned leaf inside a container stays put when sibling leaf is added', async () => {
  const model: Diagram = {
    components: {
      container: { kind: 'group', label: 'C', parent: null },
      leaf_a:    { kind: 'service', label: 'A', parent: 'container' },
      leaf_b:    { kind: 'service', label: 'B-new', parent: 'container' },
    },
    relationships: {},
    rules: { component_styles: { service: { symbol: 'rectangle' }, group: { symbol: 'rectangle' } } },
    layout: {
      components: {
        container: { x: 100, y: 100, w: 600, h: 400 },
        leaf_a:    { x: 80,  y: 80,  w: 220, h: 80 },
        // leaf_b not pinned — added after the user pinned leaf_a.
      },
    },
  };

  const out = await renderDiagram(model);
  const a = out.layout.components?.leaf_a;
  assert.ok(a, 'leaf_a in returned layout');
  // leaf_a was pinned at parent-relative (80, 80) — must stay there.
  assert.equal(a.x, 80,  `leaf_a.x should stay at pinned 80, got ${a.x}`);
  assert.equal(a.y, 80,  `leaf_a.y should stay at pinned 80, got ${a.y}`);
});
