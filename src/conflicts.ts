import {
  intervalsOverlap,
  isExactDuplicate,
  normalizeCreateInput,
  normalizeExistingEntry,
  type ExistingNormalized,
  type ProposedEntry,
} from './intervals.js';
import type { CreateTimeEntryInput, TimeEntry } from './types.js';

export type ConflictPolicy = 'reject' | 'skip';

export type ItemStatus =
  | 'created'
  | 'duplicate'
  | 'conflict'
  | 'failed'
  | 'skipped'
  | 'not_attempted';

export type BulkCreateItemResult = {
  index: number;
  status: ItemStatus;
  entry?: TimeEntry;
  existing_entry_id?: number;
  conflicting_existing_ids?: number[];
  conflicting_input_indexes?: number[];
  start?: string;
  end?: string | null;
};

export function proposeEntries(inputs: CreateTimeEntryInput[]): ProposedEntry[] {
  return inputs.map((input, index) => ({
    index,
    input,
    ...normalizeCreateInput(input),
  }));
}

export function findWithinBatchIssues(proposed: ProposedEntry[]): {
  duplicatePairs: Array<[number, number]>;
  conflictPairs: Array<[number, number]>;
} {
  const duplicatePairs: Array<[number, number]> = [];
  const conflictPairs: Array<[number, number]> = [];

  for (let i = 0; i < proposed.length; i++) {
    for (let j = i + 1; j < proposed.length; j++) {
      const a = proposed[i]!;
      const b = proposed[j]!;
      if (isExactDuplicate(a, b)) {
        duplicatePairs.push([a.index, b.index]);
        continue;
      }
      if (intervalsOverlap(a.startMs, a.endMs, b.startMs, b.endMs)) {
        conflictPairs.push([a.index, b.index]);
      }
    }
  }

  return { duplicatePairs, conflictPairs };
}

export function classifyAgainstExisting(
  proposed: ProposedEntry[],
  existing: ExistingNormalized[]
): BulkCreateItemResult[] {
  return proposed.map((item) => {
    const duplicate = existing.find((other) => isExactDuplicate(item, other));
    if (duplicate) {
      return {
        index: item.index,
        status: 'duplicate' as const,
        existing_entry_id: duplicate.id,
        start: item.startIso,
        end: item.endIso,
      };
    }

    const overlapping = existing.filter((other) =>
      intervalsOverlap(item.startMs, item.endMs, other.startMs, other.endMs)
    );
    if (overlapping.length > 0) {
      return {
        index: item.index,
        status: 'conflict' as const,
        conflicting_existing_ids: overlapping.map((o) => o.id),
        start: item.startIso,
        end: item.endIso,
      };
    }

    return {
      index: item.index,
      status: 'not_attempted' as const,
      start: item.startIso,
      end: item.endIso,
    };
  });
}

export function applyWithinBatchConflicts(
  results: BulkCreateItemResult[],
  conflictPairs: Array<[number, number]>
): BulkCreateItemResult[] {
  const byIndex = new Map(results.map((r) => [r.index, { ...r }]));
  for (const [a, b] of conflictPairs) {
    for (const index of [a, b]) {
      const current = byIndex.get(index)!;
      if (current.status === 'duplicate') continue;
      const other = index === a ? b : a;
      const conflicting = new Set(current.conflicting_input_indexes ?? []);
      conflicting.add(other);
      byIndex.set(index, {
        ...current,
        status: 'conflict',
        conflicting_input_indexes: [...conflicting].sort((x, y) => x - y),
      });
    }
  }
  return results.map((r) => byIndex.get(r.index)!);
}

export function normalizeExistingList(entries: TimeEntry[]): ExistingNormalized[] {
  return entries.map(normalizeExistingEntry);
}

/**
 * Decide which proposed indexes are safe to POST under the given policy.
 * Within-batch exact duplicates always make the batch malformed.
 */
export function planCreates(args: {
  proposed: ProposedEntry[];
  existing: ExistingNormalized[];
  policy: ConflictPolicy;
}): {
  malformedBatchDuplicates: boolean;
  results: BulkCreateItemResult[];
  creatableIndexes: number[];
  hasConflicts: boolean;
} {
  const { duplicatePairs, conflictPairs } = findWithinBatchIssues(args.proposed);
  if (duplicatePairs.length > 0) {
    const results = args.proposed.map((item) => ({
      index: item.index,
      status: 'conflict' as const,
      conflicting_input_indexes: duplicatePairs
        .filter(([a, b]) => a === item.index || b === item.index)
        .flatMap(([a, b]) => (a === item.index ? [b] : [a])),
      start: item.startIso,
      end: item.endIso,
    }));
    return {
      malformedBatchDuplicates: true,
      results,
      creatableIndexes: [],
      hasConflicts: true,
    };
  }

  let results = classifyAgainstExisting(args.proposed, args.existing);
  results = applyWithinBatchConflicts(results, conflictPairs);
  const hasConflicts = results.some((r) => r.status === 'conflict');

  if (args.policy === 'reject' && hasConflicts) {
    return {
      malformedBatchDuplicates: false,
      results: results.map((r) =>
        r.status === 'not_attempted' ? { ...r, status: 'skipped' } : r
      ),
      creatableIndexes: [],
      hasConflicts: true,
    };
  }

  const creatableIndexes = results
    .filter((r) => r.status === 'not_attempted')
    .map((r) => r.index);

  return {
    malformedBatchDuplicates: false,
    results,
    creatableIndexes,
    hasConflicts,
  };
}
