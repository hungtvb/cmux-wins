import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  useEffect,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from "react";
import type { Pane, Workspace } from "../types";

const DEFAULT_BROWSER_URL = "https://github.com/";

type AutomationRequestEvent = {
  commandId: number;
  method: string;
  params: Record<string, unknown>;
};

type UseAutomationBridgeOptions = {
  workspacesRef: MutableRefObject<Workspace[]>;
  activeWorkspaceIdRef: MutableRefObject<string>;
  setWorkspaces: Dispatch<SetStateAction<Workspace[]>>;
  setActiveWorkspaceId: Dispatch<SetStateAction<string>>;
  setAttention: Dispatch<SetStateAction<Record<string, string>>>;
};

class AutomationUiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function createTerminalPane(): Pane {
  return {
    id: crypto.randomUUID(),
    kind: "terminal",
    title: "PowerShell",
  };
}

function createBrowserPane(url = DEFAULT_BROWSER_URL): Pane {
  return {
    id: crypto.randomUUID(),
    kind: "browser",
    title: "Browser",
    url,
  };
}

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value) {
    throw new AutomationUiError("INVALID_REQUEST", `${name} must be a non-empty string`);
  }
  return value;
}

export function useAutomationBridge({
  workspacesRef,
  activeWorkspaceIdRef,
  setWorkspaces,
  setActiveWorkspaceId,
  setAttention,
}: UseAutomationBridgeOptions) {
  useEffect(() => {
    let disposed = false;

    const commitWorkspaces = (update: (current: Workspace[]) => Workspace[]) => {
      const next = update(workspacesRef.current);
      workspacesRef.current = next;
      setWorkspaces(next);
      return next;
    };

    const handle = (request: AutomationRequestEvent): unknown => {
      const { method, params } = request;

      switch (method) {
        case "workspace.list":
          return {
            activeWorkspaceId: activeWorkspaceIdRef.current,
            workspaces: workspacesRef.current.map((workspace) => ({
              id: workspace.id,
              title: workspace.title,
              cwd: workspace.cwd,
              active: workspace.id === activeWorkspaceIdRef.current,
              panes: workspace.panes.map((pane) => ({
                id: pane.id,
                kind: pane.kind,
                title: pane.title,
                ...(pane.kind === "browser" ? { url: pane.url } : {}),
              })),
            })),
          };

        case "workspace.create": {
          const title = requireString(params, "title");
          const cwd = typeof params.cwd === "string" ? params.cwd : "";
          const activate = params.activate !== false;
          const workspace: Workspace = {
            id: crypto.randomUUID(),
            title,
            cwd,
            panes: [createTerminalPane()],
            unread: false,
          };

          commitWorkspaces((current) => [...current, workspace]);
          if (activate) {
            activeWorkspaceIdRef.current = workspace.id;
            setActiveWorkspaceId(workspace.id);
          }

          return {
            workspaceId: workspace.id,
            active: activate,
            paneId: workspace.panes[0].id,
          };
        }

        case "workspace.select": {
          const workspaceId = requireString(params, "workspaceId");
          if (!workspacesRef.current.some((workspace) => workspace.id === workspaceId)) {
            throw new AutomationUiError(
              "WORKSPACE_NOT_FOUND",
              `workspace not found: ${workspaceId}`,
            );
          }

          activeWorkspaceIdRef.current = workspaceId;
          setActiveWorkspaceId(workspaceId);
          commitWorkspaces((current) =>
            current.map((workspace) =>
              workspace.id === workspaceId ? { ...workspace, unread: false } : workspace,
            ),
          );
          return { workspaceId, active: true };
        }

        case "workspace.close": {
          const workspaceId = requireString(params, "workspaceId");
          const current = workspacesRef.current;
          const target = current.find((workspace) => workspace.id === workspaceId);
          if (!target) {
            throw new AutomationUiError(
              "WORKSPACE_NOT_FOUND",
              `workspace not found: ${workspaceId}`,
            );
          }
          if (current.length === 1) {
            throw new AutomationUiError(
              "LAST_WORKSPACE_PROTECTED",
              "the final workspace cannot be closed through automation",
            );
          }

          const next = commitWorkspaces((workspaces) =>
            workspaces.filter((workspace) => workspace.id !== workspaceId),
          );
          setAttention((attention) => {
            const updated = { ...attention };
            for (const pane of target.panes) delete updated[pane.id];
            return updated;
          });

          if (activeWorkspaceIdRef.current === workspaceId) {
            const nextActiveId = next[0].id;
            activeWorkspaceIdRef.current = nextActiveId;
            setActiveWorkspaceId(nextActiveId);
          }

          return {
            workspaceId,
            closed: true,
            activeWorkspaceId: activeWorkspaceIdRef.current,
          };
        }

        case "pane.createTerminal": {
          const workspaceId = requireString(params, "workspaceId");
          const pane = createTerminalPane();
          let found = false;
          commitWorkspaces((current) =>
            current.map((workspace) => {
              if (workspace.id !== workspaceId) return workspace;
              found = true;
              return { ...workspace, panes: [...workspace.panes, pane] };
            }),
          );
          if (!found) {
            throw new AutomationUiError(
              "WORKSPACE_NOT_FOUND",
              `workspace not found: ${workspaceId}`,
            );
          }
          return { workspaceId, paneId: pane.id, kind: pane.kind };
        }

        case "pane.createBrowser": {
          const workspaceId = requireString(params, "workspaceId");
          const url = typeof params.url === "string" ? params.url : DEFAULT_BROWSER_URL;
          const pane = createBrowserPane(url);
          let found = false;
          commitWorkspaces((current) =>
            current.map((workspace) => {
              if (workspace.id !== workspaceId) return workspace;
              found = true;
              return { ...workspace, panes: [...workspace.panes, pane] };
            }),
          );
          if (!found) {
            throw new AutomationUiError(
              "WORKSPACE_NOT_FOUND",
              `workspace not found: ${workspaceId}`,
            );
          }
          return { workspaceId, paneId: pane.id, kind: pane.kind, url: pane.url };
        }

        case "pane.close": {
          const workspaceId = requireString(params, "workspaceId");
          const paneId = requireString(params, "paneId");
          const workspace = workspacesRef.current.find((item) => item.id === workspaceId);
          if (!workspace) {
            throw new AutomationUiError(
              "WORKSPACE_NOT_FOUND",
              `workspace not found: ${workspaceId}`,
            );
          }
          if (!workspace.panes.some((pane) => pane.id === paneId)) {
            throw new AutomationUiError("PANE_NOT_FOUND", `pane not found: ${paneId}`);
          }
          if (workspace.panes.length === 1) {
            throw new AutomationUiError(
              "LAST_PANE_PROTECTED",
              "the final pane in a workspace cannot be closed through automation",
            );
          }

          commitWorkspaces((current) =>
            current.map((item) =>
              item.id === workspaceId
                ? { ...item, panes: item.panes.filter((pane) => pane.id !== paneId) }
                : item,
            ),
          );
          setAttention((attention) => {
            const updated = { ...attention };
            delete updated[paneId];
            return updated;
          });
          return { workspaceId, paneId, closed: true };
        }

        default:
          throw new AutomationUiError(
            "METHOD_NOT_FOUND",
            `unsupported workspace automation method: ${method}`,
          );
      }
    };

    const unlistenPromise = listen<AutomationRequestEvent>("automation-request", (event) => {
      if (disposed) return;

      let resolution: Record<string, unknown>;
      try {
        resolution = {
          commandId: event.payload.commandId,
          ok: true,
          result: handle(event.payload),
        };
      } catch (cause) {
        const error =
          cause instanceof AutomationUiError
            ? cause
            : new AutomationUiError("UI_ERROR", String(cause));
        resolution = {
          commandId: event.payload.commandId,
          ok: false,
          errorCode: error.code,
          errorMessage: error.message,
        };
      }

      void invoke("resolve_automation_request", { resolution }).catch(() => {
        // Rust owns the timeout and late-response cleanup path.
      });
    });

    return () => {
      disposed = true;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [
    activeWorkspaceIdRef,
    setActiveWorkspaceId,
    setAttention,
    setWorkspaces,
    workspacesRef,
  ]);
}
