import { BellRing, GitPullRequest, Plus, SquareTerminal, X } from "lucide-react";
import type { Workspace, WorkspaceMetadata } from "../types";

type WorkspaceSidebarProps = {
  workspaces: Workspace[];
  metadataByWorkspace: Record<string, WorkspaceMetadata | undefined>;
  activeWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onAdd: () => void;
  onClose: (workspaceId: string) => void;
};

function metadataLabel(workspace: Workspace, metadata?: WorkspaceMetadata): string {
  if (!metadata?.available) return workspace.cwd || "PowerShell";

  const repository = metadata.repository || "Git repository";
  const branch = metadata.branch || "unknown branch";
  return `${repository} · ${branch}${metadata.dirty ? " *" : ""}`;
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
        <div className="sidebar__logo">cm</div>
        <div>
          <strong>cmux</strong>
          <span>Windows</span>
        </div>
      </div>

      <div className="sidebar__section-label">
        <span>Workspaces</span>
        <button
          className="icon-button"
          type="button"
          title="New workspace (Ctrl+N)"
          aria-label="New workspace"
          onClick={onAdd}
        >
          <Plus size={16} />
        </button>
      </div>

      <nav className="workspace-list" aria-label="Workspaces">
        {workspaces.map((workspace, index) => {
          const metadata = metadataByWorkspace[workspace.id];
          const hasStatus = Boolean(
            metadata?.pullRequest ||
              metadata?.ahead ||
              metadata?.behind ||
              metadata?.listeningPorts.length,
          );

          return (
            <div className="workspace-item-row" key={workspace.id}>
              <button
                className={`workspace-item${workspace.id === activeWorkspaceId ? " workspace-item--active" : ""}`}
                type="button"
                onClick={() => onSelect(workspace.id)}
                title={`Open ${workspace.title}${index < 9 ? ` (Ctrl+${index + 1})` : ""}`}
              >
                <span className="workspace-item__shortcut">{index + 1}</span>
                <SquareTerminal size={16} />
                <span className="workspace-item__body">
                  <strong>{workspace.title}</strong>
                  <small>{metadataLabel(workspace, metadata)}</small>
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
                          :{port}
                        </span>
                      ))}
                    </span>
                  )}
                </span>
                {workspace.unread && <BellRing className="workspace-item__alert" size={15} />}
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
        <span className="status-dot" />
        Windows terminal host
      </div>
    </aside>
  );
}
