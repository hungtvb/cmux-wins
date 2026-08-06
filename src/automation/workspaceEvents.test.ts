import { describe, expect, it } from "vitest";
import {
  diffWorkspaceEvents,
  type WorkspaceEventSnapshot,
} from "./workspaceEvents";

function snapshot(): WorkspaceEventSnapshot {
  return {
    activeWorkspaceId: "workspace-1",
    attention: {},
    workspaces: [
      {
        id: "workspace-1",
        title: "Main",
        cwd: "C:\\code",
        unread: false,
        panes: [
          { id: "pane-1", kind: "terminal", title: "PowerShell" },
        ],
      },
    ],
  };
}

function clone(value: WorkspaceEventSnapshot): WorkspaceEventSnapshot {
  return structuredClone(value);
}

describe("workspace event diff", () => {
  it("emits workspace, pane and selection lifecycle events", () => {
    const previous = snapshot();
    const current = clone(previous);
    current.workspaces.push({
      id: "workspace-2",
      title: "Agent",
      cwd: "C:\\agent",
      unread: false,
      panes: [
        { id: "pane-2", kind: "terminal", title: "PowerShell" },
        {
          id: "pane-3",
          kind: "browser",
          title: "Browser",
          url: "https://example.com/",
        },
      ],
    });
    current.activeWorkspaceId = "workspace-2";

    expect(diffWorkspaceEvents(previous, current)).toEqual([
      {
        kind: "workspaceCreated",
        workspaceId: "workspace-2",
        title: "Agent",
        cwd: "C:\\agent",
      },
      {
        kind: "paneCreated",
        workspaceId: "workspace-2",
        paneId: "pane-2",
        paneKind: "terminal",
        title: "PowerShell",
      },
      {
        kind: "paneCreated",
        workspaceId: "workspace-2",
        paneId: "pane-3",
        paneKind: "browser",
        title: "Browser",
        url: "https://example.com/",
      },
      {
        kind: "workspaceSelected",
        workspaceId: "workspace-2",
      },
    ]);
  });

  it("emits pane updates only for observable title or URL changes", () => {
    const previous = snapshot();
    previous.workspaces[0].panes.push({
      id: "pane-2",
      kind: "browser",
      title: "Browser",
      url: "https://example.com/",
    });
    const current = clone(previous);
    current.workspaces[0].unread = true;
    current.workspaces[0].panes[0].title = "Agent shell";
    const browser = current.workspaces[0].panes[1];
    if (browser.kind !== "browser") throw new Error("expected browser pane");
    browser.url = "https://openai.com/";

    expect(diffWorkspaceEvents(previous, current)).toEqual([
      {
        kind: "paneUpdated",
        workspaceId: "workspace-1",
        paneId: "pane-1",
        paneKind: "terminal",
        title: "Agent shell",
      },
      {
        kind: "paneUpdated",
        workspaceId: "workspace-1",
        paneId: "pane-2",
        paneKind: "browser",
        title: "Browser",
        url: "https://openai.com/",
      },
    ]);
  });

  it("orders attention clear before pane and workspace close", () => {
    const previous = snapshot();
    previous.attention["pane-1"] = "approval needed";
    const current: WorkspaceEventSnapshot = {
      workspaces: [
        {
          id: "workspace-2",
          title: "Replacement",
          cwd: "",
          unread: false,
          panes: [
            { id: "pane-2", kind: "terminal", title: "PowerShell" },
          ],
        },
      ],
      activeWorkspaceId: "workspace-2",
      attention: {},
    };

    expect(diffWorkspaceEvents(previous, current)).toEqual([
      {
        kind: "workspaceCreated",
        workspaceId: "workspace-2",
        title: "Replacement",
        cwd: "",
      },
      {
        kind: "paneCreated",
        workspaceId: "workspace-2",
        paneId: "pane-2",
        paneKind: "terminal",
        title: "PowerShell",
      },
      {
        kind: "attentionCleared",
        workspaceId: "workspace-1",
        paneId: "pane-1",
      },
      {
        kind: "paneClosed",
        workspaceId: "workspace-1",
        paneId: "pane-1",
        paneKind: "terminal",
      },
      {
        kind: "workspaceClosed",
        workspaceId: "workspace-1",
      },
      {
        kind: "workspaceSelected",
        workspaceId: "workspace-2",
      },
    ]);
  });

  it("clears attention when pane removal renders before attention cleanup", () => {
    const previous = snapshot();
    previous.attention["pane-1"] = "approval needed";
    const current = clone(previous);
    current.workspaces[0].panes = [
      { id: "pane-2", kind: "terminal", title: "PowerShell" },
    ];
    // React state updates may commit pane removal before the separate attention
    // cleanup update. The removal itself is the observable clear boundary.
    current.attention["pane-1"] = "approval needed";

    expect(diffWorkspaceEvents(previous, current)).toEqual([
      {
        kind: "paneCreated",
        workspaceId: "workspace-1",
        paneId: "pane-2",
        paneKind: "terminal",
        title: "PowerShell",
      },
      {
        kind: "attentionCleared",
        workspaceId: "workspace-1",
        paneId: "pane-1",
      },
      {
        kind: "paneClosed",
        workspaceId: "workspace-1",
        paneId: "pane-1",
        paneKind: "terminal",
      },
    ]);
  });

  it("emits attention requests on first message and message changes", () => {
    const previous = snapshot();
    const current = clone(previous);
    current.attention["pane-1"] = "approval needed";

    expect(diffWorkspaceEvents(previous, current)).toEqual([
      {
        kind: "attentionRequested",
        workspaceId: "workspace-1",
        paneId: "pane-1",
        message: "approval needed",
      },
    ]);

    const changed = clone(current);
    changed.attention["pane-1"] = "input required";
    expect(diffWorkspaceEvents(current, changed)).toEqual([
      {
        kind: "attentionRequested",
        workspaceId: "workspace-1",
        paneId: "pane-1",
        message: "input required",
      },
    ]);
  });

  it("normalizes NUL and bounds event text by Unicode characters", () => {
    const previous = snapshot();
    const current = clone(previous);
    current.workspaces.push({
      id: "workspace-2",
      title: `Agent\0${"ế".repeat(1100)}`,
      cwd: `C:\\code\0${"x".repeat(1100)}`,
      unread: false,
      panes: [{ id: "pane-2", kind: "terminal", title: "PowerShell" }],
    });

    const created = diffWorkspaceEvents(previous, current)[0];
    if (created.kind !== "workspaceCreated") {
      throw new Error("expected workspaceCreated event");
    }
    expect(created.title).not.toContain("\0");
    expect(Array.from(created.title)).toHaveLength(1024);
    expect(created.cwd).not.toContain("\0");
    expect(Array.from(created.cwd)).toHaveLength(1024);
  });

  it("does not emit anything for equivalent observable state", () => {
    const previous = snapshot();
    const current = clone(previous);
    current.workspaces[0].unread = true;
    expect(diffWorkspaceEvents(previous, current)).toEqual([]);
  });
});
