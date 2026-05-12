// little-oxford — diagram on-disk I/O.
//
// All callers pass in `root` — the workspace folder VS Code has open. We
// resolve everything relative to that, so opening a different project
// reads/writes a different model.json.

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Diagram, Layout } from './types';
import { writeFileAtomic } from '../audit/atomic_write';

const REL_DIR = '.oxford';
export const DEFAULT_DIAGRAM_FILE = 'model.json';
const LAYOUT_FILE = 'layout.json';

function layoutPath(root: string): string {
  return path.join(root, REL_DIR, LAYOUT_FILE);
}

export async function readLayout(root: string): Promise<Layout> {
  try {
    const raw = await fs.readFile(layoutPath(root), 'utf8');
    return JSON.parse(raw) as Layout;
  } catch {
    return {};
  }
}

export async function writeLayout(root: string, layout: Layout): Promise<void> {
  await writeFileAtomic(layoutPath(root), JSON.stringify(layout, null, 2) + '\n');
}

// Returns the absolute path to a diagram file under the given workspace
// root. `filename` defaults to model.json for the common case; pass another
// basename to address a different *.json under .oxford/ (e.g. sequence.json).
export function diagramPath(root: string, filename: string = DEFAULT_DIAGRAM_FILE): string {
  return path.join(root, REL_DIR, filename);
}

// Creates the .oxford/ directory if it doesn't already exist.
// `recursive: true` means "create parent directories as needed and don't
// error if the leaf already exists" — equivalent to `mkdir -p`.
export async function ensureDiagramDir(root: string): Promise<void> {
  await fs.mkdir(path.join(root, REL_DIR), { recursive: true });
}

// True iff the given diagram file is readable. We use fs.access rather
// than fs.stat because we only care about existence, not metadata.
export async function diagramExists(root: string, filename: string = DEFAULT_DIAGRAM_FILE): Promise<boolean> {
  try {
    await fs.access(diagramPath(root, filename));
    return true;
  } catch {
    return false;
  }
}

// Lists the basenames of every `*.json` file under `.oxford/`, sorted.
// Used to populate the model picker dropdown so the user can switch
// between e.g. model.json and sequence.json without renaming on disk.
// Returns [] if the directory doesn't exist.
export async function listDiagramFiles(root: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(path.join(root, REL_DIR));
    return entries.filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
}

// Reads + parses a diagram file. Returns null on ANY failure — file
// missing, unreadable, or invalid JSON. Callers treat null as "no usable
// diagram" and surface their own message; we don't throw because most
// call sites (status bar, watcher rerender) have a sensible "no diagram"
// UX already.
export async function readDiagram(root: string, filename: string = DEFAULT_DIAGRAM_FILE): Promise<Diagram | null> {
  let raw: string;
  try {
    raw = await fs.readFile(diagramPath(root, filename), 'utf8');
  } catch {
    return null;
  }
  let diagram: Diagram;
  try {
    diagram = JSON.parse(raw) as Diagram;
  } catch {
    return null;
  }
  const layout = await readLayout(root);
  if (Object.keys(layout).length > 0) {
    diagram.layout = layout;
  }
  return diagram;
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

// SD2: queue-tail errors used to vanish silently. Surface them via an
// optional console.error so an unexpected disk-full / permission failure
// is at least visible in the extension host output channel.
function logQueueError(e: unknown): void {
  try {
    // eslint-disable-next-line no-console
    console.error('[little-oxford] storage write failed:', (e as Error)?.message ?? e);
  } catch { /* logger itself never throws */ }
}

export function mutateDiagram(
  root: string,
  fn: (d: Diagram) => void,
  filename: string = DEFAULT_DIAGRAM_FILE,
): Promise<void> {
  const job = writeQueue.then(async () => {
    const diagram = await readDiagram(root, filename);
    if (!diagram) return;
    fn(diagram);
    gcOrphans(diagram);
    const { layout: _strip, ...rest } = diagram;
    await writeFileAtomic(
      diagramPath(root, filename),
      JSON.stringify(filename === DEFAULT_DIAGRAM_FILE ? rest : diagram, null, 2) + '\n',
    );
  });
  writeQueue = job.catch(logQueueError);
  return job;
}

// Strip layout / override entries that point at components which no longer
// exist. Without this, deleting a component would leave dead entries in
// `layout.components` and `overrides` forever — small files, but they
// confuse diff review and slowly accrete junk.
function gcOrphans(d: Diagram): void {
  const ids = new Set(Object.keys(d.components));
  if (d.overrides) {
    for (const id of Object.keys(d.overrides)) {
      if (!ids.has(id)) delete d.overrides[id];
    }
  }
}

function gcLayoutOrphans(layout: Layout, ids: Set<string>): void {
  if (!layout.components) return;
  for (const id of Object.keys(layout.components)) {
    if (!ids.has(id)) delete layout.components[id];
  }
}

let layoutQueue: Promise<void> = Promise.resolve();

export function mutateLayout(
  root: string,
  fn: (layout: Layout) => void,
  componentIds?: Set<string>,
): Promise<void> {
  const job = layoutQueue.then(async () => {
    const layout = await readLayout(root);
    fn(layout);
    if (componentIds) gcLayoutOrphans(layout, componentIds);
    await writeLayout(root, layout);
  });
  layoutQueue = job.catch(logQueueError);
  return job;
}
