#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { TogglClient } from './toggl-client.js';
import {
  errorResult,
  handleAddTimeEntries,
  handleGetTimeEntries,
  handleListProjects,
  handleRemoveTimeEntry,
  handleUpdateTimeEntries,
} from './tools/handlers.js';

const VERSION = '0.1.0';

const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  console.error(`toggl-mcp ${VERSION}`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.error(
    `toggl-mcp – Toggl Track MCP for day-fill\n\n` +
      `Environment:\n` +
      `  TOGGL_API_KEY                Required API token\n` +
      `  TOGGL_DEFAULT_WORKSPACE_ID   Required; hard-locks all tools\n`
  );
  process.exit(0);
}

const config = loadConfig();
const client = new TogglClient({
  apiKey: config.apiKey,
  workspaceId: config.workspaceId,
});

const server = new McpServer({
  name: 'toggl-mcp',
  version: VERSION,
});

const workspaceIdField = z
  .union([z.number(), z.string()])
  .optional()
  .describe(
    'Must match TOGGL_DEFAULT_WORKSPACE_ID if provided; other values are rejected.'
  );

server.registerTool(
  'toggl_get_time_entries',
  {
    description:
      'List time entries for the locked workspace. Use period today/yesterday OR start_date+end_date (YYYY-MM-DD), not both. Always requests meta fields.',
    inputSchema: {
      period: z.enum(['today', 'yesterday']).optional(),
      start_date: z.string().optional().describe('YYYY-MM-DD or RFC3339'),
      end_date: z.string().optional().describe('YYYY-MM-DD or RFC3339 (exclusive for date-only)'),
      workspace_id: workspaceIdField,
    },
  },
  async (args) => {
    try {
      return await handleGetTimeEntries(client, args);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  'toggl_list_projects',
  {
    description: 'List projects for the locked workspace (cached in memory with TTL).',
    inputSchema: {
      workspace_id: workspaceIdField,
    },
  },
  async (args) => {
    try {
      return await handleListProjects(client, args);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  'toggl_add_time_entries',
  {
    description:
      'Bulk-create time entries. Each item becomes one POST through the rate-limit queue (API has no multi-create).',
    inputSchema: {
      entries: z
        .array(
          z.object({
            description: z.string().optional(),
            project_id: z.number().nullable().optional(),
            task_id: z.number().nullable().optional(),
            billable: z.boolean().optional(),
            tags: z.array(z.string()).optional(),
            tag_ids: z.array(z.number()).optional(),
            start: z.string().describe('UTC start, e.g. 2026-08-24T09:00:00Z'),
            stop: z.string().optional(),
            duration: z.number().optional(),
          })
        )
        .min(1),
      workspace_id: workspaceIdField,
    },
  },
  async (args) => {
    try {
      return await handleAddTimeEntries(client, args);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  'toggl_update_time_entries',
  {
    description:
      'Bulk-edit existing time entries via JSON Patch (RFC 6902). Max 100 IDs per underlying request; larger lists are chunked.',
    inputSchema: {
      time_entry_ids: z.array(z.number()).min(1),
      operations: z
        .array(
          z.object({
            op: z.enum(['add', 'remove', 'replace']),
            path: z.string().describe('e.g. /billable, /project_id, /tags'),
            value: z.unknown().optional(),
          })
        )
        .min(1),
      workspace_id: workspaceIdField,
    },
  },
  async (args) => {
    try {
      return await handleUpdateTimeEntries(client, args);
    } catch (error) {
      return errorResult(error);
    }
  }
);

server.registerTool(
  'toggl_remove_time_entry',
  {
    description: 'Delete a single time entry in the locked workspace.',
    inputSchema: {
      time_entry_id: z.number(),
      workspace_id: workspaceIdField,
    },
  },
  async (args) => {
    try {
      return await handleRemoveTimeEntry(client, args);
    } catch (error) {
      return errorResult(error);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
