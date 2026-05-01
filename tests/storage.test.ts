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
import { mutateDiagram } from '../src/diagram/storage';
import type { Diagram } from '../src/diagram/types';

async function makeRoot(initial: Diagram): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pv-storage-'));
  await fs.mkdir(path.join(root, '.viewer'), { recursive: true });
  await fs.writeFile(
    path.join(root, '.viewer/model.json'),
    JSON.stringify(initial, null, 2) + '\n',
    'utf8',
  );
  return root;
}

test('mutateDiagram: two concurrent writes both survive', async () => {
  const initial: Diagram = {
    components: {
      a: { kind: 'svc', label: 'A', parent: null },
      b: { kind: 'svc', label: 'B', parent: null },
    },
    relationships: {},
    layout: { components: {} },
  };
  const root = await makeRoot(initial);

  // Two writes that touch DIFFERENT keys. If the calls serialize, both
  // pins land. If they race (the buggy behavior), the second read happens
  // before the first write completes, and the second write clobbers the
  // first one's change.
  await Promise.all([
    mutateDiagram(root, (d) => {
      d.layout = d.layout ?? {};
      d.layout.components = d.layout.components ?? {};
      d.layout.components.a = { x: 1, y: 1, w: 1, h: 1 };
    }),
    mutateDiagram(root, (d) => {
      d.layout = d.layout ?? {};
      d.layout.components = d.layout.components ?? {};
      d.layout.components.b = { x: 2, y: 2, w: 2, h: 2 };
    }),
  ]);

  const final = JSON.parse(
    await fs.readFile(path.join(root, '.viewer/model.json'), 'utf8'),
  ) as Diagram;
  assert.deepEqual(final.layout?.components?.a, { x: 1, y: 1, w: 1, h: 1 }, 'a survived');
  assert.deepEqual(final.layout?.components?.b, { x: 2, y: 2, w: 2, h: 2 }, 'b survived');
});
