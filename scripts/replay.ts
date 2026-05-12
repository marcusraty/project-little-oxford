// Oxford — render-pipeline replay tool.
//
// Reads a model.json off disk and walks the layout pipeline one step at a
// time, dumping the intermediates to stdout. This is the diagnostic seam
// for "the box went somewhere I didn't expect": once the host log
// (drag.log) shows the input layout block that went into a render and the
// output layout block that came back, this script reproduces the
// renderer's behavior against that same input — locally, deterministic,
// no VS Code involved.
//
// Usage:
//   npm run replay -- path/to/model.json
//
// Exits 1 on missing file, missing argument, or invalid JSON.

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildElkGraph,
  runElk,
  readElkResult,
  emitSvg,
} from '../src/diagram/render';
import type { Diagram } from '../src/diagram/types';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: npm run replay -- <path/to/model.json>');
    process.exit(1);
  }
  const filePath = path.resolve(process.cwd(), arg);
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error(`could not read ${filePath}: ${(e as Error).message}`);
    process.exit(1);
  }
  let model: Diagram;
  try {
    model = JSON.parse(raw) as Diagram;
  } catch (e) {
    console.error(`invalid JSON in ${filePath}: ${(e as Error).message}`);
    process.exit(1);
  }

  section('input.layout', model.layout ?? null);

  const graph = buildElkGraph(model);
  section('elk.input', graph);

  const result = await runElk(graph);
  section('elk.output', stripCircular(result));

  const computed = readElkResult(result);
  section('readElkResult.absolute', computed.components);
  section('readElkResult.relative', computed.relative);
  section('readElkResult.canvas', {
    width: computed.canvasWidth,
    height: computed.canvasHeight,
  });

  // SVG isn't dumped by default — it's noisy and the bug under
  // investigation lives in coordinates, not in markup. Pass --svg to
  // include it.
  if (process.argv.includes('--svg')) {
    section('emitSvg', emitSvg(model, computed));
  }
}

function section(label: string, value: unknown): void {
  process.stdout.write(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}\n`);
  if (typeof value === 'string') {
    process.stdout.write(value + '\n');
  } else {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n');
  }
}

// elkjs may decorate its output with self-references via `$parent` (or
// similar) to support graph traversal. JSON.stringify chokes on cycles,
// so we strip anything that looks like a back-edge.
function stripCircular(value: unknown): unknown {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    const obj = v as Record<string, unknown>;
    if (seen.has(obj)) return '[circular]';
    seen.add(obj);
    if (Array.isArray(obj)) return obj.map(walk);
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(obj)) {
      if (k === '$parent' || k === 'parent') continue;
      out[k] = walk(val);
    }
    return out;
  };
  return walk(value);
}

void main();
