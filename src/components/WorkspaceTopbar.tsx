import {
  Bell,
  Columns2,
  FolderPlus,
  GitBranch,
  Globe2,
  MoreHorizontal,
  Moon,
  PanelLeftClose,
  Search,
  Settings2,
  Sun,
  Trash2,
} from "lucide-react";
import type { MouseEvent } from "react";
import { useState } from "react";
import { ResumeMenu } from "./ResumeMenu";
import type { ResumeRecord } from "../resumeModel";
import type { ShortcutActionId } from "../shortcuts";
import { getCurrentTheme, toggleTheme } from "../theme";
import type { Workspace, WorkspaceMetadata } from "../types";

type WorkspaceTopbarProps = {
  workspace: Workspace;
  metadata?: WorkspaceMetadata;
  sidebarOpen: boolean;
  unreadCount: number;
  notificationsOpen: boolean;
  onToggleSidebar: () => void;
  onOpenCommandPalette: () => void;
  onOpenSettings: () => void;
  shortcutLabel: (actionId: ShortcutActionId) => string | undefined;
  onAddWorkspace: () => void;
  onSplitTerminal: () => void;
  onAddBrowser: () => void;
  onToggleNotifications: () => void;
  onCloseWorkspace: () => void;
  resumeRecords: ResumeRecord[];
  resumeNotice: string | null;
  onResume: (record: ResumeRecord) => void;
};

function closeActionMenu(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

function ThemeToggleButton() {
  const [theme, setThemeState] = useState<"dark" | "light">(getCurrentTheme());
  return (
    <button
      className="toolbar-button toolbar-button--compact"
      type="button"
      onClick={() => setThemeState(toggleTheme())}
      title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
      aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    >
      {theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  );
}

export function WorkspaceTopbar({
  workspace,
  metadata,
  sidebarOpen,
  unreadCount,
  notificationsOpen,
  onToggleSidebar,
  onOpenCommandPalette,
  onOpenSettings,
  shortcutLabel,
  onAddWorkspace,
  onSplitTerminal,
  onAddBrowser,
  onToggleNotifications,
  onCloseWorkspace,
  resumeRecords,
  resumeNotice,
  onResume,
}: WorkspaceTopbarProps) {
  const hasGitMetadata = Boolean(metadata?.available);
  const repository = metadata?.repository || "Local workspace";
  const branch = metadata?.branch || workspace.cwd || "PowerShell · Windows 11";
  const paneLabel = `${workspace.panes.length} pane${workspace.panes.length === 1 ? "" : "s"}`;
  const titleWithShortcut = (label: string, actionId: ShortcutActionId) => {
    const shortcut = shortcutLabel(actionId);
    return shortcut ? `${label} (${shortcut})` : label;
  };

  return (
    <header className="topbar">
      <div className="topbar__leading">
        <button
          className="icon-button topbar__sidebar-toggle"
          type="button"
          title={titleWithShortcut(
            sidebarOpen ? "Hide sidebar" : "Show sidebar",
            "layout.toggleSidebar",
          )}
          aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
          onClick={onToggleSidebar}
        >
          <PanelLeftClose size={17} className={sidebarOpen ? "" : "flip-x"} />
        </button>

        <div className="topbar__identity">
          <div className="topbar__title-row">
            <h1>{workspace.title}</h1>
            {hasGitMetadata && (
              <span
                className={`workspace-state${metadata?.dirty ? " workspace-state--dirty" : ""}`}
                title={metadata?.dirty ? "Workspace has uncommitted changes" : "Working tree is clean"}
              >
                <span />
                {metadata?.dirty ? "Modified" : "Clean"}
              </span>
            )}
          </div>
          <div className="topbar__context" title={`${repository} · ${branch}`}>
            {hasGitMetadata && <GitBranch size={11} />}
            <span>{repository}</span>
            <span className="topbar__context-separator">/</span>
            <strong>{branch}</strong>
            <span className="topbar__context-separator">·</span>
            <span>{paneLabel}</span>
          </div>
        </div>
      </div>

      <div className="topbar__actions">
        <button
          className="toolbar-button toolbar-button--primary"
          type="button"
          onClick={onAddWorkspace}
          title={titleWithShortcut("New workspace", "workspace.new")}
        >
          <FolderPlus size={15} />
          <span>New workspace</span>
        </button>

        <div className="toolbar-group" aria-label="Pane actions">
          <button
            className="toolbar-button toolbar-button--compact"
            type="button"
            onClick={onSplitTerminal}
            title={titleWithShortcut("Split terminal", "pane.splitTerminal")}
            aria-label="Split terminal"
          >
            <Columns2 size={15} />
          </button>
          <button
            className="toolbar-button toolbar-button--compact"
            type="button"
            onClick={onAddBrowser}
            title={titleWithShortcut("Open browser pane", "pane.openBrowser")}
            aria-label="Open browser pane"
          >
            <Globe2 size={15} />
          </button>
          <button
            className={`toolbar-button toolbar-button--compact${unreadCount > 0 ? " toolbar-button--attention" : ""}${notificationsOpen ? " toolbar-button--active" : ""}`}
            type="button"
            onClick={onToggleNotifications}
            title={titleWithShortcut(
              unreadCount > 0
                ? `${unreadCount} unread notification${unreadCount === 1 ? "" : "s"}`
                : "No unread notifications",
              "notifications.toggle",
            )}
            aria-label="Toggle notifications panel"
            aria-expanded={notificationsOpen}
          >
            <Bell size={15} />
            {unreadCount > 0 && <span className="toolbar-button__badge">{unreadCount}</span>}
          </button>
          {resumeRecords.length > 0 && (
            <ResumeMenu
              records={resumeRecords}
              notice={resumeNotice}
              onResume={onResume}
              onOpenSettings={onOpenSettings}
            />
          )}
        </div>

        <button
          className="toolbar-button toolbar-button--command"
          type="button"
          onClick={onOpenCommandPalette}
          title={titleWithShortcut("Command palette", "commandPalette.open")}
          aria-label="Open command palette"
        >
          <Search size={15} />
          <span>Commands</span>
          {shortcutLabel("commandPalette.open") && (
            <kbd>{shortcutLabel("commandPalette.open")}</kbd>
          )}
        </button>

        <ThemeToggleButton />

        <details className="action-menu">
          <summary className="toolbar-button toolbar-button--compact" title="More workspace actions">
            <MoreHorizontal size={16} />
            <span className="sr-only">More workspace actions</span>
          </summary>
          <div className="action-menu__popover">
            <div className="action-menu__label">Application</div>
            <button
              className="action-menu__item"
              type="button"
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                closeActionMenu(event);
                onOpenSettings();
              }}
            >
              <Settings2 size={14} />
              <span>Settings</span>
              {shortcutLabel("settings.open") && (
                <kbd>{shortcutLabel("settings.open")}</kbd>
              )}
            </button>
            <div className="action-menu__label">Workspace</div>
            <button
              className="action-menu__item action-menu__item--danger"
              type="button"
              onClick={(event: MouseEvent<HTMLButtonElement>) => {
                closeActionMenu(event);
                onCloseWorkspace();
              }}
            >
              <Trash2 size={14} />
              <span>Close workspace</span>
              {shortcutLabel("workspace.close") && (
                <kbd>{shortcutLabel("workspace.close")}</kbd>
              )}
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
