import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NotificationPanel } from "./NotificationPanel";
import type { NotificationItem } from "../notificationModel";

const items: NotificationItem[] = [
  {
    paneId: "pane-1",
    workspaceId: "ws-1",
    workspaceTitle: "Agent",
    paneTitle: "PowerShell",
    message: "Tests failed",
    kind: "terminal",
  },
  {
    paneId: "pane-2",
    workspaceId: "ws-2",
    workspaceTitle: "Docs",
    paneTitle: "GitHub",
    message: "PR ready for review",
    kind: "browser",
  },
];

function renderPanel(itemList: NotificationItem[] = items) {
  return renderToStaticMarkup(
    <NotificationPanel
      items={itemList}
      onJump={vi.fn()}
      onClearPane={vi.fn()}
      onClearAll={vi.fn()}
      onClose={vi.fn()}
    />,
  );
}

describe("NotificationPanel", () => {
  it("renders a labelled dialog with one row per notification", () => {
    const markup = renderPanel();

    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Notifications"');
    expect(markup).toContain("Notifications");
    expect(markup.match(/notification-panel__item-main/g)).toHaveLength(2);
  });

  it("shows workspace, pane and message context per row", () => {
    const markup = renderPanel();

    expect(markup).toContain("Agent / PowerShell");
    expect(markup).toContain("Tests failed");
    expect(markup).toContain("Docs / GitHub");
    expect(markup).toContain("PR ready for review");
  });

  it("exposes jump and dismiss controls per row plus mark-all", () => {
    const markup = renderPanel();

    expect(markup).toContain("Mark all as read");
    expect(markup).toContain('aria-label="Dismiss notification from PowerShell"');
    expect(markup).toContain('aria-label="Dismiss notification from GitHub"');
    expect(markup).toContain('aria-label="Close notifications"');
  });

  it("shows the unread count badge in the header", () => {
    const markup = renderPanel();
    expect(markup).toContain('class="notification-panel__count"');
    expect(markup).toContain(">2<");
  });

  it("renders an empty state when there are no notifications", () => {
    const markup = renderPanel([]);

    expect(markup).toContain("No unread notifications");
    expect(markup).not.toContain("Mark all as read");
    expect(markup).not.toContain("notification-panel__count");
  });
});
