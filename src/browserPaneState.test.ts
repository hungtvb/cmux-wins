import { describe, expect, it } from "vitest";
import {
  feedbackForBrowserEvent,
  normalizeBrowserEventUrl,
  normalizeBrowserPaneEvent,
} from "./browserPaneState";

describe("browser pane state", () => {
  it("normalizes bounded HTTP(S) lifecycle events", () => {
    expect(
      normalizeBrowserPaneEvent({
        paneId: "pane-1",
        kind: "load-started",
        url: "https://example.com/docs",
      }),
    ).toEqual({
      paneId: "pane-1",
      kind: "load-started",
      url: "https://example.com/docs",
    });
  });

  it("rejects unsafe or credential-bearing event URLs", () => {
    expect(normalizeBrowserEventUrl("javascript:alert(1)")).toBeUndefined();
    expect(normalizeBrowserEventUrl("https://user:secret@example.com")).toBeUndefined();
    expect(normalizeBrowserEventUrl("https://example.com")).toBe("https://example.com/");
  });

  it("rejects malformed pane identifiers and unknown event kinds", () => {
    expect(normalizeBrowserPaneEvent({ paneId: "pane/1", kind: "load-started" })).toBeNull();
    expect(normalizeBrowserPaneEvent({ paneId: "pane-1", kind: "arbitrary" })).toBeNull();
  });

  it("bounds and sanitizes title and message text", () => {
    const event = normalizeBrowserPaneEvent({
      paneId: "pane-1",
      kind: "title-changed",
      title: `${"é".repeat(140)}\r\nignored`,
      message: " hello\0\tworld\u007f\u202e ",
    });

    expect(event?.title).toHaveLength(128);
    expect(event?.title).not.toContain("\r");
    expect(event?.message).toBe("hello  world");
  });

  it("maps blocked popup and download events to visible non-retry notices", () => {
    const popup = normalizeBrowserPaneEvent({
      paneId: "pane-1",
      kind: "new-window-blocked",
      message: "Popup blocked",
    });
    const download = normalizeBrowserPaneEvent({
      paneId: "pane-1",
      kind: "download-blocked",
    });

    expect(popup && feedbackForBrowserEvent(popup)).toEqual({
      tone: "notice",
      message: "Popup blocked",
      retryable: false,
    });
    expect(download && feedbackForBrowserEvent(download)).toEqual({
      tone: "notice",
      message: "TonyMux blocked a browser download.",
      retryable: false,
    });
  });

  it("does not produce feedback for normal load and title events", () => {
    const event = normalizeBrowserPaneEvent({ paneId: "pane-1", kind: "load-finished" });
    expect(event && feedbackForBrowserEvent(event)).toBeNull();
  });
});
