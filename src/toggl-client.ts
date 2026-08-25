import {
  normalizeExistingList,
  planCreates,
  proposeEntries,
  type BulkCreateItemResult,
  type ConflictPolicy,
} from './conflicts.js';
import { chunkIds } from './dates.js';
import { fetchWindowForProposed, normalizeExistingEntry } from './intervals.js';
import {
  pickQuotaForOrganization,
  RequestQueue,
  type QuotaSnapshot,
} from './rate-limiter.js';
import type {
  BulkCreateResult,
  CreateTimeEntryInput,
  PatchOp,
  PatchOutput,
  Project,
  QuotaRow,
  TimeEntry,
  Workspace,
} from './types.js';
import { TogglApiError } from './types.js';

const BASE_URL = 'https://api.track.toggl.com/api/v9';
const CREATED_WITH = 'toggl-mcp';
const PROJECT_PAGE_SIZE = 200;
const PROJECT_CACHE_TTL_MS = 60 * 60 * 1000;

export type TogglClientOptions = {
  apiKey: string;
  workspaceId: number;
  queue?: RequestQueue;
  fetchImpl?: typeof fetch;
  now?: () => number;
};

type ProjectCache = {
  projects: Project[];
  expiresAt: number;
};

export class TogglClient {
  private readonly workspaceId: number;
  private readonly headers: Record<string, string>;
  private readonly queue: RequestQueue;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private organizationId: number | null | undefined;
  private projectCache: ProjectCache | null = null;

  constructor(options: TogglClientOptions) {
    this.workspaceId = options.workspaceId;
    this.queue = options.queue ?? new RequestQueue();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;

    const auth = Buffer.from(`${options.apiKey.trim()}:api_token`).toString('base64');
    this.headers = {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'toggl-mcp/0.1.0',
    };
  }

  getQueue(): RequestQueue {
    return this.queue;
  }

  getWorkspaceId(): number {
    return this.workspaceId;
  }

  async ensureQuota(): Promise<QuotaSnapshot> {
    if (this.queue.isBootstrapped()) {
      const existing = this.queue.getQuota();
      if (existing) return existing;
    }

    const workspace = await this.getWorkspace(this.workspaceId);
    this.organizationId = workspace.organization_id ?? null;

    const rows = await this.getQuotaRows();
    const snapshot = pickQuotaForOrganization(rows, this.organizationId);
    this.queue.setQuota(snapshot);
    return snapshot;
  }

  async getWorkspace(workspaceId: number): Promise<Workspace> {
    return this.request<Workspace>('GET', `/workspaces/${workspaceId}`);
  }

  async getQuotaRows(): Promise<QuotaRow[]> {
    return this.request<QuotaRow[]>('GET', '/me/quota');
  }

  async getTimeEntries(params: {
    start_date: string;
    end_date: string;
  }): Promise<TimeEntry[]> {
    await this.ensureQuota();
    const query = new URLSearchParams({
      start_date: params.start_date,
      end_date: params.end_date,
      meta: 'true',
    });
    const entries = await this.request<TimeEntry[]>(
      'GET',
      `/me/time_entries?${query.toString()}`
    );
    return entries.filter((entry) => entry.workspace_id === this.workspaceId);
  }

  async listProjects(): Promise<Project[]> {
    await this.ensureQuota();
    const cached = this.projectCache;
    if (cached && cached.expiresAt > this.now()) {
      return cached.projects;
    }

    const projects: Project[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request<Project[]>(
        'GET',
        `/workspaces/${this.workspaceId}/projects?per_page=${PROJECT_PAGE_SIZE}&page=${page}`
      );
      if (!Array.isArray(batch) || batch.length === 0) break;
      projects.push(...batch);
      if (batch.length < PROJECT_PAGE_SIZE) break;
    }

    this.projectCache = {
      projects,
      expiresAt: this.now() + PROJECT_CACHE_TTL_MS,
    };
    return projects;
  }

