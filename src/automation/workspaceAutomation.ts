import type {
  BrowserPaneModel,
  TerminalPaneModel,
  Workspace,
} from "../types";

const DEFAULT_BROWSER_URL = "https://github.com/";

export type WorkspaceAutomationState = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  attention: Record<string, string>;
};

export type WorkspaceAutomationOutcome = {
  state: WorkspaceAutomationState;
  result: unknown;
};

export class WorkspaceAutomationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

type IdFactory = () => string;

function createTerminalPane(nextId: IdFactory): TerminalPaneModel {
  return {
    id: nextId(),
    kind: "terminal",
    title: "PowerShell",
  };
}

function createBrowserPane(
  nextId: IdFactory,
  url = DEFAULT_BROWSER_URL,
): BrowserPaneModel {
  return {
    id: nextId(),
    kind: "browser",
    title: "Browser",
    url,
  };
}

function requireString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || !value) {
    throw new WorkspaceAutomationError(
      "INVALID_REQUEST",
      `${name} must be a non-empty string`,
    );
  }
  return value;
}

export function applyWorkspaceAutomation(
  state: WorkspaceAutomationState,
  method: string,
  params: Record<string, unknown>,
  nextId: IdFactory = () => crypto.randomUUID(),
): WorkspaceAutomationOutcome {
  switch (method) {
    case "workspace.list":
      return {
        state,
        result: {
          activeWorkspaceId: state.activeWorkspaceId,
          workspaces: state.workspaces.map((workspace) => ({
            id: workspace.id,
            title: workspace.title,
            cwd: workspace.cwd,
            active: workspace.id === state.activeWorkspaceId,
            panes: workspace.panes.map((pane) => ({
              id: pane.id,
              kind: pane.kind,
              title: pane.title,
              ...(pane.kind === "browser" ? { url: pane.url } : {}),
            })),
          })),
        },
      };

    case "workspace.create": {
      const title = requireString(params, "title");
      const cwd = typeof params.cwd === "string" ? params.cwd : "";
      const activate = params.activate !== false;
      const pane = createTerminalPane(nextId);
      const workspace: Workspace = {
        id: nextId(),
        title,
        cwd,
        panes: [pane],
        unread: false,
      };

      return {
        state: {
          ...state,
          workspaces: [...state.workspaces, workspace],
          activeWorkspaceId: activate ? workspace.id : state.activeWorkspaceId,
        },
        result: {
          workspaceId: workspace.id,
          active: activate,
          paneId: pane.id,
        },
      };
    }

    case "workspace.select": {
      const workspaceId = requireString(params, "workspaceId");
      if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
        throw new WorkspaceAutomationError(
          "WORKSPACE_NOT_FOUND",
          `workspace not found: ${workspaceId}`,
        );
      }

      return {
        state: {
          ...state,
          activeWorkspaceId: workspaceId,
          workspaces: state.workspaces.map((workspace) =>
            workspace.id === workspaceId ? { ...workspace, unread: false } : workspace,
          ),
        },
        result: { workspaceId, active: true },
      };
    }

    case "workspace.close": {
      const workspaceId = requireString(params, "workspaceId");
      const target = state.workspaces.find((workspace) => workspace.id === workspaceId);
      if (!target) {
        throw new WorkspaceAutomationError(
          "WORKSPACE_NOT_FOUND",
          `workspace not found: ${workspaceId}`,
        );
      }
      if (state.workspaces.length === 1) {
        throw new WorkspaceAutomationError(
          "LAST_WORKSPACE_PROTECTED",
          "the final workspace cannot be closed through automation",
        );
      }

      const workspaces = state.workspaces.filter((workspace) => workspace.id !== workspaceId);
      const attention = { ...state.attention };
      for (const pane of target.panes) delete attention[pane.id];
      const activeWorkspaceId =
        state.activeWorkspaceId === workspaceId ? workspaces[0].id : state.activeWorkspaceId;

      return {
        state: { workspaces, activeWorkspaceId, attention },
        result: { workspaceId, closed: true, activeWorkspaceId },
      };
    }

    case "pane.createTerminal": {
      const workspaceId = requireString(params, "workspaceId");
      if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
        throw new WorkspaceAutomationError(
          "WORKSPACE_NOT_FOUND",
          `workspace not found: ${workspaceId}`,
        );
      }
      const pane = createTerminalPane(nextId);
      return {
        state: {
          ...state,
          workspaces: state.workspaces.map((workspace) =>
            workspace.id === workspaceId
              ? { ...workspace, panes: [...workspace.panes, pane] }
              : workspace,
          ),
        },
        result: { workspaceId, paneId: pane.id, kind: pane.kind },
      };
    }

    case "pane.createBrowser": {
      const workspaceId = requireString(params, "workspaceId");
      if (!state.workspaces.some((workspace) => workspace.id === workspaceId)) {
        throw new WorkspaceAutomationError(
          "WORKSPACE_NOT_FOUND",
          `workspace not found: ${workspaceId}`,
        );
      }
      const url = typeof params.url === "string" ? params.url : DEFAULT_BROWSER_URL;
      const pane = createBrowserPane(nextId, url);
      return {
        state: {
          ...state,
          workspaces: state.workspaces.map((workspace) =>
            workspace.id === workspaceId
              ? { ...workspace, panes: [...workspace.panes, pane] }
              : workspace,
          ),
        },
        result: { workspaceId, paneId: pane.id, kind: pane.kind, url: pane.url },
      };
    }

    case "pane.close": {
      const workspaceId = requireString(params, "workspaceId");
      const paneId = requireString(params, "paneId");
      const workspace = state.workspaces.find((item) => item.id === workspaceId);
      if (!workspace) {
        throw new WorkspaceAutomationError(
          "WORKSPACE_NOT_FOUND",
          `workspace not found: ${workspaceId}`,
        );
      }
      if (!workspace.panes.some((pane) => pane.id === paneId)) {
        throw new WorkspaceAutomationError("PANE_NOT_FOUND", `pane not found: ${paneId}`);
      }
      if (workspace.panes.length === 1) {
        throw new WorkspaceAutomationError(
          "LAST_PANE_PROTECTED",
          "the final pane in a workspace cannot be closed through automation",
        );
      }

      const attention = { ...state.attention };
      delete attention[paneId];
      return {
        state: {
          ...state,
          attention,
          workspaces: state.workspaces.map((item) =>
            item.id === workspaceId
              ? { ...item, panes: item.panes.filter((pane) => pane.id !== paneId) }
              : item,
          ),
        },
        result: { workspaceId, paneId, closed: true },
      };
    }

    default:
      throw new WorkspaceAutomationError(
        "METHOD_NOT_FOUND",
        `unsupported workspace automation method: ${method}`,
      );
  }
}
