import { toUtcRfc3339, parseRfc3339 } from './intervals.js';
import type { PatchOp, TimeEntry } from './types.js';

/** Paths Toggl bulk PATCH cannot update (must use PUT). */
const PUT_ONLY_PATHS = new Set(['/start', '/stop', '/duration']);

export function requiresPutUpdate(ops: PatchOp[]): boolean {
  return ops.some((op) => PUT_ONLY_PATHS.has(op.path));
}

/**
 * Apply top-level RFC6902 ops to a time entry in memory.
 * start/stop strings are normalized to UTC Z for the PUT body.
 */
export function applyTimeEntryPatchOps(
  entry: TimeEntry,
  ops: PatchOp[]
): TimeEntry {
  const next: TimeEntry = { ...entry };

  for (const op of ops) {
    if (!op.path.startsWith('/') || op.path.slice(1).includes('/')) {
      throw new Error(`Unsupported patch path for PUT fallback: ${op.path}`);
    }
    const key = op.path.slice(1) as keyof TimeEntry;

    if (op.op === 'remove') {
      if (key === 'start' || key === 'id' || key === 'workspace_id') {
        throw new Error(`Cannot remove required field ${op.path}`);
      }
      (next as Record<string, unknown>)[key] = null;
      continue;
    }

    let value = op.value;
    if ((key === 'start' || key === 'stop') && typeof value === 'string') {
      value = toUtcRfc3339(value);
    }
    (next as Record<string, unknown>)[key] = value;
  }

  reconcileDuration(next);
  return next;
}

function reconcileDuration(entry: TimeEntry): void {
  const start = entry.start;
  const stop = entry.stop;
  if (typeof start === 'string' && typeof stop === 'string' && stop !== '') {
    const startMs = parseRfc3339(start);
    const stopMs = parseRfc3339(stop);
    entry.duration = Math.round((stopMs - startMs) / 1000);
    entry.start = toUtcRfc3339(start);
    entry.stop = toUtcRfc3339(stop);
    return;
  }
  if (
    typeof start === 'string' &&
    typeof entry.duration === 'number' &&
    entry.duration >= 0
  ) {
    entry.start = toUtcRfc3339(start);
    entry.stop = new Date(
      parseRfc3339(entry.start) + entry.duration * 1000
    ).toISOString();
  }
}

/** Body fields Toggl PUT accepts for an existing entry. */
export function putBodyFromEntry(entry: TimeEntry, workspaceId: number): Record<string, unknown> {
  const body: Record<string, unknown> = {
    workspace_id: workspaceId,
    description: entry.description ?? null,
    project_id: entry.project_id ?? null,
    task_id: entry.task_id ?? null,
    billable: entry.billable ?? false,
    start: toUtcRfc3339(entry.start),
    duration: entry.duration,
  };
  if (entry.stop != null && entry.stop !== '') {
    body.stop = toUtcRfc3339(entry.stop);
  } else {
    body.stop = null;
  }
  if (entry.tags !== undefined) body.tags = entry.tags;
  if (entry.tag_ids !== undefined) body.tag_ids = entry.tag_ids;
  return body;
}
