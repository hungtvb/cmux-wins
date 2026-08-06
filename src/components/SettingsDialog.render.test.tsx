import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../settings";
import { SettingsDialog } from "./SettingsDialog";

describe("SettingsDialog", () => {
  it("renders the approved settings hierarchy with labelled modal controls", () => {
    const markup = renderToStaticMarkup(
      <SettingsDialog
        open
        settings={DEFAULT_SETTINGS}
        onSave={vi.fn()}
        onClearWorkspaceState={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain("TonyMux settings");
    expect(markup).toContain("Shell profile");
    expect(markup).toContain("Terminal appearance");
    expect(markup).toContain("Keyboard shortcuts");
    expect(markup).toContain("Workspace restore");
    expect(markup).toContain('aria-label="Close settings"');
    expect(markup).toContain("Save settings");
    expect(markup).not.toContain('aria-label="Settings errors"');
  });
});