  clearProjectCache(): void {
    this.projectCache = null;
  }

  async getCurrentTimeEntry(): Promise<TimeEntry | null> {
    await this.ensureQuota();
    const result = await this.request<TimeEntry | null>(
      'GET',
      '/me/time_entries/current'
    );
    if (!result || result.workspace_id !== this.workspaceId) return null;
    return result;
  }

  async createTimeEntry(input: CreateTimeEntryInput): Promise<TimeEntry> {
    await this.ensureQuota();
    const body = {
      workspace_id: this.workspaceId,
      created_with: CREATED_WITH,
      ...input,
    };
    return this.request<TimeEntry>(
      'POST',
      `/workspaces/${this.workspaceId}/time_entries`,
      body
    );
  }

  async createTimeEntries(
    inputs: CreateTimeEntryInput[],
    options: { conflict_policy?: ConflictPolicy } = {}
  ): Promise<BulkCreateResult> {
    const policy = options.conflict_policy ?? 'reject';
    const proposed = proposeEntries(inputs);
    const window = fetchWindowForProposed(proposed);

    const listed = await this.getTimeEntries(window);
    const current = await this.getCurrentTimeEntry();

    const existingEntries = [...listed];
    if (current && !existingEntries.some((entry) => entry.id === current.id)) {
      existingEntries.push(current);
    }

    let existing = normalizeExistingList(existingEntries);
    const plan = planCreates({ proposed, existing, policy });

    if (plan.malformedBatchDuplicates) {
      return {
        entries: [],
        results: plan.results,
        conflict_policy: policy,
        code: 'TIME_ENTRY_BATCH_DUPLICATE',
        message:
          'Submitted batch contains duplicate entries. No entries were created.',
        error: {
          message:
            'Submitted batch contains duplicate entries. No entries were created.',
          code: 'TIME_ENTRY_BATCH_DUPLICATE',
        },
      };
    }

    if (policy === 'reject' && plan.hasConflicts) {
      return {
        entries: [],
        results: plan.results,
        conflict_policy: policy,
        code: 'TIME_ENTRY_CONFLICT',
        message: 'No entries were created due to overlapping time ranges.',
        error: {
          message: 'No entries were created due to overlapping time ranges.',
          code: 'TIME_ENTRY_CONFLICT',
        },
      };
    }

    const results: BulkCreateItemResult[] = plan.results.map((r) => ({ ...r }));
    const created: TimeEntry[] = [];
    const createdIndexes: number[] = [];

    for (const index of plan.creatableIndexes) {
      const item = proposed.find((p) => p.index === index)!;
      try {
        const entry = await this.createTimeEntry(item.input);
        created.push(entry);
        createdIndexes.push(index);
        results[index] = {
          index,
          status: 'created',
          entry,
          start: item.startIso,
          end: item.endIso,
        };
        existing = [...existing, normalizeExistingEntry(entry)];
      } catch (error) {
        results[index] = {
          index,
          status: 'failed',
          start: item.startIso,
          end: item.endIso,
        };
        for (const later of plan.creatableIndexes) {
          if (later > index && results[later]?.status === 'not_attempted') {
            results[later] = { ...results[later]!, status: 'not_attempted' };
          }
        }
        return {
          entries: created,
          results,
          conflict_policy: policy,
          failed_at_index: index,
          remaining_count: inputs.length - created.length,
          created_input_indexes: createdIndexes,
          duplicate_input_indexes: results
            .filter((r) => r.status === 'duplicate')
            .map((r) => r.index),
          not_attempted_input_indexes: results
            .filter((r) => r.status === 'not_attempted')
            .map((r) => r.index),
          error: serializeCaughtError(error),
        };
      }
    }

    return {
      entries: created,
      results,
      conflict_policy: policy,
      created_input_indexes: createdIndexes,
      duplicate_input_indexes: results
        .filter((r) => r.status === 'duplicate')
        .map((r) => r.index),
    };
  }

