import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BrowserPane } from "./BrowserPane";

describe("BrowserPane", () => {
  it("labels the native browser surface and disables navigation until WebView2 is ready", () => {
    const markup = renderToStaticMarkup(
      <BrowserPane
        paneId="browser-1"
        title="TonyMux docs"
        url="https://github.com/hungtvb/cmux-wins"
        active
        focused
        onFocus={vi.fn()}
        onUrlChange={vi.fn()}
        onTitleChange={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Browser pane: TonyMux docs"');
    expect(markup).toContain('type="text"');
    expect(markup).toContain('inputMode="url"');
    expect(markup.match(/disabled=""/g)).toHaveLength(3);
    expect(markup).toContain('role="status"');
    expect(markup).toContain("WebView2 browser surface");
  });
});
