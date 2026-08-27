import { describe, expect, it } from 'vitest';
import { loadConfig, assertLockedWorkspace } from '../src/config.js';
import {
  pickQuotaForOrganization,
  RequestQueue,
} from '../src/rate-limiter.js';
import { resolveDateRange, toTogglApiRange, chunkIds } from '../src/dates.js';

describe('loadConfig', () => {
  it('requires API key and workspace id', () => {
    expect(() => loadConfig({})).toThrow(/TOGGL_API_KEY/);
    expect(() => loadConfig({ TOGGL_API_KEY: 'tok' })).toThrow(
      /TOGGL_DEFAULT_WORKSPACE_ID/
    );
    expect(
      loadConfig({
        TOGGL_API_KEY: ' tok ',
        TOGGL_DEFAULT_WORKSPACE_ID: '300001',
      })
    ).toEqual({ apiKey: 'tok', workspaceId: 300001 });
  });

  it('rejects foreign workspace ids', () => {
    expect(() => assertLockedWorkspace(300001, 999)).toThrow(/not allowed/);
    expect(() => assertLockedWorkspace(300001, '300001')).not.toThrow();
    expect(() => assertLockedWorkspace(300001, undefined)).not.toThrow();
  });
});

describe('dates', () => {
  it('resolves today and yesterday in local calendar dates', () => {
    const now = new Date(2026, 7, 25, 15, 30, 0);
    expect(resolveDateRange({ period: 'today', now })).toEqual({
      start_date: '2026-08-25',
      end_date: '2026-08-25',
    });
    expect(resolveDateRange({ period: 'yesterday', now })).toEqual({
      start_date: '2026-08-24',
      end_date: '2026-08-24',
    });
  });

  it('rejects period combined with explicit dates', () => {
    expect(() =>
      resolveDateRange({
        period: 'today',
        start_date: '2026-08-01',
        end_date: '2026-08-02',
      })
    ).toThrow(/not both/);
  });

  it('rejects a date-only end before start', () => {
    expect(() =>
      resolveDateRange({
        start_date: '2026-08-25',
        end_date: '2026-08-24',
      })
    ).toThrow(/on or after start_date/);
  });

  it('keeps inclusive date-only ranges as given', () => {
    expect(
      resolveDateRange({
        start_date: '2026-08-24',
        end_date: '2026-08-24',
      })
    ).toEqual({
      start_date: '2026-08-24',
      end_date: '2026-08-24',
    });
    expect(
      resolveDateRange({
        start_date: '2026-08-24',
        end_date: '2026-08-25',
      })
    ).toEqual({
      start_date: '2026-08-24',
      end_date: '2026-08-25',
    });
  });

  it('bumps a date-only end_date by one day for Toggl', () => {
    expect(
      toTogglApiRange({
        start_date: '2026-08-24',
        end_date: '2026-08-24',
      })
    ).toEqual({
      start_date: '2026-08-24',
      end_date: '2026-08-25',
    });
    expect(
      toTogglApiRange({
        start_date: '2026-08-24',
        end_date: '2026-08-25',
      })
    ).toEqual({
      start_date: '2026-08-24',
      end_date: '2026-08-26',
    });
  });

  it('maps period today to a one-day Toggl window', () => {
    const now = new Date(2026, 7, 25, 15, 30, 0);
    expect(toTogglApiRange(resolveDateRange({ period: 'today', now }))).toEqual({
      start_date: '2026-08-25',
      end_date: '2026-08-26',
    });
  });

  it('leaves RFC3339 end_date unchanged for Toggl', () => {
    expect(
      toTogglApiRange({
        start_date: '2026-08-24T00:00:00Z',
        end_date: '2026-08-24T23:59:59Z',
      })
    ).toEqual({
      start_date: '2026-08-24T00:00:00Z',
      end_date: '2026-08-24T23:59:59Z',
    });
  });

  it('chunks ids by size', () => {
    expect(chunkIds([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('RequestQueue', () => {
  it('picks organization quota row', () => {
    const snapshot = pickQuotaForOrganization(
      [
        {
          organization_id: 100001,
          remaining: 600,
          total: 600,
          resets_in_secs: 3600,
        },
        {
          organization_id: null,
          remaining: 30,
          total: 30,
          resets_in_secs: 3600,
        },
      ],
      100001
    );
    expect(snapshot.total).toBe(600);
    expect(snapshot.organizationId).toBe(100001);
  });

  it('enforces 50% hourly budget with total 10', async () => {
    let now = 0;
    const queue = new RequestQueue({
      minIntervalMs: 0,
      maxWaitMs: 5_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    queue.setQuota({
      organizationId: 1,
      total: 10,
      remaining: 10,
      resetsInSecs: 100,
    });
    // reservedFloor = 5; allow while remaining > 5
    for (let i = 0; i < 5; i++) {
      await queue.schedule(async () => {
        const q = queue.getQuota()!;
        q.remaining -= 1;
        queue.setQuota(q);
      });
    }
    expect(queue.getQuota()?.remaining).toBe(5);

    await expect(queue.schedule(async () => 'nope')).rejects.toMatchObject({
      code: 'QUOTA_BUDGET',
    });
  });

  it('spaces requests by minIntervalMs', async () => {
    let now = 1_000;
    const queue = new RequestQueue({
      minIntervalMs: 2_000,
      maxWaitMs: 10_000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    });
    queue.setQuota({
      organizationId: null,
      total: 100,
      remaining: 100,
      resetsInSecs: 3600,
    });

    await queue.schedule(async () => 'a');
    const afterFirst = now;
    await queue.schedule(async () => 'b');
    expect(now - afterFirst).toBeGreaterThanOrEqual(2_000);
  });

  it('updates remaining from response headers', () => {
    const queue = new RequestQueue({ minIntervalMs: 0 });
    queue.setQuota({
      organizationId: 1,
      total: 600,
      remaining: 600,
      resetsInSecs: 3600,
    });
    queue.updateFromHeaders(
      new Headers({
        'x-toggl-quota-remaining': '598',
        'x-toggl-quota-resets-in': '3599',
      })
    );
    expect(queue.getQuota()).toMatchObject({
      remaining: 598,
      resetsInSecs: 3599,
    });
  });
});
