import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { ActivityEntry, Diagram } from './types';
import { writeFileAtomic } from '../audit/atomic_write';

const ACTIVITY_FILE = 'activity.json';

function activityPath(root: string): string {
  return path.join(root, '.oxford', ACTIVITY_FILE);
}

export async function readActivity(root: string): Promise<Record<string, ActivityEntry>> {
  try {
    const raw = await fsp.readFile(activityPath(root), 'utf8');
    return JSON.parse(raw) as Record<string, ActivityEntry>;
  } catch {
    return {};
  }
}

export async function writeActivity(root: string, data: Record<string, ActivityEntry>): Promise<void> {
  await writeFileAtomic(activityPath(root), JSON.stringify(data, null, 2) + '\n');
}

// Per-root write queues. Two updateActivity calls against the same workspace
// must serialize their read-modify-write so concurrent updates don't clobber
// each other. Two calls against different workspaces stay independent.
const activityQueues = new Map<string, Promise<void>>();

export function mutateActivity(
  root: string,
  fn: (a: Record<string, ActivityEntry>) => void,
): Promise<void> {
  const prev = activityQueues.get(root) ?? Promise.resolve();
  const job = prev.then(async () => {
    const activity = await readActivity(root);
    fn(activity);
    await writeActivity(root, activity);
  });
  activityQueues.set(root, job.catch((e) => {
    // SD2: surface queue-tail errors so a disk-full / permission failure
    // is visible instead of silently lost.
    // eslint-disable-next-line no-console
    try { console.error('[little-oxford] activity write failed:', (e as Error)?.message ?? e); } catch { /* */ }
  }));
  return job;
}

export function buildAnchorMap(diagram: Diagram): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [id, comp] of Object.entries(diagram.components)) {
    if (!comp.anchors) continue;
    for (const anchor of comp.anchors) {
      if (anchor.type !== 'file') continue;
      const val = anchor.value.startsWith('./') ? anchor.value.slice(2) : anchor.value;
      const existing = map.get(val);
      if (existing) existing.push(id);
      else map.set(val, [id]);
    }
  }
  return map;
}

export { timeAgo } from './time';

export function matchesFileAnchor(absolutePath: string, anchorValue: string): boolean {
  const anchor = anchorValue.startsWith('./') ? anchorValue.slice(2) : anchorValue;
  if (anchor.startsWith('/')) return absolutePath === anchor;
  return absolutePath.endsWith('/' + anchor);
}

export function checkOrphanActivity(
  componentIds: Set<string>,
  activity: Record<string, ActivityEntry>,
): Array<{ level: string; rule: string; message: string; path: string }> {
  const diags: Array<{ level: string; rule: string; message: string; path: string }> = [];
  for (const id of Object.keys(activity)) {
    if (!componentIds.has(id)) {
      diags.push({
        level: 'warning',
        rule: 'orphan-activity',
        message: `Activity entry for "${id}" has no matching component.`,
        path: `activity.${id}`,
      });
    }
  }
  return diags;
}

export function computeStaleness(entry: ActivityEntry): 'fresh' | 'stale' | 'unknown' {
  if (!entry.last_read && !entry.last_model_update) return 'unknown';
  if (entry.last_model_update) {
    if (entry.last_model_update_verified === false) return 'stale';
    if (entry.last_edit && entry.last_edit > entry.last_model_update) return 'stale';
    return 'fresh';
  }
  if (!entry.last_edit) return 'fresh';
  return entry.last_edit > entry.last_read ? 'stale' : 'fresh';
}

export function diffModelComponents(
  oldModel: { components: Record<string, unknown> } | null | undefined,
  newModel: { components: Record<string, unknown> },
): string[] {
  const oldComps = oldModel?.components ?? {};
  const newComps = newModel.components ?? {};
  const changed: string[] = [];
  const allIds = new Set([...Object.keys(oldComps), ...Object.keys(newComps)]);
  for (const id of allIds) {
    if (!(id in oldComps) || !(id in newComps) || JSON.stringify(oldComps[id]) !== JSON.stringify(newComps[id])) {
      changed.push(id);
    }
  }
  return changed;
}

export async function updateActivity(
  root: string,
  anchorMap: Map<string, string[]>,
  touchedPaths: string[],
  timestamp: string,
  sessionId: string,
  toolName?: string,
): Promise<void> {
  const matched = new Set<string>();
  for (const tp of touchedPaths) {
    for (const [anchorSuffix, componentIds] of anchorMap) {
      if (matchesFileAnchor(tp, anchorSuffix)) {
        for (const id of componentIds) matched.add(id);
      }
    }
  }
  if (matched.size === 0) return;

  const isEdit = toolName === 'Edit' || toolName === 'Write';
  // All read-modify-write goes through `mutateActivity` so concurrent calls
  // from the audit pipeline / ActivitySink serialize per-root.
  await mutateActivity(root, (activity) => {
    for (const id of matched) {
      const existing = activity[id] ?? { last_read: '', last_read_session: '' };
      if (isEdit) {
        if (existing.last_edit && existing.last_edit >= timestamp) continue;
        activity[id] = { ...existing, last_edit: timestamp, last_edit_session: sessionId };
      } else {
        if (existing.last_read && existing.last_read >= timestamp) continue;
        activity[id] = { ...existing, last_read: timestamp, last_read_session: sessionId };
      }
    }
  });
}
