import { BellRing, Plus, SquareTerminal } from "lucide-react";
import type { Workspace } from "../types";

type WorkspaceSidebarProps = {
  workspaces: Workspace[];
  activeWorkspaceId: string;
  onSelect: (workspaceId: string) => void;
  onAdd: () => void;
};

export function WorkspaceSidebar({
  workspaces,
  activeWorkspaceId,
  onSelect,
  onAdd,
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
          title="New workspace"
          aria-label="New workspace"
          onClick={onAdd}
        >
          <Plus size={16} />
        </button>
      </div>

      <nav className="workspace-list" aria-label="Workspaces">
        {workspaces.map((workspace, index) => (
          <button
            className={`workspace-item${workspace.id === activeWorkspaceId ? " workspace-item--active" : ""}`}
            type="button"
            key={workspace.id}
            onClick={() => onSelect(workspace.id)}
          >
            <span className="workspace-item__shortcut">{index + 1}</span>
            <SquareTerminal size={16} />
            <span className="workspace-item__body">
              <strong>{workspace.title}</strong>
              <small>{workspace.cwd || "PowerShell"}</small>
            </span>
            {workspace.unread && <BellRing className="workspace-item__alert" size={15} />}
          </button>
        ))}
      </nav>

      <div className="sidebar__footer">
        <span className="status-dot" />
        Windows terminal host
      </div>
    </aside>
  );
}
