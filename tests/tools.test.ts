import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { RequestQueue } from '../src/rate-limiter.js';
import { TogglClient } from '../src/toggl-client.js';
import {
  handleAddTimeEntries,
  handleGetTimeEntries,
  handleListProjects,
  handleRemoveTimeEntry,
  handleUpdateTimeEntries,
} from '../src/tools/handlers.js';
import {
  API,
  WORKSPACE_ID,
  createRecorder,
  defaultHandlers,
} from './msw/handlers.js';
import { server } from './msw/server.js';

function testClient(recorder?: ReturnType<typeof createRecorder>) {
  if (recorder) {
    server.use(...defaultHandlers(recorder));
  }
  return new TogglClient({
    apiKey: 'test-token',
    workspaceId: WORKSPACE_ID,
    queue: new RequestQueue({ minIntervalMs: 0, maxWaitMs: 1_000 }),
  });
}

describe('TogglClient and tools via MSW', () => {
  it('filters time entries to the locked workspace and requests meta', async () => {
    const recorder = createRecorder();
    const client = testClient(recorder);
    const result = await handleGetTimeEntries(client, {
      start_date: '2026-08-18',
      end_date: '2026-08-25',
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.count).toBe(1);
    expect(payload.entries[0].id).toBe(400001);
    const listCall = recorder.requests.find((r) =>
      r.pathname.endsWith('/me/time_entries')
    );
    expect(listCall?.search).toContain('meta=true');
  });

  it('lists projects with one page request when a single page is returned', async () => {
    const recorder = createRecorder();
    const client = testClient(recorder);
    const result = await handleListProjects(client, {});
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.count).toBe(1);
    expect(payload.projects[0].name).toBe('Example Project');

    // bootstrap: workspace + quota, then projects page 1 + empty page 2
    const projectCalls = recorder.requests.filter((r) =>
      r.pathname.includes('/projects')
    );
    expect(projectCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('bulk add issues one POST per entry after empty preflight', async () => {
    const recorder = createRecorder();
    server.use(
      http.get(`${API}/me/time_entries`, ({ request }) => {
        recorder.record(request);
        return HttpResponse.json([], {
          headers: {
            'x-toggl-quota-remaining': '8',
            'x-toggl-quota-resets-in': '3599',
          },
        });
      }),
      ...defaultHandlers(recorder)
    );
    const client = new TogglClient({
      apiKey: 'test-token',
      workspaceId: WORKSPACE_ID,
      queue: new RequestQueue({ minIntervalMs: 0, maxWaitMs: 1_000 }),
    });
    const result = await handleAddTimeEntries(client, {
      entries: [
        {
          description: 'A',
          start: '2026-08-24T09:00:00Z',
          stop: '2026-08-24T10:00:00Z',
        },
        {
          description: 'B',
          start: '2026-08-24T10:00:00Z',
          stop: '2026-08-24T11:00:00Z',
        },
        {
          description: 'C',
          start: '2026-08-24T11:00:00Z',
          stop: '2026-08-24T12:00:00Z',
        },
      ],
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(result.isError).toBeFalsy();
    expect(payload.count).toBe(3);
    const posts = recorder.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(3);
    expect(posts[0]!.body).toMatchObject({
      created_with: 'toggl-mcp',
      workspace_id: WORKSPACE_ID,
      description: 'A',
    });
  });

  it('bulk add rejects overlaps with existing entries by default', async () => {
    const client = testClient();
    const result = await handleAddTimeEntries(client, {
      entries: [
        {
          description: 'Overlap',
          start: '2026-08-24T11:00:00Z',
          stop: '2026-08-24T12:00:00Z',
        },
      ],
    });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.code).toBe('TIME_ENTRY_CONFLICT');
    expect(payload.count).toBe(0);
    expect(payload.results[0]).toMatchObject({
      status: 'conflict',
      conflicting_existing_ids: [400001],
    });
  });

  it('bulk add skips exact existing duplicates and creates the rest', async () => {
    const recorder = createRecorder();
    server.use(
      http.get(`${API}/me/time_entries`, ({ request }) => {
        recorder.record(request);
        return HttpResponse.json(
          [
            {
              id: 400001,
              workspace_id: WORKSPACE_ID,
              description: 'A',
              billable: false,
              tags: [],
              tag_ids: [],
              start: '2026-08-24T09:00:00Z',
              stop: '2026-08-24T10:00:00Z',
              duration: 3600,
            },
          ],
          {
            headers: {
              'x-toggl-quota-remaining': '8',
              'x-toggl-quota-resets-in': '3599',
            },
          }
        );
      }),
      ...defaultHandlers(recorder)
    );
    const client = new TogglClient({
      apiKey: 'test-token',
      workspaceId: WORKSPACE_ID,
      queue: new RequestQueue({ minIntervalMs: 0, maxWaitMs: 1_000 }),
    });
    const result = await handleAddTimeEntries(client, {
      entries: [
        {
          description: 'A',
          start: '2026-08-24T09:00:00Z',
          stop: '2026-08-24T10:00:00Z',
        },
        {
          description: 'B',
          start: '2026-08-24T10:00:00Z',
          stop: '2026-08-24T11:00:00Z',
        },
      ],
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(result.isError).toBeFalsy();
    expect(payload.count).toBe(1);
    expect(payload.results[0].status).toBe('duplicate');
    expect(payload.results[1].status).toBe('created');
    expect(recorder.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('bulk add returns created entries when a later POST fails', async () => {
    let postCount = 0;
    server.use(
      http.get(`${API}/me/time_entries`, () => HttpResponse.json([])),
      http.get(`${API}/me/time_entries/current`, () => HttpResponse.json(null)),
      http.post(`${API}/workspaces/${WORKSPACE_ID}/time_entries`, async () => {
        postCount += 1;
        if (postCount >= 2) {
          return HttpResponse.text('quota will reset in 60 seconds', {
            status: 402,
          });
        }
        return HttpResponse.json({
          id: 400010,
          workspace_id: WORKSPACE_ID,
          description: 'A',
          start: '2026-08-24T09:00:00Z',
          stop: '2026-08-24T10:00:00Z',
          duration: 3600,
        });
      })
    );

    const client = testClient();
    const result = await handleAddTimeEntries(client, {
      entries: [
        {
          description: 'A',
          start: '2026-08-24T09:00:00Z',
          stop: '2026-08-24T10:00:00Z',
        },
        {
          description: 'B',
          start: '2026-08-24T10:00:00Z',
          stop: '2026-08-24T11:00:00Z',
        },
        {
          description: 'C',
          start: '2026-08-24T11:00:00Z',
          stop: '2026-08-24T12:00:00Z',
        },
      ],
    });

    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.partial).toBe(true);
    expect(payload.count).toBe(1);
    expect(payload.entries[0].id).toBe(400010);
    expect(payload.failed_at_index).toBe(1);
    expect(payload.error).toMatchObject({
      status: 402,
      code: 'TOGGL_QUOTA_LIMIT',
    });
  });

  it('bulk edit issues one PATCH for two ids', async () => {
    const recorder = createRecorder();
    const client = testClient(recorder);
    const result = await handleUpdateTimeEntries(client, {
      time_entry_ids: [400001, 400002],
      operations: [{ op: 'replace', path: '/billable', value: true }],
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.success).toEqual([400001, 400002]);
    const patches = recorder.requests.filter((r) => r.method === 'PATCH');
    expect(patches).toHaveLength(1);
    expect(patches[0]!.pathname).toContain('/time_entries/400001,400002');
  });

  it('POSTs create payloads with UTC start/stop', async () => {
    const recorder = createRecorder();
    server.use(
      http.get(`${API}/me/time_entries`, ({ request }) => {
        recorder.record(request);
        return HttpResponse.json([], {
          headers: {
            'x-toggl-quota-remaining': '8',
            'x-toggl-quota-resets-in': '3599',
          },
        });
      }),
      ...defaultHandlers(recorder)
    );
    const client = new TogglClient({
      apiKey: 'test-token',
      workspaceId: WORKSPACE_ID,
      queue: new RequestQueue({ minIntervalMs: 0, maxWaitMs: 1_000 }),
    });
    const result = await handleAddTimeEntries(client, {
      entries: [
        {
          description: 'Offset',
          start: '2026-08-24T12:00:00+03:00',
          stop: '2026-08-24T13:00:00+03:00',
        },
      ],
    });
    expect(result.isError).toBeFalsy();
    const posts = recorder.requests.filter((r) => r.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toMatchObject({
      start: '2026-08-24T09:00:00.000Z',
      stop: '2026-08-24T10:00:00.000Z',
    });
  });

  it('deletes a single time entry', async () => {
    const recorder = createRecorder();
    const client = testClient(recorder);
    const result = await handleRemoveTimeEntry(client, {
      time_entry_id: 400002,
    });
    const payload = JSON.parse(result.content[0]!.text);
    expect(payload.deleted_id).toBe(400002);
    expect(recorder.requests.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('rejects wrong workspace_id with zero HTTP calls', async () => {
    const recorder = createRecorder();
    const client = testClient(recorder);
    await expect(
      handleListProjects(client, { workspace_id: 999 })
    ).rejects.toThrow(/not allowed/);
    expect(recorder.requests).toHaveLength(0);
  });

  it('maps 429 to a structured API error', async () => {
    server.use(
      http.get(`${API}/workspaces/${WORKSPACE_ID}`, () =>
        HttpResponse.json(
          { id: WORKSPACE_ID, organization_id: 100001 },
          {
            headers: {
              'x-toggl-quota-remaining': '9',
              'x-toggl-quota-resets-in': '3600',
            },
          }
        )
      ),
      http.get(`${API}/me/quota`, () =>
        HttpResponse.json([
          {
            organization_id: 100001,
            remaining: 10,
            total: 10,
            resets_in_secs: 3600,
          },
        ])
      ),
      http.get(`${API}/me/time_entries`, () =>
        HttpResponse.text('slow down', {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      )
    );

    const client = testClient();
    await expect(
      handleGetTimeEntries(client, {
        start_date: '2026-08-18',
        end_date: '2026-08-25',
      })
    ).rejects.toMatchObject({
      status: 429,
      code: 'RATE_LIMITED',
      retry_after_seconds: 30,
    });
  });

  it('maps 402 to a quota error', async () => {
    server.use(
      http.get(`${API}/workspaces/${WORKSPACE_ID}`, () =>
        HttpResponse.json({
          id: WORKSPACE_ID,
          organization_id: 100001,
        })
      ),
      http.get(`${API}/me/quota`, () =>
        HttpResponse.json([
          {
            organization_id: 100001,
            remaining: 10,
            total: 10,
            resets_in_secs: 3600,
          },
        ])
      ),
      http.get(`${API}/me/time_entries`, () =>
        HttpResponse.text('quota will reset in 120 seconds', { status: 402 })
      )
    );

    const client = testClient();
    await expect(
      handleGetTimeEntries(client, {
        start_date: '2026-08-18',
        end_date: '2026-08-25',
      })
    ).rejects.toMatchObject({
      status: 402,
      code: 'TOGGL_QUOTA_LIMIT',
      retry_after_seconds: 120,
    });
  });
});
