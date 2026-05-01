// Project Viewer — diagram on-disk I/O.
//
// All callers pass in `root` — the workspace folder VS Code has open. We
// resolve everything relative to that, so opening a different project
// reads/writes a different model.json.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Diagram } from './types';

const REL_DIR = '.viewer';
const REL_FILE = '.viewer/model.json';

// Returns the absolute path to model.json under the given workspace root.
// Used by callers that need to show the path in an error message.
export function diagramPath(root: string): string {
  return path.join(root, REL_FILE);
}

// Creates the .viewer/ directory if it doesn't already exist.
// `recursive: true` means "create parent directories as needed and don't
// error if the leaf already exists" — equivalent to `mkdir -p`.
export async function ensureDiagramDir(root: string): Promise<void> {
  await fs.mkdir(path.join(root, REL_DIR), { recursive: true });
}

// True iff model.json is readable. We use fs.access rather than fs.stat
// because we only care about existence, not metadata.
export async function diagramExists(root: string): Promise<boolean> {
  try {
    await fs.access(diagramPath(root));
    return true;
  } catch {
    return false;
  }
}

// Reads + parses model.json. Returns null on ANY failure — file missing,
// unreadable, or invalid JSON. Callers treat null as "no usable diagram"
// and surface their own message; we don't throw because most call sites
// (status bar, watcher rerender) have a sensible "no diagram" UX already.
export async function readDiagram(root: string): Promise<Diagram | null> {
  let raw: string;
  try {
    raw = await fs.readFile(diagramPath(root), 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(raw) as Diagram;
  } catch {
    return null;
  }
}

// Read-modify-write helper. Loads the current diagram, hands it to the
// caller's callback for in-place mutation, GCs any newly-orphaned layout/
// override entries, then writes it back as pretty-printed JSON.
//
// The callback receives the live object — anything it touches (including
// nested objects) is persisted on the next write. This is the ONE write
// path other modules go through, so the gcOrphans + format invariants are
// enforced in exactly one place.
//
// All calls go through `writeQueue`. Without serialization, two overlapping
// callers (e.g. applyPin and persistNewlyPlaced firing back-to-back) both
// read the same on-disk state and then race to write back, so the second
// write clobbers the first one's change. Chaining onto a single queue keeps
// each read-modify-write atomic with respect to the others. Errors are
// caught on the queue's tail (so one failure doesn't poison the next call)
// while still propagating to the original caller via `job`.
let writeQueue: Promise<void> = Promise.resolve();

export function mutateDiagram(
  root: string,
  fn: (d: Diagram) => void,
): Promise<void> {
  const job = writeQueue.then(async () => {
    const diagram = await readDiagram(root);
    if (!diagram) return;
    fn(diagram);
    gcOrphans(diagram);
    await fs.writeFile(
      diagramPath(root),
      JSON.stringify(diagram, null, 2) + '\n',
      'utf8',
    );
  });
  writeQueue = job.catch(() => {});
  return job;
}

// Strip layout / override entries that point at components which no longer
// exist. Without this, deleting a component would leave dead entries in
// `layout.components` and `overrides` forever — small files, but they
// confuse diff review and slowly accrete junk.
function gcOrphans(d: Diagram): void {
  const ids = new Set(Object.keys(d.components));
  if (d.layout?.components) {
    for (const id of Object.keys(d.layout.components)) {
      if (!ids.has(id)) delete d.layout.components[id];
    }
  }
  if (d.overrides) {
    for (const id of Object.keys(d.overrides)) {
      if (!ids.has(id)) delete d.overrides[id];
    }
  }
}
