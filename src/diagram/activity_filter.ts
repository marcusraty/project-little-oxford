// Filters an activity record to only entries for known component ids.
//
// activity.json and model.json are read independently in panel.ts rerender,
// so it's possible to see an activity entry for a component that has just
// been deleted from the diagram — the tooltip would then render against a
// component that no longer exists. Filtering at the boundary keeps the
// webview's view consistent with the snapshot of the diagram it was given.

import type { ActivityEntry } from './types';

export function filterActivityToComponents(
  activity: Record<string, ActivityEntry>,
  componentIds: Iterable<string>,
): Record<string, ActivityEntry> {
  const known = componentIds instanceof Set ? componentIds : new Set(componentIds);
  const out: Record<string, ActivityEntry> = {};
  for (const [id, entry] of Object.entries(activity)) {
    if (known.has(id)) out[id] = entry;
  }
  return out;
}
