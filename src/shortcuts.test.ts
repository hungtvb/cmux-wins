import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  findShortcutConflict,
  findShortcutConflicts,
  formatShortcutBinding,
  getWorkspaceShortcutActionId,
  isEditableShortcutTarget,
  normalizeShortcutBinding,
  normalizeShortcutBindings,
  shortcutFromKeyboardEvent,
  shortcutMatchesEvent,
} from "./shortcuts";

function keyboardEvent(overrides: Partial<Parameters<typeof shortcutFromKeyboardEvent>[0]> = {}) {
  return { altKey: false, ctrlKey: true, shiftKey: false, metaKey: false, code: "KeyK", ...overrides };
}

describe("keyboard shortcuts", () => {
  it("normalizes canonical modifier order and rejects unsafe global bindings", () => {
    expect(normalizeShortcutBinding("Shift+Ctrl+KeyB")).toBe("Ctrl+Shift+KeyB");
    expect(normalizeShortcutBinding("KeyB", "Ctrl+KeyB")).toBe("Ctrl+KeyB");
    expect(normalizeShortcutBinding("Alt+F4", "Ctrl+KeyB")).toBe("Ctrl+KeyB");
    expect(normalizeShortcutBinding("Ctrl+Alt+Delete", null)).toBeNull();
  });

  it("migrates missing and invalid bindings to defaults while preserving unbound actions", () => {
    const normalized = normalizeShortcutBindings({
      "settings.open": null,
      "workspace.new": "not-a-chord",
      "pane.openBrowser": "Alt+KeyG",
    });
    expect(normalized["settings.open"]).toBeNull();
    expect(normalized["workspace.new"]).toBe(DEFAULT_SHORTCUT_BINDINGS["workspace.new"]);
    expect(normalized["pane.openBrowser"]).toBe("Alt+KeyG");
  });

  it("uses KeyboardEvent.code and ignores composition, repeats and the Windows key", () => {
    expect(shortcutFromKeyboardEvent(keyboardEvent({ code: "Comma" }))).toBe("Ctrl+Comma");
    expect(shortcutFromKeyboardEvent(keyboardEvent({ isComposing: true }))).toBeNull();
    expect(shortcutFromKeyboardEvent(keyboardEvent({ repeat: true }))).toBeNull();
    expect(shortcutFromKeyboardEvent(keyboardEvent({ metaKey: true }))).toBeNull();
  });

  it("reserves IME and system chords (Ctrl+Space, Ctrl+Shift, Alt+Space)", () => {
    expect(shortcutFromKeyboardEvent(keyboardEvent({ code: "Space" }))).toBeNull();
    expect(shortcutFromKeyboardEvent(keyboardEvent({ altKey: true, code: "Space" }))).toBeNull();
    expect(normalizeShortcutBinding("Ctrl+Space", "Ctrl+KeyK")).toBe("Ctrl+KeyK");
    expect(normalizeShortcutBinding("Ctrl+Shift", "Ctrl+KeyK")).toBe("Ctrl+KeyK");
  });

  it("matches and formats canonical bindings", () => {
    const event = keyboardEvent({ code: "KeyB", shiftKey: true });
    expect(shortcutMatchesEvent("Ctrl+Shift+KeyB", event)).toBe(true);
    expect(formatShortcutBinding("Ctrl+Shift+KeyB")).toBe("Ctrl + Shift + B");
    expect(formatShortcutBinding(null)).toBe("Unassigned");
  });

  it("reports duplicate assignments with stable action IDs", () => {
    const bindings = { ...DEFAULT_SHORTCUT_BINDINGS, "workspace.new": "Ctrl+KeyK" };
    expect(findShortcutConflict(bindings, "workspace.new", "Ctrl+KeyK")).toBe("commandPalette.open");
    expect(findShortcutConflicts(bindings)).toEqual([{ binding: "Ctrl+KeyK", actionIds: ["commandPalette.open", "workspace.new"] }]);
  });

  it("ignores ordinary form controls but keeps xterm helper input shortcut-enabled", () => {
    expect(isEditableShortcutTarget({ tagName: "INPUT" } as unknown as EventTarget)).toBe(true);
    expect(isEditableShortcutTarget({ tagName: "TEXTAREA", classList: { contains: (name: string) => name === "xterm-helper-textarea" } } as unknown as EventTarget)).toBe(false);
    expect(isEditableShortcutTarget({ tagName: "DIV", isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });

  it("maps workspace slots one through nine and rejects unsupported slots", () => {
    expect(getWorkspaceShortcutActionId(0)).toBe("workspace.select1");
    expect(getWorkspaceShortcutActionId(8)).toBe("workspace.select9");
    expect(getWorkspaceShortcutActionId(9)).toBeNull();
  });
});
