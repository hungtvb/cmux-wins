import {
  BellRing,
  GitBranch,
  GitPullRequest,
  Plus,
  Radio,
  SquareTerminal,
  X,
} from "lucide-react";
import type { Workspace, WorkspaceMetadata } from "../types";

type WorkspaceSidebarProps = {
  workspaces: Workspace[];
  metadataByWorkspace: Record<string, WorkspaceMetadata | undefined>;
  activeWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onAdd: () => void;
  onClose: (workspaceId: string) => void;
};

function workspaceContext(workspace: Workspace, metadata?: WorkspaceMetadata): string {
  if (!metadata?.available) return workspace.cwd || "PowerShell";
  return metadata.repository || workspace.cwd || "Git repository";
}

function workspaceBranch(metadata?: WorkspaceMetadata): string | null {
  if (!metadata?.available) return null;
  return metadata.branch || "detached HEAD";
}

export function WorkspaceSidebar({
  workspaces,
  metadataByWorkspace,
  activeWorkspaceId,
  onSelect,
  onAdd,
  onClose,
}: WorkspaceSidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <div className="sidebar__logo">TM</div>
        <div className="sidebar__brand-copy">
          <strong>TonyMux</strong>
          <span>Developer workspace</span>
        </div>
        <span className="sidebar__platform">Windows</span>
      </div>

      <div className="sidebar__section-label">
        <span>
          Workspaces
          <strong>{workspaces.length}</strong>
        </span>
        <button
          className="sidebar__add-button"
          type="button"
          title="New workspace (Ctrl+N)"
          aria-label="New workspace"
          onClick={onAdd}
        >
          <Plus size={14} />
          New
        </button>
      </div>

      <nav className="workspace-list" aria-label="Workspaces">
        {workspaces.map((workspace, index) => {
          const metadata = metadataByWorkspace[workspace.id];
          const branch = workspaceBranch(metadata);
          const hasStatus = Boolean(
            metadata?.pullRequest ||
              metadata?.ahead ||
              metadata?.behind ||
              metadata?.listeningPorts.length,
          );
          const active = workspace.id === activeWorkspaceId;

          return (
            <div className="workspace-item-row" key={workspace.id}>
              <button
                className={`workspace-item${active ? " workspace-item--active" : ""}`}
                type="button"
                onClick={() => onSelect(workspace.id)}
                title={`Open ${workspace.title}${index < 9 ? ` (Ctrl+${index + 1})` : ""}`}
                aria-current={active ? "page" : undefined}
              >
                <span className="workspace-item__shortcut">{index + 1}</span>
                <span className="workspace-item__icon">
                  <SquareTerminal size={15} />
                  {metadata?.dirty && <span className="workspace-item__dirty" title="Modified" />}
                </span>
                <span className="workspace-item__body">
                  <span className="workspace-item__heading">
                    <strong>{workspace.title}</strong>
                    {workspace.unread && (
                      <BellRing
                        className="workspace-item__alert"
                        size={14}
                        aria-label="Unread agent alert"
                      />
                    )}
                  </span>
                  <small>{workspaceContext(workspace, metadata)}</small>
                  {branch && (
                    <span className="workspace-item__branch" title={branch}>
                      <GitBranch size={10} />
                      {branch}
                    </span>
                  )}
                  {hasStatus && (
                    <span className="workspace-item__metadata" aria-label="Workspace metadata">
                      {metadata?.pullRequest && (
                        <span title={metadata.pullRequest.title}>
                          <GitPullRequest size={11} />#{metadata.pullRequest.number}
                        </span>
                      )}
                      {Boolean(metadata?.ahead) && <span title="Commits ahead">↑{metadata?.ahead}</span>}
                      {Boolean(metadata?.behind) && <span title="Commits behind">↓{metadata?.behind}</span>}
                      {metadata?.listeningPorts.map((port) => (
                        <span key={port} title={`Listening on localhost:${port}`}>
                          <Radio size={9} />:{port}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
              </button>
              <button
                className="workspace-item__close"
                type="button"
                aria-label={`Close ${workspace.title}`}
                title="Close workspace"
                onClick={() => onClose(workspace.id)}
              >
                <X size={13} />
              </button>
            </div>
          );
        })}
      </nav>

      <div className="sidebar__footer">
        <span className="sidebar__host-status">
          <span className="status-dot" />
          Terminal host online
        </span>
        <kbd>Ctrl B</kbd>
      </div>
    </aside>
  );
}
