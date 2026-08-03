import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  exportSettings,
  importSettings,
  normalizeSettings,
  normalizeTerminalPaneSettings,
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

  it("snapshots terminal settings without retaining mutable references", () => {
    const snapshot = snapshotTerminalSettings(DEFAULT_SETTINGS);
    snapshot.appearance.fontSize = 18;
    expect(DEFAULT_SETTINGS.terminal.fontSize).toBe(13);
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
