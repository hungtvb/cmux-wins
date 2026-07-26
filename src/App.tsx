import { BellOff, Columns2, FolderPlus, PanelLeftClose } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import type { Pane, Workspace } from "./types";

const STORAGE_KEY = "cmux-wins.workspaces.v1";

function createPane(title = "PowerShell"): Pane {
  return { id: crypto.randomUUID(), title };
}

function createWorkspace(title = "Workspace", cwd = ""): Workspace {
  return {
    id: crypto.randomUUID(),
    title,
    cwd,
    panes: [createPane()],
    unread: false,
  };
}

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return [createWorkspace("Main")];
    }

    const parsed = JSON.parse(raw) as Workspace[];
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return [createWorkspace("Main")];
    }

    return parsed.map((workspace) => ({
      ...workspace,
      unread: false,
      panes: workspace.panes?.length ? workspace.panes.map((pane) => ({ ...pane, id: crypto.randomUUID() })) : [createPane()],
    }));
  } catch {
    return [createWorkspace("Main")];
  }
}

export default function App() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>(loadWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(() => workspaces[0].id);
  const [attention, setAttention] = useState<Record<string, string>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0],
    [activeWorkspaceId, workspaces],
  );

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
  }, [workspaces]);

  const selectWorkspace = useCallback((workspaceId: string) => {
    setActiveWorkspaceId(workspaceId);
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, unread: false } : workspace,
      ),
    );
  }, []);

  const addWorkspace = useCallback(() => {
    const title = window.prompt("Workspace name", `Workspace ${workspaces.length + 1}`)?.trim();
    if (!title) {
      return;
    }

    const cwd = window.prompt("Working directory (optional)", "")?.trim() ?? "";
    const workspace = createWorkspace(title, cwd);
    setWorkspaces((current) => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
  }, [workspaces.length]);

  const splitPane = useCallback(() => {
    if (!activeWorkspace) {
      return;
    }

    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? { ...workspace, panes: [...workspace.panes, createPane()] }
          : workspace,
      ),
    );
  }, [activeWorkspace]);

  const closePane = useCallback(
    (sessionId: string) => {
      setAttention((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });

      setWorkspaces((current) =>
        current.map((workspace) => {
          if (workspace.id !== activeWorkspaceId) {
            return workspace;
          }

          const remaining = workspace.panes.filter((pane) => pane.id !== sessionId);
          return { ...workspace, panes: remaining.length ? remaining : [createPane()] };
        }),
      );
    },
    [activeWorkspaceId],
  );

  const handleAttention = useCallback(
    (sessionId: string, message: string) => {
      setAttention((current) => ({ ...current, [sessionId]: message }));
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.panes.some((pane) => pane.id === sessionId)
            ? { ...workspace, unread: workspace.id !== activeWorkspaceId }
            : workspace,
        ),
      );
    },
    [activeWorkspaceId],
  );

  const handleTitleChange = useCallback((sessionId: string, title: string) => {
    setWorkspaces((current) =>
      current.map((workspace) => ({
        ...workspace,
        panes: workspace.panes.map((pane) =>
          pane.id === sessionId ? { ...pane, title } : pane,
        ),
      })),
    );
  }, []);

  const clearAttention = useCallback(() => {
    if (!activeWorkspace) {
      return;
    }

    const activeIds = new Set(activeWorkspace.panes.map((pane) => pane.id));
    setAttention((current) =>
      Object.fromEntries(Object.entries(current).filter(([sessionId]) => !activeIds.has(sessionId))),
    );
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id ? { ...workspace, unread: false } : workspace,
      ),
    );
  }, [activeWorkspace]);

  if (!activeWorkspace) {
    return null;
  }

  return (
    <main className={`app-shell${sidebarOpen ? "" : " app-shell--sidebar-closed"}`}>
      {sidebarOpen && (
        <WorkspaceSidebar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspace.id}
          onSelect={selectWorkspace}
          onAdd={addWorkspace}
        />
      )}

      <section className="workspace">
        <header className="topbar">
          <div className="topbar__leading">
            <button
              className="icon-button"
              type="button"
              title={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              aria-label={sidebarOpen ? "Hide sidebar" : "Show sidebar"}
              onClick={() => setSidebarOpen((open) => !open)}
            >
              <PanelLeftClose size={17} className={sidebarOpen ? "" : "flip-x"} />
            </button>
            <div>
              <h1>{activeWorkspace.title}</h1>
              <span>{activeWorkspace.cwd || "PowerShell · Windows 11"}</span>
            </div>
          </div>

          <div className="topbar__actions">
            <button className="toolbar-button" type="button" onClick={addWorkspace}>
              <FolderPlus size={16} />
              New workspace
            </button>
            <button className="toolbar-button" type="button" onClick={splitPane}>
              <Columns2 size={16} />
              Split right
            </button>
            <button className="toolbar-button" type="button" onClick={clearAttention}>
              <BellOff size={16} />
              Mark read
            </button>
          </div>
        </header>

        <div
          className="pane-grid"
          style={{
            gridTemplateColumns: `repeat(${Math.min(activeWorkspace.panes.length, 2)}, minmax(0, 1fr))`,
          }}
        >
          {activeWorkspace.panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              sessionId={pane.id}
              title={pane.title}
              cwd={activeWorkspace.cwd}
              attention={Boolean(attention[pane.id])}
              onAttention={handleAttention}
              onTitleChange={handleTitleChange}
              onClose={closePane}
            />
          ))}
        </div>
      </section>
    </main>
  );
}
