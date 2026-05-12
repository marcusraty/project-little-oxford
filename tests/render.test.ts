// Tests for src/diagram/render.ts — focused on the layout pipeline's
// pinning contract.
//
// The bug under test: when every component already has a saved layout
// entry, computeLayout was running ELK and ELK was shifting the
// coordinates. Drag-to-pin therefore appeared not to "stick." The fix is
// to skip ELK entirely when all components are pinned, and use the saved
// coordinates as the layout directly.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { computeLayout, emitSvg } from '../src/diagram/render';
import type { Diagram } from '../src/diagram/types';

const baseRules: Diagram['rules'] = {
  component_styles: { service: { symbol: 'rectangle', color: '#38bdf8' } },
};

test('computeLayout: all-pinned model preserves saved coordinates exactly', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null },
      c: { kind: 'service', label: 'C', parent: null },
    },
    relationships: {
      ab: { kind: 'calls', from: 'a', to: 'b' },
      bc: { kind: 'calls', from: 'b', to: 'c' },
    },
    rules: baseRules,
    layout: {
      components: {
        a: { x: 100, y: 200, w: 220, h: 80 },
        b: { x: 500, y: 200, w: 220, h: 80 },
        c: { x: 900, y: 200, w: 220, h: 80 },
      },
    },
  };

  const out = await computeLayout(model);

  // Saved coords are authoritative. ELK must not have run, or if it did,
  // it must not have shifted anything.
  assert.deepEqual(out.components.a, { x: 100, y: 200, w: 220, h: 80 });
  assert.deepEqual(out.components.b, { x: 500, y: 200, w: 220, h: 80 });
  assert.deepEqual(out.components.c, { x: 900, y: 200, w: 220, h: 80 });
  assert.deepEqual(out.relative.a, { x: 100, y: 200, w: 220, h: 80 });
  assert.deepEqual(out.relative.b, { x: 500, y: 200, w: 220, h: 80 });
  assert.deepEqual(out.relative.c, { x: 900, y: 200, w: 220, h: 80 });
});

test('computeLayout: empty layout block triggers ELK and places every component', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null },
    },
    relationships: { ab: { kind: 'calls', from: 'a', to: 'b' } },
    rules: baseRules,
    // no layout block
  };

  const out = await computeLayout(model);

  // We don't care exactly where ELK puts them — just that they got
  // placed and the canvas has positive size.
  assert.ok(out.components.a, 'a should be placed');
  assert.ok(out.components.b, 'b should be placed');
  assert.ok(out.canvasWidth > 0, 'canvas should have width');
  assert.ok(out.canvasHeight > 0, 'canvas should have height');
});

test('computeLayout: partial pin (new component added) re-runs ELK on full graph', async () => {
  // Per the chosen design: when a new component appears without a saved
  // pin, the simplest correct behavior is to let ELK re-arrange the
  // whole graph. Existing pins may shift; that trade is accepted in
  // exchange for code simplicity. Pinned-only renders remain pin-stable
  // (test #1 above).
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null }, // new — no pin
    },
    relationships: { ab: { kind: 'calls', from: 'a', to: 'b' } },
    rules: baseRules,
    layout: {
      components: {
        a: { x: 100, y: 200, w: 220, h: 80 },
      },
    },
  };

  const out = await computeLayout(model);

  // Both placed.
  assert.ok(out.components.a, 'a should be placed');
  assert.ok(out.components.b, 'b should be placed');
});

test('computeLayout: viewBox spans actual content, including negative coords', async () => {
  // Captured from the live drag.log: a user dragged components to coords
  // with x=-311 and y=-130. The SVG must include those points or they
  // render off-canvas and `fit` shows a misleading partial view.
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null },
    },
    relationships: {},
    rules: baseRules,
    layout: {
      components: {
        a: { x: -200, y: -100, w: 220, h: 80 },
        b: { x: 500, y: 300, w: 220, h: 80 },
      },
    },
  };

  const out = await computeLayout(model);

  // viewBox origin must reach the negative components (with padding).
  assert.ok(
    out.viewBoxX <= -200,
    `viewBoxX must include the leftmost component at x=-200; got ${out.viewBoxX}`,
  );
  assert.ok(
    out.viewBoxY <= -100,
    `viewBoxY must include the topmost component at y=-100; got ${out.viewBoxY}`,
  );

  // Width spans from min x to max x+w (920 here) plus padding on both sides.
  assert.ok(
    out.canvasWidth >= 920,
    `canvasWidth must span min..max+w; got ${out.canvasWidth}`,
  );
  assert.ok(
    out.canvasHeight >= 480,
    `canvasHeight must span min..max+h; got ${out.canvasHeight}`,
  );

  // The emitted SVG's viewBox attr must reflect the same bounds.
  const svg = emitSvg(model, out);
  const m = /viewBox="(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)"/.exec(svg);
  assert.ok(m, 'svg should declare a viewBox');
  const [, vx, vy, vw, vh] = m!;
  assert.ok(Number(vx) <= -200, `viewBox x must reach the leftmost component; got ${vx}`);
  assert.ok(Number(vy) <= -100, `viewBox y must reach the topmost component; got ${vy}`);
  assert.equal(Number(vw), out.canvasWidth);
  assert.equal(Number(vh), out.canvasHeight);
});

