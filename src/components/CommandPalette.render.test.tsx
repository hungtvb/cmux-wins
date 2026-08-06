import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette";
import type { CommandPaletteItem } from "./commandPaletteModel";

const items: CommandPaletteItem[] = [
  {
    id: "new-workspace",
    label: "New workspace",
    description: "Create a developer workspace",
    section: "Workspace",
    run: vi.fn(),
  },
  {
    id: "split-terminal",
    label: "Split terminal",
    description: "Add a ConPTY pane",
    section: "Pane",
    shortcut: "Ctrl+Shift+T",
    run: vi.fn(),
  },
  {
    id: "open-browser",
    label: "Open browser pane",
    description: "Add a WebView2 pane",
    section: "Pane",
    run: vi.fn(),
  },
];

describe("CommandPalette", () => {
  it("keeps focus on the combobox while exposing grouped listbox options", () => {
    const markup = renderToStaticMarkup(
      <CommandPalette open items={items} onClose={vi.fn()} />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('role="combobox"');
    expect(markup).toContain('role="listbox"');
    expect(markup.match(/role="group"/g)).toHaveLength(2);
    expect(markup.match(/role="option"/g)).toHaveLength(3);
    expect(markup.match(/tabindex="-1"/g)).toHaveLength(3);
    expect(markup).toContain('aria-describedby="command-palette-status"');
    expect(markup).toContain("3 commands available");
  });
});
