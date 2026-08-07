import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { ShortcutHints } from "./ShortcutHints";

const STORAGE_KEY = "tonymux.shortcut-hints-dismissed";

function mockStorage(value: string | null, throws = false) {
  const store: Record<string, string> =
    value === null ? {} : { [STORAGE_KEY]: value };
  const getItem = vi.fn((key: string) => {
    if (throws) throw new Error("quota");
    return store[key] ?? null;
  });
  const setItem = vi.fn((key: string, val: string) => {
    if (throws) throw new Error("quota");
    store[key] = val;
  });
  const removeItem = vi.fn((key: string) => {
    delete store[key];
  });
  vi.stubGlobal("localStorage", { getItem, setItem, removeItem });
  return { getItem, setItem, store };
}

function cleanup() {
  vi.unstubAllGlobals();
  (globalThis as { localStorage?: unknown }).localStorage = undefined;
}

describe("ShortcutHints", () => {
  afterEach(cleanup);

  it("renders the hints when not yet dismissed", () => {
    const { getItem } = mockStorage(null);
    vi.stubGlobal("window", {});
    const markup = renderToStaticMarkup(<ShortcutHints settings={DEFAULT_SETTINGS} />);
    expect(markup).toContain("Shortcuts");
    expect(markup).toContain("Open command palette");
    expect(markup).toContain("Ctrl");
    expect(getItem).toHaveBeenCalledWith(STORAGE_KEY);
  });

  it("renders nothing once dismissed in storage", () => {
    mockStorage("1");
    vi.stubGlobal("window", {});
    const markup = renderToStaticMarkup(<ShortcutHints settings={DEFAULT_SETTINGS} />);
    expect(markup).toBe("");
  });
});