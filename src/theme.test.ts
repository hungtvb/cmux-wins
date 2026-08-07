import { afterEach, describe, expect, it, vi } from "vitest";
import { getInitialTheme, watchSystemTheme } from "./theme";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getInitialTheme", () => {
  it("returns dark when document is undefined", () => {
    const original = globalThis.document;
    (globalThis as { document?: unknown }).document = undefined;
    expect(getInitialTheme()).toBe("dark");
    (globalThis as { document?: unknown }).document = original;
  });

  it("uses the persisted data-theme when set", () => {
    (globalThis as { document?: unknown }).document = {
      documentElement: { dataset: { theme: "light" } },
    } as never;
    expect(getInitialTheme()).toBe("light");
    (globalThis as { document?: unknown }).document = {
      documentElement: { dataset: { theme: "dark" } },
    } as never;
    expect(getInitialTheme()).toBe("dark");
  });

  it("falls back to prefers-color-scheme when nothing is persisted", () => {
    (globalThis as { document?: unknown }).document = {
      documentElement: { dataset: {} },
    } as never;
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: true }),
    } as never;
    expect(getInitialTheme()).toBe("light");
    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: false }),
    } as never;
    expect(getInitialTheme()).toBe("dark");
  });
});

describe("watchSystemTheme", () => {
  it("returns a no-op disposer and does not throw when matchMedia is missing", () => {
    (globalThis as { matchMedia?: unknown }).matchMedia = undefined;
    (globalThis as { document?: unknown }).document = {
      documentElement: { dataset: { theme: "dark" } },
      dispatchEvent: () => true,
    } as never;
    (globalThis as { window?: unknown }).window = {
      localStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined },
    };
    expect(() => watchSystemTheme()).not.toThrow();
  });
});