test('emitSvg: malicious style.fill / style.color cannot break out of attribute', async () => {
  // Style values come from user-authored model.json. A model that ships with
  // a hostile `fill` or `color` value must not be able to inject SVG event
  // handlers (or any attribute) into the rendered output. CSP blocks inline
  // handlers from executing today, but defense in depth: the renderer must
  // emit attribute-safe values regardless.
  const model: Diagram = {
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
    rules: {
      component_styles: {
        svc: {
          symbol: 'rectangle',
          color: '#000" onclick="alert(1)" x="',
          fill: '" onmouseover="alert(2)" "',
        },
      },
    },
    layout: { components: { a: { x: 0, y: 0, w: 220, h: 80 } } },
  };
  const out = await computeLayout(model);
  const svg = emitSvg(model, out);
  assert.equal(svg.includes('onclick="alert'), false, 'must not inject onclick');
  assert.equal(svg.includes('onmouseover="alert'), false, 'must not inject onmouseover');
});

test('computeLayout: drag-then-render is a fixpoint when all pinned', async () => {
  // The exact regression the host-side log captured: a user drags a
  // component, the new coord lands in model.layout, the next render
  // should produce that same coord — not snap it back to a grid.
  const model: Diagram = {
    components: {
      vscode: { kind: 'external', label: 'VS Code', parent: null },
      ext: { kind: 'service', label: 'Extension Host', parent: null },
      web: { kind: 'service', label: 'Webview', parent: null },
    },
    relationships: {
      a: { kind: 'activates', from: 'vscode', to: 'ext' },
      b: { kind: 'postmessage', from: 'ext', to: 'web' },
    },
    rules: baseRules,
    layout: {
      components: {
        // Coordinates lifted from the actual drag.log capture: the user
        // dragged `vscode` to (708, 314).
        vscode: { x: 708, y: 314, w: 220, h: 80 },
        ext: { x: 351, y: 490, w: 220, h: 80 },
        web: { x: 1210, y: 340, w: 220, h: 80 },
      },
    },
  };

  const out = await computeLayout(model);

  assert.equal(out.components.vscode.x, 708, 'dragged x must survive the renderer');
  assert.equal(out.components.vscode.y, 314, 'dragged y must survive the renderer');
});

