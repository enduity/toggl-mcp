# toggl-mcp

MCP server for filling Toggl Track days from an agent. List entries and projects, bulk-add blocks (queued POSTs), bulk-edit via native PATCH, and delete one entry. All tools are locked to a single workspace.

## Requirements

- Node.js 26+
- Toggl Track API token ([profile](https://track.toggl.com/profile))

## Configuration

| Env | Required | Notes |
| --- | --- | --- |
| `TOGGL_API_KEY` | yes | API token |
| `TOGGL_DEFAULT_WORKSPACE_ID` | yes | Hard lock; other `workspace_id` args are rejected |

```bash
cp .env.example .env
# edit .env
```

### Cursor

```json
{
  "mcpServers": {
    "toggl-mcp": {
      "command": "npx",
      "args": ["-y", "toggl-mcp"],
      "env": {
        "TOGGL_API_KEY": "your_api_key_here",
        "TOGGL_DEFAULT_WORKSPACE_ID": "123456"
      }
    }
  }
}
```

For local development without publishing:

```json
{
  "mcpServers": {
    "toggl-mcp": {
      "command": "node",
      "args": ["/absolute/path/to/toggl-mcp/dist/index.js"],
      "env": {
        "TOGGL_API_KEY": "your_api_key_here",
        "TOGGL_DEFAULT_WORKSPACE_ID": "123456"
      }
    }
  }
}
```

## Tools

| Tool | Purpose |
| --- | --- |
| `toggl_get_time_entries` | List entries (`today` / `yesterday` or `start_date`+`end_date`); `meta=true`; filtered to the locked workspace |
| `toggl_list_projects` | List projects (in-memory TTL cache) |
| `toggl_add_time_entries` | Bulk create: one Toggl `POST` per entry through the queue |
| `toggl_update_time_entries` | Bulk edit via `PATCH` JSON Patch (max 100 IDs per request, chunked) |
| `toggl_remove_time_entry` | Delete one entry |

Create is not available through PATCH. Toggl's bulk PATCH only edits existing IDs (`op: "add"` means add a field, not a new entry).

## Rate limiting

The client stays at about 50% of both Toggl limits:

1. Hourly quota from `GET /me/quota`, then `x-toggl-quota-remaining` / `x-toggl-quota-resets-in` on later responses
2. At least 2 seconds between requests (~half of the ~1 req/s leaky bucket)

Requests run on a serial queue. If the reserved half of the quota would be breached, the tool returns a structured error with `retry_after_seconds` instead of burning the rest of the window.

## Develop

```bash
npm install
npm test
npm run build
npm start
```

## References

- [Toggl Track docs](https://engineering.toggl.com/docs/track/)
- [OpenAPI bundle](https://engineering.toggl.com/assets/files/api-608a9fccdf09a653b6842ed1793cfc4c.json)
- Interface inspiration: [verygoodplugins/mcp-toggl](https://github.com/verygoodplugins/mcp-toggl)
