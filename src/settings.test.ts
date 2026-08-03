import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUT_BINDINGS } from "./shortcuts";
import {
  DEFAULT_SETTINGS,
  LEGACY_SETTINGS_STORAGE_KEYS,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  exportSettings,
  importSettings,
  loadSettings,
  normalizeSettings,
  normalizeTerminalPaneSettings,
  saveSettings,
  snapshotTerminalSettings,
  validateSettings,
} from "./settings";

describe("settings schema", () => {
  it("normalizes unknown input to versioned defaults", () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(normalizeSettings({ version: 99, defaultShellProfileId: "unknown" })).toEqual(
      DEFAULT_SETTINGS,
    );
  });

  it("migrates legacy unversioned names and clamps numeric values", () => {
    const migrated = normalizeSettings({
      shellProfileId: "powershell-7",
      workingDirectory: " C:\\code ",
      startupCommand: " npm run dev ",
      terminal: {
        fontFamily: "Cascadia Mono",
        fontSize: 80,
        lineHeight: 0,
        cursorStyle: "block",
        cursorBlink: false,
        scrollback: 500_000,
      },
    });

    expect(migrated).toMatchObject({
      version: SETTINGS_VERSION,
      defaultShellProfileId: "powershell-7",
      defaultWorkingDirectory: "C:\\code",
      startupCommand: "npm run dev",
      terminal: {
        fontFamily: "Cascadia Mono",
        fontSize: 24,
        lineHeight: 1,
        cursorStyle: "block",
        cursorBlink: false,
        scrollback: 100_000,
      },
    });
  });

  it("migrates a legacy settings key and persists workspace restore preferences", () => {
    const values = new Map<string, string>([
      [
        LEGACY_SETTINGS_STORAGE_KEYS[0],
        JSON.stringify({
          version: 1,
          defaultShellProfileId: "wsl",
          persistence: { restoreWorkspaces: false, terminalHistoryLines: 750 },
        }),
      ],
    ]);
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
      removeItem: (key: string) => void values.delete(key),
    };

    const loaded = loadSettings(storage);
    expect(loaded.defaultShellProfileId).toBe("wsl");
    expect(loaded.persistence.restoreWorkspaces).toBe(false);
    expect(loaded.persistence.terminalHistoryLines).toBe(750);

    saveSettings(loaded, storage);
    expect(values.has(SETTINGS_STORAGE_KEY)).toBe(true);
    expect(values.has(LEGACY_SETTINGS_STORAGE_KEYS[0])).toBe(false);
  });

  it("clamps restored terminal history retention and supports disabling it", () => {
    expect(
      normalizeSettings({ persistence: { terminalHistoryLines: -10 } }).persistence
        .terminalHistoryLines,
    ).toBe(0);
    expect(
      normalizeSettings({ persistence: { terminalHistoryLines: 99_999 } }).persistence
        .terminalHistoryLines,
    ).toBe(5_000);
  });


  it("migrates settings v3 to versioned shortcut defaults", () => {
    const migrated = normalizeSettings({
      version: 3,
      defaultShellProfileId: "powershell-7",
      persistence: { restoreWorkspaces: true, terminalHistoryLines: 800 },
    });
    expect(migrated.version).toBe(SETTINGS_VERSION);
    expect(migrated.shortcuts).toEqual(DEFAULT_SHORTCUT_BINDINGS);
  });

  it("preserves valid custom and explicitly unbound shortcuts", () => {
    const normalized = normalizeSettings({
      shortcuts: {
        "settings.open": "Alt+KeyS",
        "commandPalette.open": null,
      },
    });
    expect(normalized.shortcuts["settings.open"]).toBe("Alt+KeyS");
    expect(normalized.shortcuts["commandPalette.open"]).toBeNull();
    expect(normalized.shortcuts["workspace.new"]).toBe(
      DEFAULT_SHORTCUT_BINDINGS["workspace.new"],
    );
  });

  it("rejects duplicate shortcut imports with action names", () => {
    const duplicate = {
      ...DEFAULT_SETTINGS,
      shortcuts: {
        ...DEFAULT_SETTINGS.shortcuts,
        "workspace.new": DEFAULT_SETTINGS.shortcuts["commandPalette.open"],
      },
    };
    expect(validateSettings(duplicate)).toEqual([
      "Shortcut Ctrl+KeyK is assigned to both Open command palette and New workspace.",
    ]);
    expect(() => importSettings(JSON.stringify(duplicate))).toThrow(
      /Open command palette and New workspace/,
    );
  });

  it("recovers tampered persisted conflicts without discarding unrelated settings", () => {
    const values = new Map<string, string>([[
      SETTINGS_STORAGE_KEY,
      JSON.stringify({
        defaultShellProfileId: "wsl",
        shortcuts: {
          "settings.open": "Ctrl+KeyK",
          "commandPalette.open": "Ctrl+KeyK",
        },
      }),
    ]]);
    const loaded = loadSettings({ getItem: (key: string) => values.get(key) ?? null });
    expect(loaded.defaultShellProfileId).toBe("wsl");
    expect(loaded.shortcuts).toEqual(DEFAULT_SHORTCUT_BINDINGS);
  });

  it("snapshots terminal settings without retaining mutable references", () => {
    const snapshot = snapshotTerminalSettings(DEFAULT_SETTINGS);
    snapshot.appearance.fontSize = 18;
    const loaded = loadSettings({ getItem: () => null });
    loaded.shortcuts["settings.open"] = null;
    expect(DEFAULT_SETTINGS.terminal.fontSize).toBe(13);
    expect(DEFAULT_SETTINGS.shortcuts["settings.open"]).toBe("Ctrl+Comma");
  });

  it("normalizes persisted pane snapshots with current settings as fallback", () => {
    const pane = normalizeTerminalPaneSettings(
      {
        shellProfileId: "wsl",
        startupCommand: "pwd",
        appearance: { fontSize: 15, cursorStyle: "underline" },
      },
      DEFAULT_SETTINGS,
    );

    expect(pane.shellProfileId).toBe("wsl");
    expect(pane.workingDirectory).toBe("");
    expect(pane.startupCommand).toBe("pwd");
    expect(pane.appearance.fontSize).toBe(15);
    expect(pane.appearance.cursorStyle).toBe("underline");
    expect(pane.appearance.scrollback).toBe(DEFAULT_SETTINGS.terminal.scrollback);
  });

  it("round-trips exported settings without secrets", () => {
    const exported = exportSettings({
      ...DEFAULT_SETTINGS,
      defaultShellProfileId: "command-prompt",
    });
    expect(exported).not.toContain("token");
    expect(importSettings(exported).defaultShellProfileId).toBe("command-prompt");
  });

  it("rejects multiline paths and startup commands", () => {
    expect(
      validateSettings({
        ...DEFAULT_SETTINGS,
        defaultWorkingDirectory: "C:\\code\nother",
        startupCommand: "echo one\necho two",
      }),
    ).toHaveLength(2);
  });
});
