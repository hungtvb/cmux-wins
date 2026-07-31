import { invoke } from "@tauri-apps/api/core";
import { useEffect, useMemo, useState } from "react";
import type { Workspace, WorkspaceMetadata } from "../types";

const REFRESH_INTERVAL_MS = 15_000;

export function useWorkspaceMetadata(workspaces: Workspace[]) {
  const [metadataByWorkspace, setMetadataByWorkspace] = useState<
    Record<string, WorkspaceMetadata | undefined>
  >({});

  const targetsKey = useMemo(
    () => workspaces.map((workspace) => `${workspace.id}\u0000${workspace.cwd}`).join("\u0001"),
    [workspaces],
  );

  useEffect(() => {
    const targets = workspaces.map(({ id, cwd }) => ({ id, cwd }));
    let disposed = false;
    let refreshing = false;

    const refresh = async () => {
      if (refreshing) return;
      refreshing = true;

      try {
        const entries = await Promise.all(
          targets.map(async ({ id, cwd }) => {
            if (!cwd.trim()) return [id, undefined] as const;

            try {
              const metadata = await invoke<WorkspaceMetadata>("get_workspace_metadata", { cwd });
              return [id, metadata] as const;
            } catch {
              return [id, undefined] as const;
            }
          }),
        );

        if (!disposed) {
          setMetadataByWorkspace(Object.fromEntries(entries));
        }
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