// Regression guard: when an all-pinned hierarchical model is laid out
// via the layoutFromSavedPins fast path (every component has a saved
// entry, so ELK is bypassed), children's saved coords are interpreted
// as ABSOLUTE — but the renderer stores them PARENT-RELATIVE. Result:
// children land at world coords (saved_x, saved_y), which for a child
// of a container at (587, 190) means a child saved at parent-relative
// (51, 186) is drawn at world (51, 186) — far outside the container.
test('computeLayout (saved-pins fast path): hierarchical saved layout produces children inside parent', async () => {
  const model: Diagram = {
    components: {
      box: { kind: 'service', label: 'Box', parent: null },
      a: { kind: 'service', label: 'A', parent: 'box' },
      b: { kind: 'service', label: 'B', parent: 'box' },
    },
    relationships: {},
    rules: baseRules,
    // Every component has a saved entry → layoutFromSavedPins kicks in
    // and ELK is bypassed. Children's coords are PARENT-RELATIVE per
    // the renderer's storage convention (matches what
    // persistNewlyPlaced writes after ELK has run).
    layout: {
      components: {
        box: { x: 500, y: 200, w: 400, h: 300 },
        a: { x: 50, y: 50, w: 220, h: 80 },   // parent-relative inside box
        b: { x: 50, y: 170, w: 220, h: 80 },  // parent-relative inside box
      },
    },
  };

  const out = await computeLayout(model);

  // The container's coords are top-level (parent: null) so absolute = saved.
  assert.equal(out.components.box.x, 500);
  assert.equal(out.components.box.y, 200);

  // The children's ABSOLUTE coords must equal box.absolute + child.relative.
  assert.equal(out.components.a.x, 550, 'a.absolute.x = box.x + a.relative.x = 500 + 50');
  assert.equal(out.components.a.y, 250, 'a.absolute.y = box.y + a.relative.y = 200 + 50');
  assert.equal(out.components.b.x, 550, 'b.absolute.x = 500 + 50');
  assert.equal(out.components.b.y, 370, 'b.absolute.y = 200 + 170');

  // RELATIVE coords stay raw (saved values are already parent-relative —
  // round-trip stable when persisted).
  assert.equal(out.relative.a.x, 50);
  assert.equal(out.relative.a.y, 50);
  assert.equal(out.relative.b.y, 170);

  // And the bounding-box check: every child fully inside the container.
  const box = out.components.box;
  for (const id of ['a', 'b']) {
    const ch = out.components[id];
    const inside =
      ch.x >= box.x &&
      ch.y >= box.y &&
      ch.x + ch.w <= box.x + box.w &&
      ch.y + ch.h <= box.y + box.h;
    assert.ok(
      inside,
      `child ${id} at (${ch.x},${ch.y},${ch.w}x${ch.h}) must lie inside container at (${box.x},${box.y},${box.w}x${box.h})`,
    );
  }
});

// Higher-fidelity guard: same shape as the production .oxford/model.json
// (12 components, one container of 3, sibling top-level components, edges
// crossing the container boundary). The smaller container test passes
// even when the visual bug is present, suggesting the smaller graph
// doesn't trigger ELK's mis-sizing path. This is the production-shape
// repro.
test('computeLayout: production-shape model — children of container land inside it', async () => {
  const model: Diagram = {
    components: {
      developer: { kind: 'service', label: 'Developer', parent: null },
      ai_agent: { kind: 'service', label: 'AI Agent', parent: null },
      bootstrap_spec: { kind: 'service', label: 'BOOTSTRAP.md', parent: null },
      target_codebase: { kind: 'service', label: 'Target Codebase', parent: null },
      vscode: { kind: 'service', label: 'VS Code', parent: null },
      model_json: { kind: 'service', label: 'model.json', parent: null },
      elk: { kind: 'service', label: 'ELK', parent: null },
      diagram_engine: { kind: 'service', label: 'Diagram Engine', parent: null },
      vscode_extension: { kind: 'service', label: 'VS Code Extension', parent: null },
      extension_host: { kind: 'service', label: 'Extension Host', parent: 'vscode_extension' },
      webview: { kind: 'service', label: 'Webview', parent: 'vscode_extension' },
      diagnostics: { kind: 'service', label: 'Diagnostics', parent: 'vscode_extension' },
    },
    relationships: {
      r1: { kind: 'follows', from: 'ai_agent', to: 'bootstrap_spec' },
      r2: { kind: 'reads', from: 'ai_agent', to: 'target_codebase' },
      r3: { kind: 'authors', from: 'ai_agent', to: 'model_json' },
      r4: { kind: 'develops', from: 'developer', to: 'target_codebase' },
      r5: { kind: 'refines', from: 'developer', to: 'model_json' },
      r6: { kind: 'reads_writes', from: 'diagram_engine', to: 'model_json' },
      r7: { kind: 'lays_out_with', from: 'diagram_engine', to: 'elk' },
      r8: { kind: 'uses', from: 'extension_host', to: 'diagram_engine' },
      r9: { kind: 'interacts', from: 'developer', to: 'webview' },
      r10: { kind: 'hosts', from: 'vscode', to: 'vscode_extension' },
      r11: { kind: 'opens_editor', from: 'extension_host', to: 'vscode' },
      r12: { kind: 'posts_messages', from: 'extension_host', to: 'webview' },
      r13: { kind: 'posts_messages', from: 'webview', to: 'extension_host' },
      r14: { kind: 'traces', from: 'extension_host', to: 'diagnostics' },
      r15: { kind: 'traces', from: 'webview', to: 'diagnostics' },
    },
    rules: baseRules,
  };

  const out = await computeLayout(model);

  const container = out.components.vscode_extension;
  for (const childId of ['extension_host', 'webview', 'diagnostics']) {
    const child = out.components[childId];
    const fullyInside =
      child.x >= container.x &&
      child.y >= container.y &&
      child.x + child.w <= container.x + container.w &&
      child.y + child.h <= container.y + container.h;
    assert.ok(
      fullyInside,
      `[production-shape] child ${childId} at (${child.x},${child.y},${child.w}x${child.h}) ` +
        `must lie inside container at (${container.x},${container.y},${container.w}x${container.h})`,
    );
  }

  // The container must NOT overlap the orphan top-level components.
  for (const orphanId of ['developer', 'ai_agent', 'model_json', 'elk', 'diagram_engine']) {
    const orphan = out.components[orphanId];
    const overlaps =
      orphan.x < container.x + container.w &&
      orphan.x + orphan.w > container.x &&
      orphan.y < container.y + container.h &&
      orphan.y + orphan.h > container.y;
    assert.ok(
      !overlaps,
      `[production-shape] orphan ${orphanId} at (${orphan.x},${orphan.y},${orphan.w}x${orphan.h}) ` +
        `must not overlap container at (${container.x},${container.y},${container.w}x${container.h})`,
    );
  }
});