  async patchTimeEntries(ids: number[], ops: PatchOp[]): Promise<PatchOutput> {
    await this.ensureQuota();
    if (ids.length === 0) {
      return { success: [], failure: [] };
    }
    if (ids.length > 100) {
      throw new Error('PATCH supports at most 100 time entry IDs per request');
    }
    const path = `/workspaces/${this.workspaceId}/time_entries/${ids.join(',')}`;
    return this.request<PatchOutput>('PATCH', path, ops);
  }

  async updateTimeEntries(ids: number[], ops: PatchOp[]): Promise<PatchOutput> {
    const merged: PatchOutput = { success: [], failure: [] };
    for (const chunk of chunkIds(ids, 100)) {
      const result = await this.patchTimeEntries(chunk, ops);
      merged.success.push(...(result.success ?? []));
      merged.failure.push(...(result.failure ?? []));
    }
    return merged;
  }

  async deleteTimeEntry(timeEntryId: number): Promise<void> {
    await this.ensureQuota();
    await this.request<void>(
      'DELETE',
      `/workspaces/${this.workspaceId}/time_entries/${timeEntryId}`
    );
  }

  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    return this.queue.schedule(() => this.send<T>(method, endpoint, body));
  }

  private async send<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<T> {
    const response = await this.fetchImpl(`${BASE_URL}${endpoint}`, {
      method,
      headers: this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    this.queue.updateFromHeaders(response.headers);

    if (response.status === 429) {
      const retryAfter = parseRetryAfterSeconds(response.headers.get('Retry-After'));
      throw new TogglApiError({
        status: 429,
        code: 'RATE_LIMITED',
        message: 'Toggl API rate limit reached (HTTP 429).',
        retryAfterSeconds: retryAfter,
      });
    }

    if (response.status === 402) {
      const text = await response.text();
      const retryAfter =
        parseQuotaResetSeconds(text) ??
        parseRetryAfterSeconds(response.headers.get('x-toggl-quota-resets-in'));
      throw new TogglApiError({
        status: 402,
        code: 'TOGGL_QUOTA_LIMIT',
        message: `Toggl API hourly quota exhausted.${retryAfter !== undefined ? ` Resets in ${retryAfter}s.` : ''}`,
        retryAfterSeconds: retryAfter,
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new TogglApiError({
        status: response.status,
        code: response.status >= 500 ? 'TOGGL_SERVER_ERROR' : 'TOGGL_CLIENT_ERROR',
        message: `Toggl API error (${response.status}): ${text}`,
      });
    }

    if (response.status === 204) {
      return undefined as T;
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  }
}

function parseRetryAfterSeconds(value: string | null): number | undefined {
  if (!value) return undefined;
  const asInt = Number.parseInt(value, 10);
  if (Number.isFinite(asInt)) return Math.max(0, asInt);
  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return undefined;
  return Math.max(0, Math.ceil((dateMs - Date.now()) / 1000));
}

function parseQuotaResetSeconds(text: string): number | undefined {
  const match = /quota will reset in (\d+) seconds/i.exec(text);
  if (!match) return undefined;
  const seconds = Number.parseInt(match[1]!, 10);
  return Number.isFinite(seconds) ? seconds : undefined;
}

function serializeCaughtError(error: unknown): BulkCreateResult['error'] {
  if (error instanceof TogglApiError) {
    return {
      message: error.message,
      code: error.code,
      status: error.status,
      retry_after_seconds: error.retry_after_seconds,
    };
  }
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    return {
      message: error instanceof Error ? error.message : String(error),
      code: typeof e.code === 'string' ? e.code : undefined,
      status: typeof e.status === 'number' ? e.status : undefined,
      retry_after_seconds:
        typeof e.retry_after_seconds === 'number' ? e.retry_after_seconds : undefined,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
  };
}
