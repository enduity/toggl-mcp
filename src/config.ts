export type Config = {
  apiKey: string;
  workspaceId: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = (env.TOGGL_API_KEY ?? env.TOGGL_API_TOKEN ?? env.TOGGL_TOKEN)?.trim();
  if (!apiKey) {
    throw new Error('Missing required environment variable: TOGGL_API_KEY');
  }

  const rawWorkspaceId = env.TOGGL_DEFAULT_WORKSPACE_ID?.trim();
  if (!rawWorkspaceId) {
    throw new Error('Missing required environment variable: TOGGL_DEFAULT_WORKSPACE_ID');
  }

  const workspaceId = Number.parseInt(rawWorkspaceId, 10);
  if (!Number.isFinite(workspaceId) || workspaceId <= 0) {
    throw new Error(
      `Invalid TOGGL_DEFAULT_WORKSPACE_ID: ${rawWorkspaceId}. Expected a positive integer.`
    );
  }

  return { apiKey, workspaceId };
}

export function assertLockedWorkspace(
  workspaceId: number,
  explicit: unknown
): void {
  if (explicit === undefined || explicit === null) return;
  const parsed =
    typeof explicit === 'number'
      ? explicit
      : typeof explicit === 'string'
        ? Number.parseInt(explicit, 10)
        : NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid workspace_id: ${String(explicit)}`);
  }
  if (parsed !== workspaceId) {
    throw new Error(
      `workspace_id ${parsed} is not allowed. This server is locked to workspace ${workspaceId}.`
    );
  }
}
