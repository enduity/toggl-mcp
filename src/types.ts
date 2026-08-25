export type QuotaRow = {
  organization_id: number | null;
  remaining: number;
  total: number;
  resets_in_secs: number;
};

export type Workspace = {
  id: number;
  name: string;
  organization_id?: number;
};

export type Project = {
  id: number;
  name: string;
  workspace_id: number;
  active?: boolean;
  billable?: boolean;
  client_id?: number | null;
  color?: string;
};

export type TimeEntry = {
  id: number;
  workspace_id: number;
  project_id?: number | null;
  project_name?: string;
  description?: string | null;
  billable?: boolean;
  tags?: string[] | null;
  tag_ids?: number[] | null;
  start: string;
  stop?: string | null;
  duration: number;
  task_id?: number | null;
};

export type CreateTimeEntryInput = {
  description?: string;
  project_id?: number | null;
  task_id?: number | null;
  billable?: boolean;
  tags?: string[];
  tag_ids?: number[];
  start: string;
  stop?: string;
  duration?: number;
};

export type PatchOp = {
  op: 'add' | 'remove' | 'replace';
  path: string;
  value?: unknown;
};

export type PatchOutput = {
  success: number[];
  failure: Array<{ id: number; message: string }>;
};

export class TogglApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retry_after_seconds?: number;

  constructor({
    status,
    code,
    message,
    retryAfterSeconds,
  }: {
    status: number;
    code: string;
    message: string;
    retryAfterSeconds?: number;
  }) {
    super(message);
    this.name = 'TogglApiError';
    this.status = status;
    this.code = code;
    this.retry_after_seconds = retryAfterSeconds;
  }
}
