import type { Pane, Workspace } from "./types";

/**
 * A single agent-attention notification derived from the app-level
 * `attention` record plus the live workspace/pane tree.
 *
 * Attention items are keyed by pane id and carry the message supplied by
 * the terminal's OSC 9 / 99 / 777 notification (see useTerminalSession).
 */
export type NotificationItem = {
  paneId: string;
  workspaceId: string;
  workspaceTitle: string;
  paneTitle: string;
  message: string;
  kind: Pane["kind"];
};

/**
 * Build the ordered notification list from the attention record and the
 * current workspace tree.
 *
 * - Items follow the attention record's insertion order (stable across
 *   re-renders; re-firing attention on an existing pane keeps its position).
 * - Entries whose pane no longer exists (closed pane with a stale attention
 *   entry) are skipped so the panel never renders dead rows.
 */
export function buildNotificationItems(
  attention: Record<string, string>,
  workspaces: Workspace[],
): NotificationItem[] {
  const paneIndex = new Map<string, { workspace: Workspace; pane: Pane }>();
  for (const workspace of workspaces) {
    for (const pane of workspace.panes) {
      paneIndex.set(pane.id, { workspace, pane });
    }
  }

  const items: NotificationItem[] = [];
  for (const [paneId, message] of Object.entries(attention)) {
    const entry = paneIndex.get(paneId);
    if (!entry) continue;
    items.push({
      paneId,
      workspaceId: entry.workspace.id,
      workspaceTitle: entry.workspace.title,
      paneTitle: entry.pane.title,
      message,
      kind: entry.pane.kind,
    });
  }
  return items;
}

/** Locate the workspace that owns the given pane id, if any. */
export function findWorkspaceForPane(
  workspaces: Workspace[],
  paneId: string,
): Workspace | null {
  for (const workspace of workspaces) {
    if (workspace.panes.some((pane) => pane.id === paneId)) return workspace;
  }
  return null;
}

/** Total number of outstanding attention entries across all workspaces. */
export function countAttention(attention: Record<string, string>): number {
  return Object.keys(attention).length;
}
