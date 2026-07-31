import {
  BellOff,
  Columns2,
  FolderPlus,
  Globe2,
  PanelLeftClose,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserPane } from "./components/BrowserPane";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { useWorkspaceMetadata } from "./hooks/useWorkspaceMetadata";
import type { Pane, Workspace } from "./types";

const STORAGE_KEY = "cmux-wins.workspaces.v2";
const LEGACY_STORAGE_KEY = "cmux-wins.workspaces.v1";
const DEFAULT_BROWSER_URL = "https://github.com";

function createTerminalPane(title = "PowerShell"): Pane {
  return { id: crypto.randomUUID(), kind: "terminal", title };
}

function createBrowserPane(url = DEFAULT_BROWSER_URL): Pane {
  return { id: crypto.randomUUID(), kind: "browser", title: "Browser", url };
}

function createWorkspace(title = "Workspace", cwd = ""): Workspace {
  return {
    id: crypto.randomUUID(),
    title,
    cwd,
    panes: [createTerminalPane()],
    unread: false,
  };
}

function migratePane(value: unknown): Pane {
  const pane = value as Partial<Pane> & { url?: unknown };
  if (pane?.kind === "browser") {
    return {
      id: crypto.randomUUID(),
      kind: "browser",
      title: typeof pane.title === "string" ? pane.title : "Browser",
      url: typeof pane.url === "string" && pane.url ? pane.url : DEFAULT_BROWSER_URL,
    };
  }

  return {
    id: crypto.randomUUID(),
    kind: "terminal",
    title: typeof pane?.title === "string" ? pane.title : "PowerShell",
  };
}

function loadWorkspaces(): Workspace[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return [createWorkspace("Main")];

    const parsed = JSON.parse(raw) as Workspace[];
    if (!Array.isArray(parsed) || parsed.length === 0) return [createWorkspace("Main")];

    return parsed.map((workspace) => ({
      id: typeof workspace.id === "string" ? workspace.id : crypto.randomUUID(),
      title: typeof workspace.title === "string" ? workspace.title : "Workspace",
      cwd: typeof workspace.cwd === "string" ? workspace.cwd : "",
      unread: false,
      panes: workspace.panes?.length ? workspace.panes.map(migratePane) : [createTerminalPane()],
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
  const metadataByWorkspace = useWorkspaceMetadata(workspaces, activeWorkspaceId);

  const activeWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0],
    [activeWorkspaceId, workspaces],
  );
  const activeMetadata = activeWorkspace ? metadataByWorkspace[activeWorkspace.id] : undefined;

  useEffect(() => {
    activeWorkspaceIdRef.current = activeWorkspaceId;
  }, [activeWorkspaceId]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(workspaces));
    localStorage.removeItem(LEGACY_STORAGE_KEY);
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

  const splitTerminalPane = useCallback(() => {
    if (!activeWorkspace) return;

    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? { ...workspace, panes: [...workspace.panes, createTerminalPane()] }
          : workspace,
      ),
    );
  }, [activeWorkspace]);

  const addBrowserPane = useCallback(() => {
    if (!activeWorkspace) return;

    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? { ...workspace, panes: [...workspace.panes, createBrowserPane()] }
          : workspace,
      ),
    );
  }, [activeWorkspace]);

  const closePane = useCallback((paneId: string) => {
    setAttention((current) => {
      const next = { ...current };
      delete next[paneId];
      return next;
    });

    // TerminalPane and BrowserPane own their native lifecycle cleanup on unmount.
    setWorkspaces((current) =>
      current.map((workspace) => {
        if (!workspace.panes.some((pane) => pane.id === paneId)) return workspace;
        const remaining = workspace.panes.filter((pane) => pane.id !== paneId);
        return { ...workspace, panes: remaining.length ? remaining : [createTerminalPane()] };
      }),
    );
  }, []);

  const closeWorkspace = useCallback((workspaceId: string) => {
    setWorkspaces((current) => {
      const target = current.find((workspace) => workspace.id === workspaceId);
      if (!target) return current;

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

  const handleBrowserUrlChange = useCallback((paneId: string, url: string) => {
    setWorkspaces((current) =>
      current.map((workspace) => ({
        ...workspace,
        panes: workspace.panes.map((pane) =>
          pane.id === paneId && pane.kind === "browser" ? { ...pane, url } : pane,
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
      } else if (key === "b" && event.shiftKey) {
        event.preventDefault();
        addBrowserPane();
      } else if (key === "n" && !event.shiftKey) {
        event.preventDefault();
        addWorkspace();
      } else if (key === "d" && event.shiftKey) {
        event.preventDefault();
        splitTerminalPane();
      } else if (key === "w" && event.shiftKey && activeWorkspace) {
        event.preventDefault();
        closeWorkspace(activeWorkspace.id);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    activeWorkspace,
    addBrowserPane,
    addWorkspace,
    closeWorkspace,
    selectWorkspace,
    splitTerminalPane,
    workspaces,
  ]);

  if (!activeWorkspace) return null;

  const activeSubtitle = activeMetadata?.available
    ? `${activeMetadata.repository || "Git repository"} · ${activeMetadata.branch || "unknown branch"}${activeMetadata.dirty ? " · modified" : ""}`
    : activeWorkspace.cwd || "PowerShell · Windows 11";

  return (
    <main className={`app-shell${sidebarOpen ? "" : " app-shell--sidebar-closed"}`}>
      {sidebarOpen && (
        <WorkspaceSidebar
          workspaces={workspaces}
          metadataByWorkspace={metadataByWorkspace}
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
              <span>{activeSubtitle}</span>
            </div>
          </div>

          <div className="topbar__actions">
            <button className="toolbar-button" type="button" onClick={addWorkspace} title="Ctrl+N">
              <FolderPlus size={16} />
              New workspace
            </button>
            <button
              className="toolbar-button"
              type="button"
              onClick={splitTerminalPane}
              title="Ctrl+Shift+D"
            >
              <Columns2 size={16} />
              Split terminal
            </button>
            <button
              className="toolbar-button"
              type="button"
              onClick={addBrowserPane}
              title="Ctrl+Shift+B"
            >
              <Globe2 size={16} />
              Browser
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
                {workspace.panes.map((pane) =>
                  pane.kind === "browser" ? (
                    <BrowserPane
                      key={pane.id}
                      paneId={pane.id}
                      title={pane.title}
                      url={pane.url}
                      active={workspace.id === activeWorkspace.id}
                      onUrlChange={handleBrowserUrlChange}
                      onClose={closePane}
                    />
                  ) : (
                    <TerminalPane
                      key={pane.id}
                      workspaceId={workspace.id}
                      sessionId={pane.id}
                      title={pane.title}
                      cwd={workspace.cwd}
                      attention={Boolean(attention[pane.id])}
                      onAttention={handleAttention}
                      onTitleChange={handleTitleChange}
                      onClose={closePane}
                    />
                  ),
                )}
              </div>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}
