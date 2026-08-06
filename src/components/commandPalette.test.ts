import { describe, expect, it, vi } from "vitest";
import { filterCommandPaletteItems, type CommandPaletteItem } from "./commandPaletteModel";

const noop = vi.fn();
const items: CommandPaletteItem[] = [
  {
    id: "browser",
    label: "Open browser pane",
    description: "Create a WebView2 pane",
    keywords: ["web", "url"],
    section: "Pane",
    run: noop,
  },
  {
    id: "workspace",
    label: "New workspace",
    description: "Create a local developer workspace",
    keywords: ["project", "folder"],
    section: "Workspace",
    run: noop,
  },
  {
    id: "terminal",
    label: "Split terminal",
    description: "Add another terminal pane",
    keywords: ["shell", "powershell"],
    section: "Pane",
    run: noop,
  },
];

describe("filterCommandPaletteItems", () => {
  it("keeps original command order for an empty query", () => {
    expect(filterCommandPaletteItems(items, "")).toEqual(items);
  });

  it("matches labels, descriptions, sections, and keywords", () => {
    expect(filterCommandPaletteItems(items, "browser").map((item) => item.id)).toEqual(["browser"]);
    expect(filterCommandPaletteItems(items, "webview").map((item) => item.id)).toEqual(["browser"]);
    expect(filterCommandPaletteItems(items, "workspace").map((item) => item.id)).toEqual(["workspace"]);
    expect(filterCommandPaletteItems(items, "powershell").map((item) => item.id)).toEqual(["terminal"]);
  });

  it("ranks an exact or prefix label match before weaker matches", () => {
    const ranked = filterCommandPaletteItems(
      [
        { ...items[1], id: "keyword", label: "Create project", keywords: ["workspace"] },
        items[1],
      ],
      "workspace",
    );

    expect(ranked.map((item) => item.id)).toEqual(["workspace", "keyword"]);
  });
});
