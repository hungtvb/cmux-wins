import { describe, expect, it } from "vitest";
import {
  applyWorkspaceAutomation,
  WorkspaceAutomationError,
  type WorkspaceAutomationState,
} from "./workspaceAutomation";

function baseState(): WorkspaceAutomationState {
  return {
    activeWorkspaceId: "workspace-1",
    attention: { "pane-2": "needs attention" },
    workspaces: [
      {
        id: "workspace-1",
        title: "Main",
        cwd: "C:\\code\\main",
        unread: false,
        panes: [
          { id: "pane-1", kind: "terminal", title: "PowerShell" },
          { id: "pane-2", kind: "terminal", title: "Agent" },
        ],
      },
      {
        id: "workspace-2",
        title: "Docs",
        cwd: "C:\\code\\docs",
        unread: true,
        panes: [{ id: "pane-3", kind: "terminal", title: "PowerShell" }],
      },
    ],
  };
}

function ids(...values: string[]) {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}

describe("workspace automation reducer", () => {
  it("lists a bounded serializable workspace snapshot", () => {
    const state = baseState();
    const outcome = applyWorkspaceAutomation(state, "workspace.list", {});

    expect(outcome.state).toBe(state);
    expect(outcome.result).toMatchObject({
      activeWorkspaceId: "workspace-1",
      workspaces: [
        { id: "workspace-1", active: true },
        { id: "workspace-2", active: false },
      ],
    });
  });

  it("creates and activates a workspace deterministically", () => {
    const outcome = applyWorkspaceAutomation(
      baseState(),
      "workspace.create",
      { title: "Agent", cwd: "C:\\agent", activate: true },
      ids("pane-new", "workspace-new"),
    );

    expect(outcome.state.activeWorkspaceId).toBe("workspace-new");
    expect(outcome.state.workspaces.at(-1)).toMatchObject({
      id: "workspace-new",
      title: "Agent",
      panes: [{ id: "pane-new", kind: "terminal" }],
    });
    expect(outcome.result).toEqual({
      workspaceId: "workspace-new",
      active: true,
      paneId: "pane-new",
    });
  });

  it("selects a workspace and clears its unread state", () => {
    const outcome = applyWorkspaceAutomation(baseState(), "workspace.select", {
      workspaceId: "workspace-2",
    });

    expect(outcome.state.activeWorkspaceId).toBe("workspace-2");
    expect(outcome.state.workspaces[1].unread).toBe(false);
  });

  it("closes a workspace and clears pane attention", () => {
    const outcome = applyWorkspaceAutomation(baseState(), "workspace.close", {
      workspaceId: "workspace-1",
    });

    expect(outcome.state.workspaces.map((workspace) => workspace.id)).toEqual(["workspace-2"]);
    expect(outcome.state.activeWorkspaceId).toBe("workspace-2");
    expect(outcome.state.attention).toEqual({});
  });

  it("protects the last workspace", () => {
    const state = baseState();
    state.workspaces = [state.workspaces[0]];

    expect(() =>
      applyWorkspaceAutomation(state, "workspace.close", { workspaceId: "workspace-1" }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkspaceAutomationError>>({
        code: "LAST_WORKSPACE_PROTECTED",
      }),
    );
  });

  it("creates terminal and browser panes", () => {
    const terminal = applyWorkspaceAutomation(
      baseState(),
      "pane.createTerminal",
      { workspaceId: "workspace-2" },
      ids("terminal-new"),
    );
    const browser = applyWorkspaceAutomation(
      terminal.state,
      "pane.createBrowser",
      { workspaceId: "workspace-2", url: "https://example.com/" },
      ids("browser-new"),
    );

    expect(browser.state.workspaces[1].panes).toEqual([
      { id: "pane-3", kind: "terminal", title: "PowerShell" },
      { id: "terminal-new", kind: "terminal", title: "PowerShell" },
      {
        id: "browser-new",
        kind: "browser",
        title: "Browser",
        url: "https://example.com/",
      },
    ]);
  });

  it("closes a pane and clears its attention", () => {
    const outcome = applyWorkspaceAutomation(baseState(), "pane.close", {
      workspaceId: "workspace-1",
      paneId: "pane-2",
    });

    expect(outcome.state.workspaces[0].panes.map((pane) => pane.id)).toEqual(["pane-1"]);
    expect(outcome.state.attention).toEqual({});
  });

  it("protects the final pane and preserves state on failure", () => {
    const state = baseState();

    try {
      applyWorkspaceAutomation(state, "pane.close", {
        workspaceId: "workspace-2",
        paneId: "pane-3",
      });
      throw new Error("expected reducer to reject final pane close");
    } catch (cause) {
      expect(cause).toMatchObject({ code: "LAST_PANE_PROTECTED" });
      expect(state.workspaces[1].panes).toHaveLength(1);
    }
  });
});
