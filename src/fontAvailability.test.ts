import { describe, expect, it, vi, afterEach } from "vitest";
import { checkFontAvailability, extractFamilies } from "./fontAvailability";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractFamilies", () => {
  it("splits and unquotes a font stack", () => {
    expect(extractFamilies('"JetBrains Mono", "SFMono-Regular", Consolas, monospace')).toEqual([
      "JetBrains Mono",
      "SFMono-Regular",
      "Consolas",
      "monospace",
    ]);
  });

  it("handles empty and whitespace input", () => {
    expect(extractFamilies("")).toEqual([]);
    expect(extractFamilies("   ")).toEqual([]);
  });
});

describe("checkFontAvailability", () => {
  it("returns unknown when document.fonts is unavailable", () => {
    (globalThis as { document?: unknown }).document = undefined;
    expect(checkFontAvailability("Foo, monospace")).toEqual({
      family: "Foo, monospace",
      status: "unknown",
      missingFamily: null,
    });
  });

  it("reports available when the first explicit family resolves", () => {
    const fonts = {
      check: vi.fn((font: string) => font.includes("JetBrains Mono")),
    };
    (globalThis as { document?: unknown }).document = {
      fonts,
    } as never;
    const result = checkFontAvailability('"JetBrains Mono", monospace');
    expect(result.status).toBe("available");
    expect(fonts.check).toHaveBeenCalledWith('16px "JetBrains Mono"');
  });

  it("reports unavailable and names the first missing family", () => {
    const fonts = { check: vi.fn(() => false) };
    (globalThis as { document?: unknown }).document = { fonts } as never;
    const result = checkFontAvailability('"MesloLGM Nerd Font", "Meslo LG M", Consolas');
    expect(result.status).toBe("unavailable");
    expect(result.missingFamily).toBe("MesloLGM Nerd Font");
  });

  it("treats a stack of only generics as available", () => {
    const fonts = { check: vi.fn(() => false) };
    (globalThis as { document?: unknown }).document = { fonts } as never;
    expect(checkFontAvailability("monospace, sans-serif").status).toBe("available");
    expect(fonts.check).not.toHaveBeenCalled();
  });
});