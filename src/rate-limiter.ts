export type QuotaSnapshot = {
  organizationId: number | null;
  total: number;
  remaining: number;
  resetsInSecs: number;
};

export type RateLimiterOptions = {
  /** Fraction of hourly quota to keep unused. Default 0.5. */
  reserveFraction?: number;
  /** Minimum milliseconds between requests. Default 2000 (50% of ~1 req/s). */
  minIntervalMs?: number;
  /** Max wait before failing an MCP turn. Default 120_000. */
  maxWaitMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

export class RateLimitError extends Error {
  readonly code: string;
  readonly retry_after_seconds?: number;

  constructor(message: string, retryAfterSeconds?: number, code = 'RATE_LIMITED') {
    super(message);
    this.name = 'RateLimitError';
    this.code = code;
    this.retry_after_seconds = retryAfterSeconds;
  }
}

/**
 * Serial request queue that stays under 50% of the hourly quota and
 * spaces requests by at least 2s (half of Toggl's ~1 req/s leaky bucket).
 */
export class RequestQueue {
  private readonly reserveFraction: number;
  private readonly minIntervalMs: number;
  private readonly maxWaitMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  private chain: Promise<unknown> = Promise.resolve();
  private lastRequestAt = 0;
  private quota: QuotaSnapshot | null = null;
  private bootstrapped = false;

  constructor(options: RateLimiterOptions = {}) {
    this.reserveFraction = options.reserveFraction ?? 0.5;
    this.minIntervalMs = options.minIntervalMs ?? 2000;
    this.maxWaitMs = options.maxWaitMs ?? 120_000;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  getQuota(): QuotaSnapshot | null {
    return this.quota ? { ...this.quota } : null;
  }

  setQuota(quota: QuotaSnapshot): void {
    this.quota = { ...quota };
    this.bootstrapped = true;
  }

  isBootstrapped(): boolean {
    return this.bootstrapped;
  }

  updateFromHeaders(headers: Headers): void {
    if (!this.quota) return;

    const remainingRaw = headers.get('x-toggl-quota-remaining');
    const resetsRaw = headers.get('x-toggl-quota-resets-in');

    if (remainingRaw !== null) {
      const remaining = Number.parseInt(remainingRaw, 10);
      if (Number.isFinite(remaining)) this.quota.remaining = remaining;
    }
    if (resetsRaw !== null) {
      const resetsInSecs = Number.parseInt(resetsRaw, 10);
      if (Number.isFinite(resetsInSecs)) this.quota.resetsInSecs = resetsInSecs;
    }
  }

  /** Floor of reserved remaining: we must keep remaining >= reservedFloor. */
  reservedFloor(): number {
    if (!this.quota) return 0;
    return Math.ceil(this.quota.total * this.reserveFraction);
  }

  async schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(() => this.runWhenReady(fn));
    this.chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async runWhenReady<T>(fn: () => Promise<T>): Promise<T> {
    await this.waitForBudget();
    this.lastRequestAt = this.now();
    return fn();
  }

  private async waitForBudget(): Promise<void> {
    const started = this.now();

    for (;;) {
      const spacingWait = Math.max(0, this.minIntervalMs - (this.now() - this.lastRequestAt));
      const quotaWait = this.quotaWaitMs();
      const waitMs = Math.max(spacingWait, quotaWait);

      if (waitMs <= 0) return;

      const elapsed = this.now() - started;
      if (elapsed + waitMs > this.maxWaitMs) {
        const retryAfterSeconds = Math.ceil((waitMs - Math.max(0, this.maxWaitMs - elapsed)) / 1000);
        throw new RateLimitError(
          `Would exceed the reserved ${this.reserveFraction * 100}% Toggl quota budget. Retry later.`,
          Math.max(1, retryAfterSeconds),
          'QUOTA_BUDGET'
        );
      }

      await this.sleep(waitMs);

      // After sleeping for a quota reset, restore remaining to total.
      if (quotaWait > 0 && this.quota) {
        this.quota.remaining = this.quota.total;
        this.quota.resetsInSecs = 3600;
      }
    }
  }

  private quotaWaitMs(): number {
    if (!this.quota) return 0;
    // After this request, remaining would be remaining-1. Keep remaining >= floor,
    // so allow only when remaining - 1 >= floor  => remaining > floor
    // i.e. remaining >= floor + 1
    if (this.quota.remaining > this.reservedFloor()) return 0;
    return Math.max(0, this.quota.resetsInSecs) * 1000;
  }
}

export function pickQuotaForOrganization(
  rows: Array<{
    organization_id: number | null;
    remaining: number;
    total: number;
    resets_in_secs: number;
  }>,
  organizationId: number | null
): QuotaSnapshot {
  const match =
    rows.find((row) => row.organization_id === organizationId) ??
    rows.find((row) => row.organization_id === null) ??
    rows[0];

  if (!match) {
    throw new Error('GET /me/quota returned no quota rows');
  }

  return {
    organizationId: match.organization_id,
    total: match.total,
    remaining: match.remaining,
    resetsInSecs: match.resets_in_secs,
  };
}
