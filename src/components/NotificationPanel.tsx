import { Bell, BellOff, CheckCheck, Globe2, Terminal, X } from "lucide-react";
import { useEffect } from "react";
import type { NotificationItem } from "../notificationModel";

type NotificationPanelProps = {
  items: NotificationItem[];
  onJump: (item: NotificationItem) => void;
  onClearPane: (paneId: string) => void;
  onClearAll: () => void;
  onClose: () => void;
};

/**
 * Focused list of outstanding agent-attention notifications across all
 * workspaces. Clicking a row jumps to its pane; a per-row dismiss button
 * clears that single notification; the footer clears everything.
 */
export function NotificationPanel({
  items,
  onJump,
  onClearPane,
  onClearAll,
  onClose,
}: NotificationPanelProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="notification-panel" role="dialog" aria-modal="true" aria-label="Notifications">
      <div className="notification-panel__header">
        <span className="notification-panel__title">
          <Bell size={14} />
          Notifications
          {items.length > 0 && (
            <span className="notification-panel__count">{items.length}</span>
          )}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={onClose}
          aria-label="Close notifications"
          title="Close (Esc)"
        >
          <X size={14} />
        </button>
      </div>

      {items.length === 0 ? (
        <div className="notification-panel__empty">
          <BellOff size={20} />
          <span>No unread notifications</span>
        </div>
      ) : (
        <ul className="notification-panel__list">
          {items.map((item) => (
            <li key={item.paneId} className="notification-panel__item">
              <button
                type="button"
                className="notification-panel__item-main"
                onClick={() => onJump(item)}
              >
                <span className="notification-panel__item-kind" aria-hidden="true">
                  {item.kind === "browser" ? <Globe2 size={12} /> : <Terminal size={12} />}
                </span>
                <span className="notification-panel__item-body">
                  <span className="notification-panel__item-title">
                    {item.workspaceTitle} / {item.paneTitle}
                  </span>
                  <span className="notification-panel__item-message">{item.message}</span>
                </span>
              </button>
              <button
                type="button"
                className="notification-panel__item-clear"
                onClick={() => onClearPane(item.paneId)}
                aria-label={`Dismiss notification from ${item.paneTitle}`}
                title="Dismiss"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}

      {items.length > 0 && (
        <div className="notification-panel__footer">
          <button type="button" className="toolbar-button" onClick={onClearAll}>
            <CheckCheck size={14} />
            <span>Mark all as read</span>
          </button>
        </div>
      )}
    </div>
  );
}
