import { describe, expect, it } from "vitest";
import {
  buildNotificationItems,
  countAttention,
  findWorkspaceForPane,
} from "./notificationModel";
import type { Workspace } from "./types";

function makeWorkspace(overrides: Partial<Workspace> = {}): Workspace {
  return {
    id: "ws-1",
    title: "Agent",
    cwd: "C:\\code\\agent",
    unread: false,
    panes: [
      { id: "pane-1", kind: "terminal", title: "PowerShell" },
      { id: "pane-2", kind: "browser", title: "GitHub", url: "https://github.com" },
    ],
    ...overrides,
  };
}

describe("buildNotificationItems", () => {
  it("maps attention entries to workspace/pane context", () => {
    const attention = { "pane-1": "Tests failed", "pane-2": "Build ready" };
    const items = buildNotificationItems(attention, [makeWorkspace()]);

    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      paneId: "pane-1",
      workspaceId: "ws-1",
      workspaceTitle: "Agent",
      paneTitle: "PowerShell",
      message: "Tests failed",
      kind: "terminal",
    });
    expect(items[1].kind).toBe("browser");
    expect(items[1].message).toBe("Build ready");
  });

  it("preserves insertion order of the attention record", () => {
    const attention = { "pane-1": "first", "pane-2": "second" };
    const items = buildNotificationItems(attention, [makeWorkspace()]);
    expect(items.map((item) => item.message)).toEqual(["first", "second"]);
  });

  it("skips attention entries whose pane no longer exists", () => {
    const attention = { "pane-1": "alive", "ghost-pane": "dead" };
    const items = buildNotificationItems(attention, [makeWorkspace()]);
    expect(items).toHaveLength(1);
    expect(items[0].paneId).toBe("pane-1");
  });

  it("returns an empty list for no attention", () => {
    expect(buildNotificationItems({}, [makeWorkspace()])).toEqual([]);
  });

  it("associates panes across multiple workspaces", () => {
    const workspaces = [
      makeWorkspace(),
      makeWorkspace({ id: "ws-2", title: "Docs", panes: [{ id: "pane-3", kind: "terminal", title: "pwsh" }] }),
    ];
    const attention = { "pane-3": "Docs attention" };
    const items = buildNotificationItems(attention, workspaces);

    expect(items).toHaveLength(1);
    expect(items[0].workspaceTitle).toBe("Docs");
    expect(items[0].paneTitle).toBe("pwsh");
  });
});

describe("findWorkspaceForPane", () => {
  it("finds the owning workspace", () => {
    const workspaces = [
      makeWorkspace(),
      makeWorkspace({ id: "ws-2", title: "Docs", panes: [{ id: "pane-3", kind: "terminal", title: "pwsh" }] }),
    ];
    const found = findWorkspaceForPane(workspaces, "pane-3");
    expect(found?.id).toBe("ws-2");
  });

  it("returns null for an unknown pane", () => {
    expect(findWorkspaceForPane([makeWorkspace()], "nope")).toBeNull();
  });
});

describe("countAttention", () => {
  it("counts outstanding entries", () => {
    expect(countAttention({})).toBe(0);
    expect(countAttention({ "pane-1": "a", "pane-2": "b" })).toBe(2);
  });
});
