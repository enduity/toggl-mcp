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
 * Resolve period shortcuts or explicit dates to inclusive start / exclusive end
 * as YYYY-MM-DD for Toggl's start_date / end_date query params.
 * Toggl treats end_date as exclusive for date-only values.
 */
export function resolveDateRange(args: {
  period?: 'today' | 'yesterday';
  start_date?: string;
  end_date?: string;
  now?: Date;
}): { start_date: string; end_date: string } {
  const now = args.now ?? new Date();

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
      'Provide period ("today" | "yesterday") or both start_date and end_date (YYYY-MM-DD).'
    );
  }

  return { start_date: args.start_date, end_date: args.end_date };
}

export function chunkIds(ids: number[], size: number): number[][] {
  if (size <= 0) throw new Error('chunk size must be positive');
  const chunks: number[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}
