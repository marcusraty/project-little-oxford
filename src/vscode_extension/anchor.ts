// little-oxford — anchor resolution.
//
// Splits an anchor `value` (as authored in model.json — `"path"` or
// `"path:symbol"`) into a workspace-absolute path and an optional symbol
// name, and verifies the resolved path stays inside the workspace root.
//
// Lives in its own module — no `vscode` import, no fs — so the path-safety
// check is unit-testable in isolation. The caller (panel.ts) turns the
// returned absPath into a `vscode.Uri` and surfaces errors as a toast.
//
// Why containment matters: a model.json may come from a third party (clone
// someone's repo, open the diagram), and we do NOT want a hostile anchor
// like "../../../etc/hosts" to coax the editor into opening files outside
// the workspace just because the user clicked a box.

import * as path from 'node:path';

export type ResolvedAnchor =
  | { absPath: string; symbol?: string }
  | { error: string };

export function resolveAnchor(root: string, value: string): ResolvedAnchor {
  if (!value) return { error: 'empty anchor' };

  // Split on the FIRST colon. Anchor values look like "path" or
  // "path:symbol"; further colons (rare on POSIX, common on Windows drive
  // letters which we reject below as absolute) belong to the symbol half.
  const idx = value.indexOf(':');
  const relFile = idx === -1 ? value : value.slice(0, idx);
  const symbol = idx === -1 ? undefined : value.slice(idx + 1);

  // Resolve and verify containment. path.resolve normalizes ".." and
  // collapses "./" segments; an absolute input bypasses `root` entirely
  // and resolves to itself. The prefix check then catches both cases:
  // anything outside `root` won't share its prefix.
  const rootResolved = path.resolve(root);
  const abs = path.resolve(rootResolved, relFile);
  if (abs !== rootResolved && !abs.startsWith(rootResolved + path.sep)) {
    return { error: `anchor "${relFile}" resolves outside the workspace` };
  }

  return { absPath: abs, symbol };
}
