// Tests for src/diagram/storage.ts — focused on the concurrent-write
// invariant.
//
// The bug under test: mutateDiagram does read → mutate → write without any
// serialization. Two concurrent calls both read the same on-disk state and
// then race to write back, so the second write clobbers the first one's
// change. That happens in real use whenever applyPin and persistNewlyPlaced
// (or two quick drags) overlap.

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { mutateDiagram, readLayout, writeLayout, mutateLayout, readDiagram } from '../src/diagram/storage';
import type { Diagram, Layout } from '../src/diagram/types';

async function makeRoot(initial: Diagram): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-storage-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.oxford/model.json'),
    JSON.stringify(initial, null, 2) + '\n',
    'utf8',
  );
  return root;
}

test('mutateDiagram: two concurrent component writes both survive', async () => {
  const initial: Diagram = {
    components: {
      a: { kind: 'svc', label: 'A', parent: null },
      b: { kind: 'svc', label: 'B', parent: null },
    },
    relationships: {},
  };
  const root = await makeRoot(initial);

  await Promise.all([
    mutateDiagram(root, (d) => {
      d.components.a.label = 'Updated A';
    }),
    mutateDiagram(root, (d) => {
      d.components.b.label = 'Updated B';
    }),
  ]);

  const final = JSON.parse(
    await fs.readFile(path.join(root, '.oxford/model.json'), 'utf8'),
  ) as Diagram;
  assert.equal(final.components.a.label, 'Updated A', 'a survived');
  assert.equal(final.components.b.label, 'Updated B', 'b survived');
});

// --- Layout I/O ---

test('readLayout: returns empty object when layout.json missing', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-layout-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  const layout = await readLayout(root);
  assert.deepEqual(layout, {});
});

test('writeLayout then readLayout round-trips', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-layout-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  const data: Layout = { canvasWidth: 800, canvasHeight: 600, components: { a: { x: 10, y: 20, w: 100, h: 50 } } };
  await writeLayout(root, data);
  const result = await readLayout(root);
  assert.deepEqual(result, data);
});

// Step 2: mutateLayout

test('mutateLayout: two concurrent layout writes both survive', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-layout-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  await writeLayout(root, { components: {} });

  await Promise.all([
    mutateLayout(root, (layout) => {
      layout.components = layout.components ?? {};
      layout.components.a = { x: 1, y: 1, w: 1, h: 1 };
    }),
    mutateLayout(root, (layout) => {
      layout.components = layout.components ?? {};
      layout.components.b = { x: 2, y: 2, w: 2, h: 2 };
    }),
  ]);

  const final = await readLayout(root);
  assert.deepEqual(final.components?.a, { x: 1, y: 1, w: 1, h: 1 }, 'a survived');
  assert.deepEqual(final.components?.b, { x: 2, y: 2, w: 2, h: 2 }, 'b survived');
});

test('mutateLayout: GCs orphan entries when componentIds provided', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-layout-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  await writeLayout(root, { components: { real: { x: 1, y: 1, w: 1, h: 1 }, orphan: { x: 2, y: 2, w: 2, h: 2 } } });

  await mutateLayout(root, () => {}, new Set(['real']));

  const final = await readLayout(root);
  assert.ok(final.components?.real, 'real survived');
  assert.equal(final.components?.orphan, undefined, 'orphan removed');
});

// Step 3: readDiagram merges layout.json

test('readDiagram: merges layout.json into returned Diagram', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-merge-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fs.writeFile(path.join(root, '.oxford', 'model.json'), JSON.stringify({
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
  }), 'utf8');
  await writeLayout(root, { components: { a: { x: 10, y: 20, w: 100, h: 50 } } });

  const diagram = await readDiagram(root);
  assert.ok(diagram);
  assert.deepEqual(diagram!.layout?.components?.a, { x: 10, y: 20, w: 100, h: 50 });
});

test('readDiagram: layout.json wins over stale model.json layout', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-merge-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fs.writeFile(path.join(root, '.oxford', 'model.json'), JSON.stringify({
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
    layout: { components: { a: { x: 0, y: 0, w: 0, h: 0 } } },
  }), 'utf8');
  await writeLayout(root, { components: { a: { x: 99, y: 99, w: 99, h: 99 } } });

  const diagram = await readDiagram(root);
  assert.deepEqual(diagram!.layout?.components?.a, { x: 99, y: 99, w: 99, h: 99 });
});

test('readDiagram: falls back to model.json layout when layout.json absent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-merge-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fs.writeFile(path.join(root, '.oxford', 'model.json'), JSON.stringify({
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
    layout: { components: { a: { x: 5, y: 5, w: 5, h: 5 } } },
  }), 'utf8');

  const diagram = await readDiagram(root);
  assert.deepEqual(diagram!.layout?.components?.a, { x: 5, y: 5, w: 5, h: 5 });
});

// Step 4: mutateDiagram strips layout

test('mutateDiagram: does not write layout field to model.json', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-strip-'));
  await fs.mkdir(path.join(root, '.oxford'), { recursive: true });
  await fs.writeFile(path.join(root, '.oxford', 'model.json'), JSON.stringify({
    components: { a: { kind: 'svc', label: 'A', parent: null } },
    relationships: {},
  }), 'utf8');
  await writeLayout(root, { components: { a: { x: 10, y: 20, w: 100, h: 50 } } });

  await mutateDiagram(root, (d) => {
    d.components.a.label = 'Updated';
  });

  const rawModel = JSON.parse(await fs.readFile(path.join(root, '.oxford', 'model.json'), 'utf8'));
  assert.equal(rawModel.layout, undefined, 'model.json should not contain layout');
  assert.equal(rawModel.components.a.label, 'Updated');

  const layout = await readLayout(root);
  assert.deepEqual(layout.components?.a, { x: 10, y: 20, w: 100, h: 50 }, 'layout.json preserved');
});
