import { describe, expect, it } from "vitest";
import { saveSettings, loadSettings, DEFAULT_SETTINGS } from "./settings";
import {
  loadWorkspaceState,
  saveWorkspaceState,
  clearWorkspaceState,
} from "./workspacePersistence";

describe("settings save resilience", () => {
  it("does not throw when storage.setItem fails (quota/security)", () => {
    const failingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() =>
      saveSettings({ ...DEFAULT_SETTINGS, defaultWorkingDirectory: "C:\\dev" }, failingStorage),
    ).not.toThrow();
  });

  it("falls back to defaults when getItem throws", () => {
    const throwing = {
      getItem: () => {
        throw new Error("unavailable");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    expect(loadSettings(throwing)).toBeDefined();
    expect(loadSettings(throwing).customShellProfiles).toBeDefined();
  });
});

describe("workspace persistence resilience", () => {
  it("recovers to a fresh state when storage reads fail", () => {
    const throwing = {
      getItem: () => {
        throw new Error("storage unavailable");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const result = loadWorkspaceState(DEFAULT_SETTINGS, throwing);
    expect(result.status).toBe("empty");
    expect(result.state.workspaces).toBeDefined();
  });

  it("does not throw when saving to failing storage", () => {
    const failing = {
      getItem: () => null,
      setItem: () => {
        throw new Error("QuotaExceededError");
      },
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() =>
      saveWorkspaceState(
        { workspaces: [], activeWorkspaceId: "", splitRatios: {}, attention: {} },
        DEFAULT_SETTINGS,
        failing,
      ),
    ).not.toThrow();
  });

  it("does not throw when clearing failing storage", () => {
    const failing = {
      getItem: () => null,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("SecurityError");
      },
    };
    expect(() => clearWorkspaceState(failing)).not.toThrow();
  });
});