import { z } from 'zod';
import { assertLockedWorkspace } from '../config.js';
import { resolveDateRange } from '../dates.js';
import type { TogglClient } from '../toggl-client.js';
import type { CreateTimeEntryInput, PatchOp } from '../types.js';

const periodSchema = z.enum(['today', 'yesterday']).optional();

export const getTimeEntriesInputSchema = z
  .object({
    period: periodSchema,
    start_date: z.string().optional(),
    end_date: z.string().optional(),
    workspace_id: z.union([z.number(), z.string()]).optional(),
  })
  .strict();

export const listProjectsInputSchema = z
  .object({
    workspace_id: z.union([z.number(), z.string()]).optional(),
  })
  .strict();

const timeEntryCreateSchema = z
  .object({
    description: z.string().optional(),
    project_id: z.number().nullable().optional(),
    task_id: z.number().nullable().optional(),
    billable: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    tag_ids: z.array(z.number()).optional(),
    start: z.string(),
    stop: z.string().optional(),
    duration: z.number().optional(),
  })
  .strict();

export const addTimeEntriesInputSchema = z
  .object({
    entries: z.array(timeEntryCreateSchema).min(1),
    conflict_policy: z.enum(['reject', 'skip']).optional(),
    workspace_id: z.union([z.number(), z.string()]).optional(),
  })
  .strict();

const patchOpSchema = z
  .object({
    op: z.enum(['add', 'remove', 'replace']),
    path: z.string(),
    value: z.unknown().optional(),
  })
  .strict();

export const updateTimeEntriesInputSchema = z
  .object({
    time_entry_ids: z.array(z.number()).min(1),
    operations: z.array(patchOpSchema).min(1),
    workspace_id: z.union([z.number(), z.string()]).optional(),
  })
  .strict();

export const removeTimeEntryInputSchema = z
  .object({
    time_entry_id: z.number(),
    workspace_id: z.union([z.number(), z.string()]).optional(),
  })
  .strict();

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function jsonResult(data: unknown, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
    isError,
  };
}

export function errorResult(error: unknown): ToolResult {
  const payload: Record<string, unknown> = {
    error: true,
    message: error instanceof Error ? error.message : String(error),
  };
  if (error && typeof error === 'object') {
    const e = error as Record<string, unknown>;
    if (typeof e.code === 'string') payload.code = e.code;
    if (typeof e.status === 'number') payload.status = e.status;
    if (typeof e.retry_after_seconds === 'number') {
      payload.retry_after_seconds = e.retry_after_seconds;
    }
  }
  return jsonResult(payload, true);
}

export async function handleGetTimeEntries(
  client: TogglClient,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = getTimeEntriesInputSchema.parse(rawArgs ?? {});
  assertLockedWorkspace(client.getWorkspaceId(), args.workspace_id);
  const range = resolveDateRange(args);
  const entries = await client.getTimeEntries(range);
  return jsonResult({
    workspace_id: client.getWorkspaceId(),
    start_date: range.start_date,
    end_date: range.end_date,
    count: entries.length,
    entries,
  });
}

export async function handleListProjects(
  client: TogglClient,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = listProjectsInputSchema.parse(rawArgs ?? {});
  assertLockedWorkspace(client.getWorkspaceId(), args.workspace_id);
  const projects = await client.listProjects();
  return jsonResult({
    workspace_id: client.getWorkspaceId(),
    count: projects.length,
    projects,
  });
}

export async function handleAddTimeEntries(
  client: TogglClient,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = addTimeEntriesInputSchema.parse(rawArgs ?? {});
  assertLockedWorkspace(client.getWorkspaceId(), args.workspace_id);
  const result = await client.createTimeEntries(
    args.entries as CreateTimeEntryInput[],
    { conflict_policy: args.conflict_policy }
  );
  const failed =
    result.error !== undefined ||
    result.code === 'TIME_ENTRY_CONFLICT' ||
    result.code === 'TIME_ENTRY_BATCH_DUPLICATE';
  return jsonResult(
    {
      workspace_id: client.getWorkspaceId(),
      conflict_policy: result.conflict_policy ?? args.conflict_policy ?? 'reject',
      count: result.entries.length,
      entries: result.entries,
      results: result.results,
      ...(result.code ? { code: result.code, message: result.message } : {}),
      ...(result.error
        ? {
            partial: result.entries.length > 0,
            failed_at_index: result.failed_at_index,
            remaining_count: result.remaining_count,
            created_input_indexes: result.created_input_indexes,
            duplicate_input_indexes: result.duplicate_input_indexes,
            not_attempted_input_indexes: result.not_attempted_input_indexes,
            error: result.error,
          }
        : {}),
    },
    failed
  );
}

export async function handleUpdateTimeEntries(
  client: TogglClient,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = updateTimeEntriesInputSchema.parse(rawArgs ?? {});
  assertLockedWorkspace(client.getWorkspaceId(), args.workspace_id);
  const result = await client.updateTimeEntries(
    args.time_entry_ids,
    args.operations as PatchOp[]
  );
  return jsonResult({
    workspace_id: client.getWorkspaceId(),
    ...result,
  });
}

export async function handleRemoveTimeEntry(
  client: TogglClient,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = removeTimeEntryInputSchema.parse(rawArgs ?? {});
  assertLockedWorkspace(client.getWorkspaceId(), args.workspace_id);
  await client.deleteTimeEntry(args.time_entry_id);
  return jsonResult({
    workspace_id: client.getWorkspaceId(),
    deleted_id: args.time_entry_id,
  });
}
