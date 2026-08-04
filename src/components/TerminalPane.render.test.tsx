import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TerminalPane } from "./TerminalPane";

vi.mock("../hooks/useTerminalSession", () => ({
  useTerminalSession: () => ({ current: null }),
}));

describe("TerminalPane", () => {
  it("renders focused, restored, and human-attention states explicitly", () => {
    const markup = renderToStaticMarkup(
      <TerminalPane
        workspaceId="workspace-1"
        sessionId="terminal-1"
        title="Agent shell"
        cwd="C:\\src\\tonymux"
        restored
        restoredHistory={"npm test\n73 passed"}
        historyLineLimit={500}
        attention
        focused
        onFocus={vi.fn()}
        onHistoryChange={vi.fn()}
        onAttention={vi.fn()}
        onTitleChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Terminal pane: Agent shell"');
    expect(markup).toContain(">Needs input<");
    expect(markup).toContain(">Active<");
    expect(markup).toContain("Restored terminal history");
    expect(markup).toContain("New shell below");
  });
});
