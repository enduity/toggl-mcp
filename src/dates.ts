/** Local calendar YYYY-MM-DD. */
export function toLocalYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function startOfLocalDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

export function addLocalDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Resolve period shortcuts or explicit dates to Toggl start_date / end_date.
 * Toggl treats date-only end_date as exclusive (start=D, end=D+1 covers day D).
 * If a date-only range has start_date === end_date (empty window), bump end by
 * one day so a single calendar day works without callers learning that.
 */
export function resolveDateRange(args: {
  period?: 'today' | 'yesterday';
  start_date?: string;
  end_date?: string;
  now?: Date;
}): {
  start_date: string;
  end_date: string;
  expandedZeroDayRange?: boolean;
} {
  const now = args.now ?? new Date();
  const hasExplicit =
    args.start_date !== undefined || args.end_date !== undefined;

  if (args.period && hasExplicit) {
    throw new Error(
      'Use either period ("today" | "yesterday") or start_date/end_date, not both.'
    );
  }

  if (args.period === 'today') {
    const start = startOfLocalDay(now);
    return {
      start_date: toLocalYmd(start),
      end_date: toLocalYmd(addLocalDays(start, 1)),
    };
  }

  if (args.period === 'yesterday') {
    const start = addLocalDays(startOfLocalDay(now), -1);
    return {
      start_date: toLocalYmd(start),
      end_date: toLocalYmd(addLocalDays(start, 1)),
    };
  }

  if (!args.start_date || !args.end_date) {
    throw new Error(
      'Provide period ("today" | "yesterday") or both start_date and end_date.'
    );
  }

  if (
    isDateOnly(args.start_date) &&
    isDateOnly(args.end_date) &&
    args.start_date === args.end_date
  ) {
    const [year, month, day] = args.end_date.split('-').map(Number);
    const end = new Date(year!, month! - 1, day!);
    return {
      start_date: args.start_date,
      end_date: toLocalYmd(addLocalDays(end, 1)),
      expandedZeroDayRange: true,
    };
  }

  return { start_date: args.start_date, end_date: args.end_date };
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function isDateOnly(value: string): boolean {
  return DATE_ONLY.test(value);
}

export function chunkIds(ids: number[], size: number): number[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}