// Regression guard: when a model uses parent/child hierarchy (a container
// component with N children referencing it via `parent`), ELK should place
// the children inside the container's geometric bounds. The bug we're
// guarding against: container drawn as a huge empty box at one location,
// children drawn outside its bounds. Visually catastrophic — the diagram
// loses its structure.
test('computeLayout: children of a container land inside the container box', async () => {
  const model: Diagram = {
    components: {
      // The container — referenced as parent by three others, so the
      // renderer's containerIds() picks it up automatically.
      box: { kind: 'service', label: 'Box', parent: null },
      a: { kind: 'service', label: 'A', parent: 'box' },
      b: { kind: 'service', label: 'B', parent: 'box' },
      c: { kind: 'service', label: 'C', parent: 'box' },
      // An orphan top-level component for context.
      outside: { kind: 'service', label: 'Outside', parent: null },
    },
    relationships: {
      ab: { kind: 'calls', from: 'a', to: 'b' },
    },
    rules: baseRules,
  };

  const out = await computeLayout(model);

  const container = out.components.box;
  assert.ok(container, 'container `box` should be placed');
  assert.ok(container.w > 0 && container.h > 0, 'container has positive size');

  for (const childId of ['a', 'b', 'c']) {
    const child = out.components[childId];
    assert.ok(child, `child ${childId} should be placed`);
    // Absolute coords are top-left of each box. A child's box should
    // sit FULLY inside the container's box.
    const fullyInside =
      child.x >= container.x &&
      child.y >= container.y &&
      child.x + child.w <= container.x + container.w &&
      child.y + child.h <= container.y + container.h;
    assert.ok(
      fullyInside,
      `child ${childId} at (${child.x},${child.y},${child.w}x${child.h}) ` +
        `must lie inside container at (${container.x},${container.y},${container.w}x${container.h})`,
    );
  }

  // The orphan top-level component must NOT overlap the container.
  const orphan = out.components.outside;
  const overlaps =
    orphan.x < container.x + container.w &&
    orphan.x + orphan.w > container.x &&
    orphan.y < container.y + container.h &&
    orphan.y + orphan.h > container.y;
  assert.ok(!overlaps, 'orphan top-level component should not overlap container');
});

