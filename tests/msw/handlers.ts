import { http, HttpResponse } from 'msw';

export const API = 'https://api.track.toggl.com/api/v9';

export const WORKSPACE_ID = 300001;
export const ORGANIZATION_ID = 100001;

export type RecordedRequest = {
  method: string;
  pathname: string;
  search: string;
  body: unknown;
};

export function createRecorder() {
  const requests: RecordedRequest[] = [];
  return {
    requests,
    record(request: Request, body: unknown = undefined) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        pathname: url.pathname.replace(/^\/api\/v9/, '') || url.pathname,
        search: url.search,
        body,
      });
    },
  };
}

export function defaultHandlers(recorder?: ReturnType<typeof createRecorder>) {
  return [
    http.get(`${API}/me/quota`, ({ request }) => {
      recorder?.record(request);
      return HttpResponse.json([
        {
          organization_id: ORGANIZATION_ID,
          remaining: 10,
          total: 10,
          resets_in_secs: 3600,
        },
        {
          organization_id: null,
          remaining: 10,
          total: 10,
          resets_in_secs: 3600,
        },
      ]);
    }),

    http.get(`${API}/workspaces/${WORKSPACE_ID}`, ({ request }) => {
      recorder?.record(request);
      return HttpResponse.json(
        {
          id: WORKSPACE_ID,
          name: 'Example Workspace',
          organization_id: ORGANIZATION_ID,
        },
        {
          headers: {
            'x-toggl-quota-remaining': '9',
            'x-toggl-quota-resets-in': '3600',
          },
        }
      );
    }),

    http.get(`${API}/me/time_entries`, ({ request }) => {
      recorder?.record(request);
      return HttpResponse.json(
        [
          {
            id: 400001,
            workspace_id: WORKSPACE_ID,
            project_id: 500001,
            project_name: 'Example Project',
            description: '#1234 Example',
            billable: false,
            tags: [],
            tag_ids: [],
            start: '2026-08-24T11:18:02+00:00',
            stop: '2026-08-24T11:29:44+00:00',
            duration: 702,
          },
          {
            id: 400099,
            workspace_id: 999999,
            description: 'Other workspace',
            start: '2026-08-24T12:00:00+00:00',
            stop: '2026-08-24T13:00:00+00:00',
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

    http.get(`${API}/workspaces/${WORKSPACE_ID}/projects`, ({ request }) => {
      recorder?.record(request);
      const url = new URL(request.url);
      const page = Number(url.searchParams.get('page') ?? '1');
      if (page > 1) {
        return HttpResponse.json([], {
          headers: {
            'x-toggl-quota-remaining': '7',
            'x-toggl-quota-resets-in': '3598',
          },
        });
      }
      return HttpResponse.json(
        [
          {
            id: 500001,
            name: 'Example Project',
            active: true,
            billable: true,
            workspace_id: WORKSPACE_ID,
            client_id: null,
          },
        ],
        {
          headers: {
            'x-toggl-quota-remaining': '7',
            'x-toggl-quota-resets-in': '3598',
          },
        }
      );
    }),

    http.post(`${API}/workspaces/${WORKSPACE_ID}/time_entries`, async ({ request }) => {
      const body = await request.json();
      recorder?.record(request, body);
      const payload = body as Record<string, unknown>;
      return HttpResponse.json(
        {
          id: 400002,
          workspace_id: WORKSPACE_ID,
          ...payload,
          duration:
            typeof payload.duration === 'number'
              ? payload.duration
              : 5400,
        },
        {
          headers: {
            'x-toggl-quota-remaining': '6',
            'x-toggl-quota-resets-in': '3590',
          },
        }
      );
    }),

    http.patch(
      `${API}/workspaces/${WORKSPACE_ID}/time_entries/:ids`,
      async ({ request, params }) => {
        const body = await request.json();
        recorder?.record(request, body);
        const ids = String(params.ids)
          .split(',')
          .map((id) => Number.parseInt(id, 10));
        return HttpResponse.json(
          { success: ids, failure: [] },
          {
            headers: {
              'x-toggl-quota-remaining': '5',
              'x-toggl-quota-resets-in': '3588',
            },
          }
        );
      }
    ),

    http.delete(
      `${API}/workspaces/${WORKSPACE_ID}/time_entries/:id`,
      ({ request }) => {
        recorder?.record(request);
        return new HttpResponse(null, {
          status: 200,
          headers: {
            'x-toggl-quota-remaining': '4',
            'x-toggl-quota-resets-in': '3585',
          },
        });
      }
    ),
  ];
}
