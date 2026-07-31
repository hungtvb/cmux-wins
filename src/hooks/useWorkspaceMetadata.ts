import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { Workspace, WorkspaceMetadata } from "../types";

const REFRESH_INTERVAL_MS = 15_000;

type WorkspaceMetadataEntry = {
  workspaceId: string;
  metadata: WorkspaceMetadata;
};

export function useWorkspaceMetadata(workspaces: Workspace[]) {
  const [metadataByWorkspace, setMetadataByWorkspace] = useState<
    Record<string, WorkspaceMetadata | undefined>
  >({});

  const targetsKey = useMemo(
    () => workspaces.map((workspace) => `${workspace.id}\u0000${workspace.cwd}`).join("\u0001"),
    [workspaces],
  );

  useEffect(() => {
    const requests = workspaces.map(({ id, cwd }) => ({ workspaceId: id, cwd }));
    let disposed = false;
    let refreshing = false;

    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;

      try {
        const entries = await invoke<WorkspaceMetadataEntry[]>("get_workspace_metadata_batch", {
          requests,
        });

        if (!disposed) {
          setMetadataByWorkspace(
            Object.fromEntries(entries.map(({ workspaceId, metadata }) => [workspaceId, metadata])),
          );
        }
      } catch {
        // Keep the last successful snapshot. Metadata is optional and must not
        // interrupt terminal input when Git, gh, CIM or networking APIs fail.
      } finally {
        refreshing = false;
      }
    };

    const handleFocus = () => void refresh();
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    window.addEventListener("focus", handleFocus);

    return () => {
      disposed = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
    };
    // targetsKey intentionally isolates metadata polling from pane/title updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetsKey]);

  return metadataByWorkspace;
}
