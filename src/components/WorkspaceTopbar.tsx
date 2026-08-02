import {
  BellOff,
  Columns2,
  FolderPlus,
  GitBranch,
  Globe2,
  MoreHorizontal,
  PanelLeftClose,
  Trash2,
} from "lucide-react";
import type { MouseEvent } from "react";
import type { Workspace, WorkspaceMetadata } from "../types";

type WorkspaceTopbarProps = {
  workspace: Workspace;
  metadata?: WorkspaceMetadata;
  sidebarOpen: boolean;
  attentionCount: number;
  onToggleSidebar: () => void;
  onAddWorkspace: () => void;
  onSplitTerminal: () => void;
  onAddBrowser: () => void;
  onClearAttention: () => void;
  onCloseWorkspace: () => void;
};

function closeActionMenu(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.closest("details")?.removeAttribute("open");
}

export function WorkspaceTopbar({
  workspace,
  metadata,
  sidebarOpen,
  attentionCount,
  onToggleSidebar,
  onAddWorkspace,
  onSplitTerminal,
  onAddBrowser,
  onClearAttention,
  onCloseWorkspace,
}: WorkspaceTopbarProps) {
  const hasGitMetadata = Boolean(metadata?.available);
  const repository = metadata?.repository || "Local workspace";
  const branch = metadata?.branch || workspace.cwd || "PowerShell · Windows 11";
  const paneLabel = `${workspace.panes.length} pane${workspace.panes.length === 1 ? "" : "s"}`;

  return (
    <header className="topbar">
      <div className="topbar__leading">
        <button
          className="icon-button topbar__sidebar-toggle"
          type="button"
          title={sidebarOpen ? "Hide sidebar (Ctrl+B)" : "Show sidebar (Ctrl+B)"}
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
          title="New workspace (Ctrl+N)"
        >
          <FolderPlus size={15} />
          <span>New workspace</span>
        </button>

        <div className="toolbar-group" aria-label="Pane actions">
          <button
            className="toolbar-button toolbar-button--compact"
            type="button"
            onClick={onSplitTerminal}
            title="Split terminal (Ctrl+Shift+D)"
            aria-label="Split terminal"
          >
            <Columns2 size={15} />
          </button>
          <button
            className="toolbar-button toolbar-button--compact"
            type="button"
            onClick={onAddBrowser}
            title="Open browser pane (Ctrl+Shift+B)"
            aria-label="Open browser pane"
          >
            <Globe2 size={15} />
          </button>
          <button
            className={`toolbar-button toolbar-button--compact${attentionCount > 0 ? " toolbar-button--attention" : ""}`}
            type="button"
            onClick={onClearAttention}
            title={attentionCount > 0 ? `Mark ${attentionCount} alert${attentionCount === 1 ? "" : "s"} as read` : "No unread alerts"}
            aria-label="Mark workspace alerts as read"
            disabled={attentionCount === 0}
          >
            <BellOff size={15} />
            {attentionCount > 0 && <span className="toolbar-button__badge">{attentionCount}</span>}
          </button>
        </div>

        <details className="action-menu">
          <summary className="toolbar-button toolbar-button--compact" title="More workspace actions">
            <MoreHorizontal size={16} />
            <span className="sr-only">More workspace actions</span>
          </summary>
          <div className="action-menu__popover">
            <div className="action-menu__label">Workspace</div>
            <button
              className="action-menu__item action-menu__item--danger"
              type="button"
              onClick={(event) => {
                closeActionMenu(event);
                onCloseWorkspace();
              }}
            >
              <Trash2 size={14} />
              <span>Close workspace</span>
              <kbd>Ctrl ⇧ W</kbd>
            </button>
          </div>
        </details>
      </div>
    </header>
  );
}
