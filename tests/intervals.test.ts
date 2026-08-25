import { describe, expect, it } from 'vitest';
import {
  applyWithinBatchConflicts,
  classifyAgainstExisting,
  findWithinBatchIssues,
  planCreates,
  proposeEntries,
} from '../src/conflicts.js';
import {
  fetchWindowForProposed,
  entriesOverlap,
  intervalsOverlap,
  normalizeCreateInput,
  normalizeExistingEntry,
  parseRfc3339,
} from '../src/intervals.js';

describe('intervals', () => {
  it('requires RFC3339 offsets', () => {
    expect(() => parseRfc3339('2026-08-24T09:00:00')).toThrow(/offset/);
    expect(parseRfc3339('2026-08-24T09:00:00Z')).toBe(
      Date.parse('2026-08-24T09:00:00.000Z')
    );
  });

  it('treats touching endpoints as non-overlapping', () => {
    expect(intervalsOverlap(0, 10, 10, 20)).toBe(false);
    expect(intervalsOverlap(0, 10, 9, 20)).toBe(true);
  });

  it('compares conflicts at minute precision', () => {
    const first = normalizeCreateInput({
      start: '2026-08-24T10:00:00Z',
      stop: '2026-08-24T11:00:17Z',
      description: 'A',
    });
    const second = normalizeCreateInput({
      start: '2026-08-24T11:00:00Z',
      stop: '2026-08-24T11:35:00Z',
      description: 'B',
    });
    expect(first.compareEndMs).toBe(Date.parse('2026-08-24T11:00:00.000Z'));
    expect(second.compareStartMs).toBe(Date.parse('2026-08-24T11:00:00.000Z'));
    expect(entriesOverlap(first, second)).toBe(false);

    const overlapping = normalizeCreateInput({
      start: '2026-08-24T10:59:00Z',
      stop: '2026-08-24T11:30:00Z',
      description: 'C',
    });
    expect(entriesOverlap(first, overlapping)).toBe(true);
  });

  it('normalizes create input and rejects open-ended entries', () => {
    const normalized = normalizeCreateInput({
      start: '2026-08-24T09:00:00Z',
      stop: '2026-08-24T10:00:00Z',
      description: 'A',
    });
    expect(normalized.endMs - normalized.startMs).toBe(3600_000);

    expect(() =>
      normalizeCreateInput({ start: '2026-08-24T09:00:00Z' })
    ).toThrow(/stop or a non-negative duration/);

    expect(() =>
      normalizeCreateInput({
        start: '2026-08-24T09:00:00Z',
        stop: '2026-08-24T10:00:00Z',
        duration: 100,
      })
    ).toThrow(/start \+ duration must equal stop/);
  });

  it('builds a 24h lookback fetch window', () => {
    const proposed = [
      normalizeCreateInput({
        start: '2026-08-24T09:00:00Z',
        stop: '2026-08-24T10:00:00Z',
      }),
    ];
    expect(fetchWindowForProposed(proposed)).toEqual({
      start_date: '2026-08-23',
      end_date: '2026-08-25',
    });
  });

  it('treats running existing entries as open-ended', () => {
    const running = normalizeExistingEntry({
      id: 1,
      workspace_id: 1,
      start: '2026-08-24T08:00:00Z',
      stop: null,
      duration: -1,
    });
    expect(running.endMs).toBe(Number.POSITIVE_INFINITY);
    expect(
      entriesOverlap(
        normalizeCreateInput({
          start: '2026-08-24T09:00:00Z',
          stop: '2026-08-24T10:00:00Z',
        }),
        running
      )
    ).toBe(true);
  });
});

describe('conflicts', () => {
  it('detects within-batch overlaps and duplicates', () => {
    const proposed = proposeEntries([
      {
        start: '2026-08-24T09:00:00Z',
        stop: '2026-08-24T10:00:00Z',
        description: 'A',
      },
      {
        start: '2026-08-24T09:30:00Z',
        stop: '2026-08-24T10:30:00Z',
        description: 'B',
      },
      {
        start: '2026-08-24T09:00:00Z',
        stop: '2026-08-24T10:00:00Z',
        description: 'A',
      },
    ]);
    const { conflictPairs, duplicatePairs } = findWithinBatchIssues(proposed);
    expect(duplicatePairs).toEqual([[0, 2]]);
    expect(conflictPairs).toEqual([[0, 1], [1, 2]]);
  });

  it('classifies existing duplicates vs conflicts', () => {
    const proposed = proposeEntries([
      {
        start: '2026-08-24T09:00:00Z',
        stop: '2026-08-24T10:00:00Z',
        description: 'A',
      },
      {
        start: '2026-08-24T10:00:00Z',
        stop: '2026-08-24T11:00:00Z',
        description: 'B',
      },
    ]);
    const existing = [
      normalizeExistingEntry({
        id: 10,
        workspace_id: 1,
        start: '2026-08-24T09:00:00Z',
        stop: '2026-08-24T10:00:00Z',
        duration: 3600,
        description: 'A',
      }),
      normalizeExistingEntry({
        id: 11,
        workspace_id: 1,
        start: '2026-08-24T10:30:00Z',
        stop: '2026-08-24T11:30:00Z',
        duration: 3600,
        description: 'Other',
      }),
    ];
    const classified = classifyAgainstExisting(proposed, existing);
    expect(classified[0]).toMatchObject({
      status: 'duplicate',
      existing_entry_id: 10,
    });
    expect(classified[1]).toMatchObject({
      status: 'conflict',
      conflicting_existing_ids: [11],
    });
  });

  it('reject policy blocks creates when any conflict exists', () => {
    const proposed = proposeEntries([
      {
        start: '2026-08-24T09:00:00Z',
        stop: '2026-08-24T10:00:00Z',
        description: 'Safe',
      },
      {
        start: '2026-08-24T09:30:00Z',
        stop: '2026-08-24T10:30:00Z',
        description: 'Bad',
      },
    ]);
    const plan = planCreates({
      proposed,
      existing: [],
      policy: 'reject',
    });
    expect(plan.hasConflicts).toBe(true);
    expect(plan.creatableIndexes).toEqual([]);
  });

  it('skip policy creates only clean entries', () => {
    const proposed = proposeEntries([
      {
        start: '2026-08-24T09:00:00Z',
        stop: '2026-08-24T10:00:00Z',
        description: 'Safe',
      },
      {
        start: '2026-08-24T09:30:00Z',
        stop: '2026-08-24T10:30:00Z',
        description: 'Bad',
      },
      {
        start: '2026-08-24T11:00:00Z',
        stop: '2026-08-24T12:00:00Z',
        description: 'Also safe',
      },
    ]);
    const withBatch = applyWithinBatchConflicts(
      classifyAgainstExisting(proposed, []),
      findWithinBatchIssues(proposed).conflictPairs
    );
    expect(withBatch.filter((r) => r.status === 'conflict').map((r) => r.index)).toEqual([
      0, 1,
    ]);

    const plan = planCreates({
      proposed,
      existing: [],
      policy: 'skip',
    });
    expect(plan.creatableIndexes).toEqual([2]);
  });
});
