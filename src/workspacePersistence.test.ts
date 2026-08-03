import { describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, type AppSettings } from "./settings";
import {
  MAX_TERMINAL_HISTORY_BYTES_TOTAL,
  terminalHistoryByteLength,
} from "./terminalHistory";
import {
  LEGACY_WORKSPACE_STORAGE_KEYS,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  WORKSPACE_STATE_PREVIOUS_KEY,
  WORKSPACE_STATE_STORAGE_KEY,
  clearWorkspaceState,
  loadWorkspaceState,
  normalizeWorkspaceState,
  saveWorkspaceState,
} from "./workspacePersistence";

function idFactory(...ids: string[]) {
  let index = 0;
  return () => ids[index++] ?? `generated-${index}`;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    has: (key: string) => values.has(key),
    value: (key: string) => values.get(key),
  };
}

const disabledSettings: AppSettings = {
  ...DEFAULT_SETTINGS,
  persistence: { restoreWorkspaces: false, terminalHistoryLines: 0 },
};

describe("workspace persistence", () => {
  it("migrates legacy workspace arrays and snapshots terminal settings", () => {
    const state = normalizeWorkspaceState(
      [
        {
          id: "workspace-1",
          title: " Repo ",
          cwd: " C:\\code ",
          panes: [
            { id: "terminal-1", kind: "terminal", title: "Shell" },
            { id: "browser-1", kind: "browser", title: "Docs", url: "https://example.com/docs" },
          ],
        },
      ],
      { ...DEFAULT_SETTINGS, defaultShellProfileId: "powershell-7" },
      idFactory("unused"),
    );

    expect(state.workspaces[0]).toMatchObject({ id: "workspace-1", title: "Repo", cwd: "C:\\code" });
    expect(state.workspaces[0].panes[0]).toMatchObject({
      id: "terminal-1",
      kind: "terminal",
      terminalSettings: { shellProfileId: "powershell-7", workingDirectory: "C:\\code" },
    });
    expect(state.workspaces[0].panes[1]).toMatchObject({
      id: "browser-1",
      kind: "browser",
      url: "https://example.com/docs",
    });
  });

  it("replaces duplicate IDs and rejects unsafe browser URLs", () => {
    const state = normalizeWorkspaceState(
      {
        workspaces: [
          {
            id: "same",
            panes: [
              { id: "pane", kind: "browser", url: "javascript:alert(1)" },
              { id: "pane", kind: "terminal" },
            ],
          },
          { id: "same", panes: [] },
        ],
      },
      DEFAULT_SETTINGS,
      idFactory("new-pane", "new-workspace", "fallback-pane"),
    );

    expect(new Set(state.workspaces.map((workspace) => workspace.id)).size).toBe(2);
    expect(new Set(state.workspaces.flatMap((workspace) => workspace.panes.map((pane) => pane.id))).size).toBe(3);
    expect(state.workspaces[0].panes[0]).toMatchObject({ kind: "browser", url: "https://github.com" });
  });

  it("reserves generated fallback pane IDs across workspaces", () => {
    const state = normalizeWorkspaceState(
      {
        workspaces: [
          { id: "w1", panes: [] },
          { id: "w2", panes: [{ id: "fallback-pane", kind: "terminal" }] },
        ],
      },
      DEFAULT_SETTINGS,
      idFactory("fallback-pane", "replacement-pane"),
    );

    expect(state.workspaces[0].panes[0].id).toBe("fallback-pane");
    expect(state.workspaces[1].panes[0].id).toBe("replacement-pane");
  });

  it("recovers instead of downgrading an unknown future envelope", () => {
    const storage = memoryStorage({
      [WORKSPACE_STATE_STORAGE_KEY]: JSON.stringify({
        version: 99,
        workspaces: [{ id: "future", panes: [{ id: "future-pane", kind: "terminal" }] }],
      }),
      [WORKSPACE_STATE_PREVIOUS_KEY]: JSON.stringify({
        version: 4,
        workspaces: [{ id: "safe", title: "Safe", panes: [{ id: "safe-pane", kind: "terminal" }] }],
      }),
    });

    const result = loadWorkspaceState(DEFAULT_SETTINGS, storage, idFactory("unused"));
    expect(result.status).toBe("recovered");
    expect(result.state.workspaces[0].title).toBe("Safe");
  });

  it("restores valid focus state and clamps split ratios", () => {
    const state = normalizeWorkspaceState({
      workspaces: [
        {
          id: "w1",
          title: "One",
          panes: [
            { id: "p1", kind: "terminal" },
            { id: "p2", kind: "terminal" },
          ],
        },
        { id: "w2", title: "Two", panes: [{ id: "p3", kind: "terminal" }] },
      ],
      activeWorkspaceId: "w2",
      activePaneByWorkspace: { w1: "p2", w2: "missing" },
      splitRatioByWorkspace: { w1: 2, w2: 99 },
    });

    expect(state.activeWorkspaceId).toBe("w2");
    expect(state.activePaneByWorkspace).toEqual({ w1: "p2", w2: "p3" });
    expect(state.splitRatioByWorkspace).toEqual({ w1: MIN_SPLIT_RATIO, w2: MAX_SPLIT_RATIO });
  });

  it("recovers the previous known-good envelope when current JSON is corrupt", () => {
    const previous = JSON.stringify({
      version: 3,
      workspaces: [{ id: "w1", title: "Recovered", panes: [{ id: "p1", kind: "terminal" }] }],
      activeWorkspaceId: "w1",
    });
    const storage = memoryStorage({
      [WORKSPACE_STATE_STORAGE_KEY]: "{broken",
      [WORKSPACE_STATE_PREVIOUS_KEY]: previous,
    });

    const result = loadWorkspaceState(DEFAULT_SETTINGS, storage, idFactory("unused"));
    expect(result.status).toBe("recovered");
    expect(result.state.workspaces[0].title).toBe("Recovered");
  });

  it("migrates legacy keys and removes them after a successful save", () => {
    const storage = memoryStorage({
      [LEGACY_WORKSPACE_STORAGE_KEYS[0]]: JSON.stringify([
        { id: "w1", title: "Legacy", panes: [{ id: "p1", kind: "terminal" }] },
      ]),
    });
    const loaded = loadWorkspaceState(DEFAULT_SETTINGS, storage, idFactory("unused"));
    expect(loaded.status).toBe("migrated");

    saveWorkspaceState(loaded.state, DEFAULT_SETTINGS, storage);
    expect(storage.has(WORKSPACE_STATE_STORAGE_KEY)).toBe(true);
    expect(storage.has(LEGACY_WORKSPACE_STORAGE_KEYS[0])).toBe(false);
  });


  it("migrates v3 workspace metadata without requiring terminal history", () => {
    const storage = memoryStorage({
      [LEGACY_WORKSPACE_STORAGE_KEYS[0]]: JSON.stringify({
        version: 3,
        workspaces: [
          { id: "w1", title: "Version 3", panes: [{ id: "p1", kind: "terminal" }] },
        ],
      }),
    });

    const result = loadWorkspaceState(DEFAULT_SETTINGS, storage, idFactory("unused"));
    expect(result.status).toBe("migrated");
    expect(result.state.version).toBe(4);
    expect(result.state.workspaces[0].panes[0]).not.toHaveProperty("historySnapshot");
  });

  it("stores only bounded inert terminal history", () => {
    const settings: AppSettings = {
      ...DEFAULT_SETTINGS,
      persistence: { ...DEFAULT_SETTINGS.persistence, terminalHistoryLines: 2 },
    };
    const state = normalizeWorkspaceState(
      {
        workspaces: [
          {
            id: "w1",
            panes: [
              {
                id: "p1",
                kind: "terminal",
                historySnapshot: "old\nkeep\n\u001b]0;owned\u0007new\u001b[31m!\u001b[0m",
              },
            ],
          },
        ],
      },
      settings,
    );

    expect(state.workspaces[0].panes[0]).toMatchObject({
      kind: "terminal",
      historySnapshot: "keep\nnew!",
    });
  });

  it("enforces the whole-envelope history byte budget", () => {
    const payload = "x".repeat(600 * 1024);
    const state = normalizeWorkspaceState({
      workspaces: [
        {
          id: "w1",
          panes: Array.from({ length: 10 }, (_, index) => ({
            id: `p${index}`,
            kind: "terminal",
            historySnapshot: payload,
          })),
        },
      ],
    });
    const totalBytes = state.workspaces[0].panes.reduce(
      (total, pane) =>
        total + (pane.kind === "terminal" ? terminalHistoryByteLength(pane.historySnapshot ?? "") : 0),
      0,
    );

    expect(totalBytes).toBeLessThanOrEqual(MAX_TERMINAL_HISTORY_BYTES_TOTAL);
  });

  it("removes history from both saved generations when retention is disabled", () => {
    const storage = memoryStorage();
    const state = {
      workspaces: [
        {
          id: "w1",
          title: "History",
          panes: [{ id: "p1", kind: "terminal", historySnapshot: "secret" }],
        },
      ],
    };

    saveWorkspaceState(state, DEFAULT_SETTINGS, storage);
    saveWorkspaceState(state, DEFAULT_SETTINGS, storage);
    storage.setItem(WORKSPACE_STATE_STORAGE_KEY, "{corrupt");
    const noHistorySettings: AppSettings = {
      ...DEFAULT_SETTINGS,
      persistence: { ...DEFAULT_SETTINGS.persistence, terminalHistoryLines: 0 },
    };
    saveWorkspaceState(state, noHistorySettings, storage);

    expect(storage.value(WORKSPACE_STATE_STORAGE_KEY)).not.toContain("secret");
    expect(storage.value(WORKSPACE_STATE_PREVIOUS_KEY)).not.toContain("secret");
  });


  it("disables restore and clears only workspace keys", () => {
    const storage = memoryStorage({
      [WORKSPACE_STATE_STORAGE_KEY]: "saved",
      [WORKSPACE_STATE_PREVIOUS_KEY]: "previous",
      [LEGACY_WORKSPACE_STORAGE_KEYS[0]]: "legacy",
      "tonymux.settings.v3": "settings",
    });

    saveWorkspaceState({}, disabledSettings, storage);
    expect(storage.has(WORKSPACE_STATE_STORAGE_KEY)).toBe(false);
    expect(storage.has(WORKSPACE_STATE_PREVIOUS_KEY)).toBe(false);
    expect(storage.has(LEGACY_WORKSPACE_STORAGE_KEYS[0])).toBe(false);
    expect(storage.value("tonymux.settings.v3")).toBe("settings");
    expect(loadWorkspaceState(disabledSettings, storage, idFactory("w", "p")).status).toBe("disabled");
  });

  it("clear removes every workspace generation without touching settings", () => {
    const storage = memoryStorage({
      [WORKSPACE_STATE_STORAGE_KEY]: "saved",
      [WORKSPACE_STATE_PREVIOUS_KEY]: "previous",
      ...Object.fromEntries(
        LEGACY_WORKSPACE_STORAGE_KEYS.map((key, index) => [key, `legacy-${index}`]),
      ),
      "tonymux.settings.v3": "settings",
    });

    clearWorkspaceState(storage);
    expect(storage.has(WORKSPACE_STATE_STORAGE_KEY)).toBe(false);
    expect(storage.has(WORKSPACE_STATE_PREVIOUS_KEY)).toBe(false);
    for (const key of LEGACY_WORKSPACE_STORAGE_KEYS) expect(storage.has(key)).toBe(false);
    expect(storage.value("tonymux.settings.v3")).toBe("settings");
  });
});