// Regression guard: drawEdgeGroup once emitted both the live-drag hook
// class (pv-edge-line / pv-edge-label) AND the theme color class
// (pv-default-arrow-stroke / -fill) as TWO separate `class=` attributes
// on the same element. SVG/HTML take the first and silently drop the
// rest, so every edge path ended up with no stroke (invisible) and
// every kind label with default-black fill on the dark canvas. The
// failure mode is catastrophic and easy to miss in a smoke test
// because the SVG still parses fine — it just renders wrong.
test('emitSvg: edge elements have a single class= attribute carrying both hook and theme classes', async () => {
  const model: Diagram = {
    components: {
      a: { kind: 'service', label: 'A', parent: null },
      b: { kind: 'service', label: 'B', parent: null },
      c: { kind: 'service', label: 'C', parent: null },
    },
    relationships: {
      ab: { kind: 'calls', from: 'a', to: 'b' },
      bc: { kind: 'reads', from: 'b', to: 'c' },
    },
    rules: baseRules,
  };

  const computed = await computeLayout(model);
  const svg = emitSvg(model, computed);

  // No SVG element may carry more than one class= attribute. Walk every
  // tag, count `class=` occurrences inside it.
  const tagRe = /<[a-z][^>]*>/gi;
  const tags = svg.match(tagRe) ?? [];
  for (const tag of tags) {
    const classCount = (tag.match(/\sclass=/g) ?? []).length;
    assert.ok(
      classCount <= 1,
      `tag has ${classCount} class= attributes (only the first is honored): ${tag}`,
    );
  }

  // The renderer must still emit BOTH names — the hook (drag finds it)
  // AND the theme class (CSS colors it) — for every edge path and
  // every kind label.
  const pathTags = svg.match(/<path\b[^>]*\/>/g) ?? [];
  const edgePaths = pathTags.filter((p) => p.includes('pv-edge-line'));
  assert.ok(edgePaths.length >= 2, `expected ≥2 edge paths, got ${edgePaths.length}`);
  for (const p of edgePaths) {
    assert.ok(
      p.includes('pv-default-arrow-stroke'),
      `edge path missing theme stroke class — would render invisible: ${p}`,
    );
  }

  const textTags = svg.match(/<text\b[^>]*>/g) ?? [];
  const edgeLabels = textTags.filter((t) => t.includes('pv-edge-label'));
  assert.ok(edgeLabels.length >= 2, `expected ≥2 edge labels, got ${edgeLabels.length}`);
  for (const t of edgeLabels) {
    assert.ok(
      t.includes('pv-default-arrow-fill'),
      `edge label missing theme fill class — would render default black: ${t}`,
    );
  }
});

// --- staleness dot (Phase 3) ---

test('emitSvg: fresh component gets green staleness dot', async () => {
  const model: Diagram = {
    components: { svc: { kind: 'service', label: 'Svc', parent: null } },
    relationships: {},
    layout: { components: { svc: { x: 0, y: 0, w: 220, h: 80 } } },
  };
  const out = await computeLayout(model);
  const activity = { svc: { last_read: '2026-05-10T11:00:00Z', last_read_session: 's1' } };
  const svg = emitSvg(model, out, activity);
  assert.ok(svg.includes('pv-staleness-dot'), 'should have staleness dot');
  assert.ok(svg.includes('fill="#22c55e"'), 'fresh dot should be green');
});

test('emitSvg: stale component gets red dot', async () => {
  const model: Diagram = {
    components: { svc: { kind: 'service', label: 'Svc', parent: null } },
    relationships: {},
    layout: { components: { svc: { x: 0, y: 0, w: 220, h: 80 } } },
  };
  const out = await computeLayout(model);
  const activity = {
    svc: {
      last_read: '2026-05-10T10:00:00Z', last_read_session: 's1',
      last_edit: '2026-05-10T11:00:00Z', last_edit_session: 's2',
    },
  };
  const svg = emitSvg(model, out, activity);
  assert.ok(svg.includes('pv-staleness-dot'), 'should have staleness dot');
  assert.ok(svg.includes('fill="#ef4444"'), 'stale dot should be red');
});

test('emitSvg: component without activity gets no dot', async () => {
  const model: Diagram = {
    components: { svc: { kind: 'service', label: 'Svc', parent: null } },
    relationships: {},
    layout: { components: { svc: { x: 0, y: 0, w: 220, h: 80 } } },
  };
  const out = await computeLayout(model);
  const svg = emitSvg(model, out);
  assert.ok(!svg.includes('pv-staleness-dot'), 'no activity means no dot');
});

test('emitSvg: dot position is top-right of component box', async () => {
  const model: Diagram = {
    components: { svc: { kind: 'service', label: 'Svc', parent: null } },
    relationships: {},
    layout: { components: { svc: { x: 100, y: 50, w: 220, h: 80 } } },
  };
  const out = await computeLayout(model);
  const activity = { svc: { last_read: '2026-05-10T11:00:00Z', last_read_session: 's1' } };
  const svg = emitSvg(model, out, activity);
  const dotMatch = /pv-staleness-dot[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(svg);
  assert.ok(dotMatch, 'dot should have cx and cy');
  const cx = Number(dotMatch![1]);
  const cy = Number(dotMatch![2]);
  assert.ok(cx >= 300, `cx should be near right edge (x+w), got ${cx}`);
  assert.ok(cy <= 70, `cy should be near top edge (y), got ${cy}`);
});
