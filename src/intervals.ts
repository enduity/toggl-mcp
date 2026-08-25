import type { CreateTimeEntryInput, TimeEntry } from './types.js';

/** Assumed max length of a completed Toggl entry for lookback fetches. */
export const MAX_COMPLETED_ENTRY_MS = 24 * 60 * 60 * 1000;

const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})(\.\d+)?$/i;

export type NormalizedInterval = {
  /** Exact start instant (ms). */
  startMs: number;
  /** Exact exclusive end. Infinity for running entries. */
  endMs: number;
  /** Minute-floored start used for overlap/duplicate checks. */
  compareStartMs: number;
  /** Minute-floored exclusive end used for overlap/duplicate checks. */
  compareEndMs: number;
  startIso: string;
  endIso: string | null;
  contentKey: string;
};

export type ProposedEntry = NormalizedInterval & {
  index: number;
  input: CreateTimeEntryInput;
};

export type ExistingNormalized = NormalizedInterval & {
  id: number;
};

export function parseRfc3339(value: string): number {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error('Timestamp must be a non-empty RFC3339 string');
  }
  if (!HAS_OFFSET.test(trimmed)) {
    throw new Error(
      `Timestamp must include Z or an explicit offset (RFC3339): ${value}`
    );
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) {
    throw new Error(`Invalid RFC3339 timestamp: ${value}`);
  }
  return ms;
}

export function toUtcYmd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcYmdPlusDays(ymd: string, days: number): string {
  const date = new Date(`${ymd}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function sortedUniqueStrings(values: string[] | null | undefined): string[] {
  return [...new Set(values ?? [])].sort();
}

function sortedUniqueNumbers(values: number[] | null | undefined): number[] {
  return [...new Set(values ?? [])].sort((a, b) => a - b);
}

export function contentKeyFromFields(fields: {
  description?: string | null;
  project_id?: number | null;
  task_id?: number | null;
  billable?: boolean | null;
  tags?: string[] | null;
  tag_ids?: number[] | null;
}): string {
  return JSON.stringify({
    description: fields.description ?? '',
    project_id: fields.project_id ?? null,
    task_id: fields.task_id ?? null,
    billable: fields.billable ?? false,
    tags: sortedUniqueStrings(fields.tags),
    tag_ids: sortedUniqueNumbers(fields.tag_ids),
  });
}

/** Half-open [start, end). Touching endpoints do not overlap. */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Floor an instant to the UTC minute for conflict checks. */
export function floorToMinute(ms: number): number {
  if (!Number.isFinite(ms)) return ms;
  return Math.floor(ms / 60_000) * 60_000;
}

function comparisonBounds(startMs: number, endMs: number): {
  compareStartMs: number;
  compareEndMs: number;
} {
  return {
    compareStartMs: floorToMinute(startMs),
    compareEndMs: Number.isFinite(endMs) ? floorToMinute(endMs) : endMs,
  };
}

export function normalizeCreateInput(input: CreateTimeEntryInput): NormalizedInterval {
  const startMs = parseRfc3339(input.start);

  if (input.stop !== undefined && input.stop.trim() === '') {
    throw new Error('stop must not be an empty string');
  }

  const hasStop = input.stop !== undefined && input.stop !== null;
  const hasDuration = input.duration !== undefined && input.duration !== null;

  if (!hasStop && !hasDuration) {
    throw new Error('Each entry needs stop or a non-negative duration');
  }

  if (hasDuration && input.duration! < 0) {
    throw new Error('duration must be non-negative for create (no running timers)');
  }

  let endMs: number;
  if (hasStop) {
    endMs = parseRfc3339(input.stop!);
    if (hasDuration) {
      const expected = startMs + input.duration! * 1000;
      if (expected !== endMs) {
        throw new Error(
          `start + duration must equal stop (got duration ${input.duration}s)`
        );
      }
    }
  } else {
    endMs = startMs + input.duration! * 1000;
  }

  if (endMs <= startMs) {
    throw new Error('Entry duration must be positive (end must be after start)');
  }

  if (endMs - startMs > MAX_COMPLETED_ENTRY_MS) {
    throw new Error(
      `Completed entries longer than ${MAX_COMPLETED_ENTRY_MS / 3600000}h are not supported for conflict checks`
    );
  }

  return {
    startMs,
    endMs,
    ...comparisonBounds(startMs, endMs),
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    contentKey: contentKeyFromFields(input),
  };
}

export function normalizeExistingEntry(entry: TimeEntry): ExistingNormalized {
  const startMs = parseRfc3339(entry.start);
  const running = entry.duration < 0 || entry.stop == null || entry.stop === '';
  let endMs: number;
  let endIso: string | null;

  if (running) {
    endMs = Number.POSITIVE_INFINITY;
    endIso = null;
  } else {
    endMs = parseRfc3339(entry.stop!);
    if (endMs <= startMs) {
      // Degenerate existing rows: treat as zero-width so they never overlap.
      endMs = startMs;
    }
    endIso = new Date(endMs).toISOString();
  }

  return {
    id: entry.id,
    startMs,
    endMs,
    ...comparisonBounds(startMs, endMs),
    startIso: new Date(startMs).toISOString(),
    endIso,
    contentKey: contentKeyFromFields(entry),
  };
}

export function isExactDuplicate(
  a: NormalizedInterval,
  b: NormalizedInterval
): boolean {
  return (
    a.compareStartMs === b.compareStartMs &&
    a.compareEndMs === b.compareEndMs &&
    a.contentKey === b.contentKey
  );
}

export function entriesOverlap(
  a: NormalizedInterval,
  b: NormalizedInterval
): boolean {
  return intervalsOverlap(
    a.compareStartMs,
    a.compareEndMs,
    b.compareStartMs,
    b.compareEndMs
  );
}

export function fetchWindowForProposed(proposed: NormalizedInterval[]): {
  start_date: string;
  end_date: string;
} {
  if (proposed.length === 0) {
    throw new Error('No proposed entries');
  }
  const earliest = Math.min(...proposed.map((p) => p.startMs));
  const latest = Math.max(...proposed.map((p) => p.endMs));
  return {
    start_date: toUtcYmd(earliest - MAX_COMPLETED_ENTRY_MS),
    end_date: utcYmdPlusDays(toUtcYmd(latest), 1),
  };
}
