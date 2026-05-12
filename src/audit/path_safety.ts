import * as path from 'node:path';

// Returns true if `target` is `root` or a descendant of `root`.
// Uses path.resolve to normalize `..` segments before checking. Avoids the
// substring-prefix bug where `/foo/.oxford-evil` would match `/foo/.oxford`
// via a naive startsWith.
export function isPathWithin(target: string, root: string): boolean {
  const r = path.resolve(root);
  const t = path.resolve(target);
  if (t === r) return true;
  return t.startsWith(r + path.sep);
}
