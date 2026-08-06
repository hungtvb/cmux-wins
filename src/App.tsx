import { BellOff, Columns2, FolderPlus, PanelLeftClose, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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
    if (!raw) return [createWorkspace("Main")];

    const parsed = JSON.parse(raw) as Workspace[];
    if (!Array.isArray(parsed) || parsed.length === 0) return [createWorkspace("Main")];

    return parsed.map((workspace) => ({
      ...workspace,
      unread: false,
      panes: workspace.panes?.length
        ? workspace.panes.map((pane) => ({ ...pane, id: crypto.randomUUID() }))
        : [createPane()],
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
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0],
    [activeWorkspaceId, workspaces],
  );

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
  }, [workspaces]);

  const selectWorkspace = useCallback((workspaceId: string) => {
    activeWorkspaceIdRef.current = workspaceId;
    setActiveWorkspaceId(workspaceId);
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === workspaceId ? { ...workspace, unread: false } : workspace,
      ),
    );
  }, []);

  const addWorkspace = useCallback(() => {
    const title = window.prompt("Workspace name", `Workspace ${workspaces.length + 1}`)?.trim();
    if (!title) return;

    const cwd = window.prompt("Working directory (optional)", "")?.trim() ?? "";
    const workspace = createWorkspace(title, cwd);
    activeWorkspaceIdRef.current = workspace.id;
    setWorkspaces((current) => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
  }, [workspaces.length]);

  const splitPane = useCallback(() => {
    if (!activeWorkspace) return;

    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? { ...workspace, panes: [...workspace.panes, createPane()] }
          : workspace,
      ),
    );
  }, [activeWorkspace]);

  const closePane = useCallback((sessionId: string) => {
    setAttention((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });

    setWorkspaces((current) =>
      current.map((workspace) => {
        if (!workspace.panes.some((pane) => pane.id === sessionId)) return workspace;
        const remaining = workspace.panes.filter((pane) => pane.id !== sessionId);
        return { ...workspace, panes: remaining.length ? remaining : [createPane()] };
      }),
    );
  }, []);

  const closeWorkspace = useCallback((workspaceId: string) => {
    setWorkspaces((current) => {
      const target = current.find((workspace) => workspace.id === workspaceId);
      if (!target) return current;

      for (const pane of target.panes) {
        void invoke("close_terminal", { sessionId: pane.id });
      }

      setAttention((currentAttention) => {
        const next = { ...currentAttention };
        for (const pane of target.panes) delete next[pane.id];
        return next;
      });

      const remaining = current.filter((workspace) => workspace.id !== workspaceId);
      const nextWorkspaces = remaining.length ? remaining : [createWorkspace("Main")];

      if (activeWorkspaceIdRef.current === workspaceId) {
        const nextActive = nextWorkspaces[0].id;
        activeWorkspaceIdRef.current = nextActive;
        setActiveWorkspaceId(nextActive);
      }

      return nextWorkspaces;
    });
  }, []);

  const handleAttention = useCallback((sessionId: string, message: string) => {
    setAttention((current) => ({ ...current, [sessionId]: message }));
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.panes.some((pane) => pane.id === sessionId)
          ? { ...workspace, unread: workspace.id !== activeWorkspaceIdRef.current }
          : workspace,
      ),
    );
  }, []);

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
    if (!activeWorkspace) return;

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;

      if (event.key >= "1" && event.key <= "9") {
        const workspace = workspaces[Number(event.key) - 1];
        if (workspace) {
          event.preventDefault();
          selectWorkspace(workspace.id);
        }
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "b" && !event.shiftKey) {
        event.preventDefault();
        setSidebarOpen((open) => !open);
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        addWorkspace();
      } else if (key === "d" && event.shiftKey) {
        event.preventDefault();
        splitPane();
      } else if (key === "w" && event.shiftKey && activeWorkspace) {
        event.preventDefault();
        closeWorkspace(activeWorkspace.id);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeWorkspace, addWorkspace, closeWorkspace, selectWorkspace, splitPane, workspaces]);

  if (!activeWorkspace) return null;

  return (
    <main className={`app-shell${sidebarOpen ? "" : " app-shell--sidebar-closed"}`}>
      {sidebarOpen && (
        <WorkspaceSidebar
          workspaces={workspaces}
          activeWorkspaceId={activeWorkspace.id}
          onSelect={selectWorkspace}
          onAdd={addWorkspace}
          onClose={closeWorkspace}
        />
      )}

      <section className="workspace">
        <header className="topbar">
          <div className="topbar__leading">
            <button
              className="icon-button"
              type="button"
              title={sidebarOpen ? "Hide sidebar (Ctrl+B)" : "Show sidebar (Ctrl+B)"}
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
            <button className="toolbar-button" type="button" onClick={addWorkspace} title="Ctrl+N">
              <FolderPlus size={16} />
              New workspace
            </button>
            <button className="toolbar-button" type="button" onClick={splitPane} title="Ctrl+Shift+D">
              <Columns2 size={16} />
              Split right
            </button>
            <button className="toolbar-button" type="button" onClick={clearAttention}>
              <BellOff size={16} />
              Mark read
            </button>
            <button
              className="toolbar-button toolbar-button--danger"
              type="button"
              onClick={() => closeWorkspace(activeWorkspace.id)}
              title="Ctrl+Shift+W"
            >
              <Trash2 size={16} />
              Close workspace
            </button>
          </div>
        </header>

        <div className="workspace-stage">
          {workspaces.map((workspace) => (
            <div
              className={`workspace-surface${workspace.id === activeWorkspace.id ? " workspace-surface--active" : ""}`}
              key={workspace.id}
              aria-hidden={workspace.id !== activeWorkspace.id}
            >
              <div
                className="pane-grid"
                style={{
                  gridTemplateColumns: `repeat(${Math.min(workspace.panes.length, 2)}, minmax(0, 1fr))`,
                }}
              >
                {workspace.panes.map((pane) => (
                  <TerminalPane
                    key={pane.id}
                    sessionId={pane.id}
                    title={pane.title}
                    cwd={workspace.cwd}
                    attention={Boolean(attention[pane.id])}
                    onAttention={handleAttention}
                    onTitleChange={handleTitleChange}
                    onClose={closePane}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
