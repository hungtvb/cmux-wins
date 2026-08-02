import { describe, expect, it } from "vitest";
import { clampSplitRatio } from "./ResizablePaneGrid";

describe("clampSplitRatio", () => {
  it("keeps a usable minimum and maximum pane width", () => {
    expect(clampSplitRatio(10)).toBe(28);
    expect(clampSplitRatio(90)).toBe(72);
  });

  it("rounds noisy pointer values without changing valid ratios", () => {
    expect(clampSplitRatio(50)).toBe(50);
    expect(clampSplitRatio(43.867)).toBe(43.9);
  });
});
