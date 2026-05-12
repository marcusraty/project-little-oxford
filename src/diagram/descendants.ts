// Returns every descendant of `rootId` in the parent-child tree, depth-first.
// Used by the webview drag handler to find ALL components that should move
// when a container is dragged — previously this only looked at direct
// children, so grandchildren-and-deeper lagged behind during the drag.

export interface ComponentRef { parent: string | null }

export function collectDescendants(
  components: Record<string, ComponentRef>,
  rootId: string,
): string[] {
  const out: string[] = [];
  const childrenOf = new Map<string, string[]>();
  for (const [id, comp] of Object.entries(components)) {
    if (!comp.parent) continue;
    const arr = childrenOf.get(comp.parent) ?? [];
    arr.push(id);
    childrenOf.set(comp.parent, arr);
  }

  const stack = [...(childrenOf.get(rootId) ?? [])];
  const seen = new Set<string>([rootId]);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    const next = childrenOf.get(id);
    if (next) stack.push(...next);
  }
  return out;
}
