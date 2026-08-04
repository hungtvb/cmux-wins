import { describe, expect, it } from "vitest";
import { DEFAULT_SHORTCUT_BINDINGS } from "./shortcuts";
import {
  DEFAULT_SETTINGS,
  LEGACY_SETTINGS_STORAGE_KEYS,
  SETTINGS_STORAGE_KEY,
  SETTINGS_VERSION,
  countCustomShellProfilesUsingExecutable,
  exportSettings,
  importSettings,
  loadSettings,
  normalizeSettings,
  normalizeCustomShellExecutable,
  normalizeTerminalPaneSettings,
  saveSettings,
  snapshotTerminalSettings,
  validateSettings,
  validateCustomShellExecutable,
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

  it("migrates settings v4 to an empty custom shell collection", () => {
    const migrated = normalizeSettings({
      version: 4,
      defaultShellProfileId: "powershell-7",
      shortcuts: DEFAULT_SHORTCUT_BINDINGS,
    });
    expect(migrated.version).toBe(SETTINGS_VERSION);
    expect(migrated.customShellProfiles).toEqual([]);
  });

  it("normalizes bounded custom executable profiles and snapshots the selected path", () => {
    const settings = normalizeSettings({
      defaultShellProfileId: "custom:my_shell_01",
      customShellProfiles: [
        {
          id: "custom:my_shell_01",
          label: "  Nushell  ",
          executable: "c:/Tools/Nushell/nu.exe",
        },
      ],
    });

    expect(settings.customShellProfiles).toEqual([
      {
        id: "custom:my_shell_01",
        label: "Nushell",
        executable: "C:\\Tools\\Nushell\\nu.exe",
      },
    ]);
    expect(snapshotTerminalSettings(settings)).toMatchObject({
      shellProfileId: "custom:my_shell_01",
      customShellExecutable: "C:\\Tools\\Nushell\\nu.exe",
    });
  });

  it("rejects unsafe custom executable paths and allows shared trusted paths", () => {
    expect(validateCustomShellExecutable("shell.exe")).toMatch(/absolute local Windows path/);
    expect(validateCustomShellExecutable("C:\\Tools\\shell.exe --flag")).toMatch(
      /cannot include arguments/,
    );
    expect(normalizeCustomShellExecutable("%LOCALAPPDATA%\\shell.exe")).toBe("");
    expect(validateCustomShellExecutable("C:\\Tools\\shell.exe\n")).toMatch(
      /control characters/,
    );
    expect(normalizeCustomShellExecutable("C:\\Tools\\shell.exe\n")).toBe("");

    const shared = {
      ...DEFAULT_SETTINGS,
      defaultShellProfileId: "custom:profile_one",
      customShellProfiles: [
        {
          id: "custom:profile_one",
          label: "One",
          executable: "C:\\Tools\\Shell.exe",
        },
        {
          id: "custom:profile_two",
          label: "Two",
          executable: "c:/tools/shell.exe",
        },
      ],
    };
    expect(validateSettings(shared)).toEqual([]);
    expect(normalizeSettings(shared).customShellProfiles).toHaveLength(2);
    expect(countCustomShellProfilesUsingExecutable(shared, "C:\\TOOLS\\shell.exe")).toBe(2);
    expect(
      countCustomShellProfilesUsingExecutable(
        shared,
        "C:\\Tools\\Shell.exe",
        "custom:profile_one",
      ),
    ).toBe(1);
  });

  it("falls back when a selected custom profile is missing or malformed", () => {
    expect(
      normalizeSettings({
        defaultShellProfileId: "custom:missing_profile",
        customShellProfiles: [],
      }).defaultShellProfileId,
    ).toBe("windows-powershell");
    expect(
      normalizeSettings({
        defaultShellProfileId: "custom:bad_profile",
        customShellProfiles: [
          {
            id: "custom:bad_profile",
            label: "Bad",
            executable: "..\\shell.exe",
          },
        ],
      }).customShellProfiles,
    ).toEqual([]);
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

  it("preserves a valid custom executable in persisted pane snapshots", () => {
    const pane = normalizeTerminalPaneSettings({
      shellProfileId: "custom:restored_shell",
      customShellExecutable: "c:/Tools/Restored/shell.exe",
      workingDirectory: "C:\\code",
    });
    expect(pane).toMatchObject({
      shellProfileId: "custom:restored_shell",
      customShellExecutable: "C:\\Tools\\Restored\\shell.exe",
      workingDirectory: "C:\\code",
    });
  });

  it("round-trips exported settings without secrets", () => {
    const exported = exportSettings({
      ...DEFAULT_SETTINGS,
      defaultShellProfileId: "custom:export_shell",
      customShellProfiles: [
        {
          id: "custom:export_shell",
          label: "Export shell",
          executable: "C:\\Tools\\export.exe",
        },
      ],
    });
    expect(exported).not.toContain("token");
    expect(exported).not.toContain("trusted");
    expect(importSettings(exported)).toMatchObject({
      defaultShellProfileId: "custom:export_shell",
      customShellProfiles: [
        {
          id: "custom:export_shell",
          label: "Export shell",
          executable: "C:\\Tools\\export.exe",
        },
      ],
    });
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
