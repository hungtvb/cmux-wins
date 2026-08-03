import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserPane } from "./components/BrowserPane";
import { CommandPalette } from "./components/CommandPalette";
import type { CommandPaletteItem } from "./components/commandPaletteModel";
import { ResizablePaneGrid } from "./components/ResizablePaneGrid";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceTopbar } from "./components/WorkspaceTopbar";
import { useAutomationBridge } from "./hooks/useAutomationBridge";
import { useAutomationEventPublisher } from "./hooks/useAutomationEventPublisher";
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
  const [activePaneByWorkspace, setActivePaneByWorkspace] = useState<Record<string, string>>({});
  const [splitRatioByWorkspace, setSplitRatioByWorkspace] = useState<Record<string, number>>({});
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  const metadataByWorkspace = useWorkspaceMetadata(workspaces, activeWorkspaceId);

  useAutomationBridge({
    workspaces,
    activeWorkspaceId,
    setWorkspaces,
    setActiveWorkspaceId,
    setAttention,
  });
  useAutomationEventPublisher({
    workspaces,
    activeWorkspaceId,
    attention,
  });

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

  useEffect(() => {
    setActivePaneByWorkspace((current) => {
      const next: Record<string, string> = {};
      let changed = Object.keys(current).length !== workspaces.length;

      for (const workspace of workspaces) {
        const currentPaneId = current[workspace.id];
        const nextPaneId = workspace.panes.some((pane) => pane.id === currentPaneId)
          ? currentPaneId
          : workspace.panes[0]?.id;

        if (nextPaneId) next[workspace.id] = nextPaneId;
        if (nextPaneId !== currentPaneId) changed = true;
      }

      return changed ? next : current;
    });
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

    const pane = createTerminalPane();
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? { ...workspace, panes: [...workspace.panes, pane] }
          : workspace,
      ),
    );
    setActivePaneByWorkspace((current) => ({ ...current, [activeWorkspace.id]: pane.id }));
  }, [activeWorkspace]);

  const addBrowserPane = useCallback(() => {
    if (!activeWorkspace) return;

    const pane = createBrowserPane();
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? { ...workspace, panes: [...workspace.panes, pane] }
          : workspace,
      ),
    );
    setActivePaneByWorkspace((current) => ({ ...current, [activeWorkspace.id]: pane.id }));
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

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const workspaceItems: CommandPaletteItem[] = workspaces.map((workspace, index) => ({
      id: `workspace.select.${workspace.id}`,
      label: `Switch to ${workspace.title}`,
      description: workspace.cwd || "Local workspace",
      keywords: ["switch", "select", "workspace", workspace.title, workspace.cwd],
      section: "Workspaces",
      shortcut: index < 9 ? `Ctrl ${index + 1}` : undefined,
      run: () => selectWorkspace(workspace.id),
    }));

    const actions: CommandPaletteItem[] = [
      {
        id: "workspace.new",
        label: "New workspace",
        description: "Create a local developer workspace",
        keywords: ["create", "project", "folder"],
        section: "Actions",
        shortcut: "Ctrl N",
        run: addWorkspace,
      },
      {
        id: "pane.split-terminal",
        label: "Split terminal",
        description: "Add another PowerShell terminal pane",
        keywords: ["shell", "powershell", "pane"],
        section: "Actions",
        shortcut: "Ctrl ⇧ D",
        run: splitTerminalPane,
      },
      {
        id: "pane.open-browser",
        label: "Open browser pane",
        description: "Create an embedded WebView2 browser",
        keywords: ["web", "url", "github", "pane"],
        section: "Actions",
        shortcut: "Ctrl ⇧ B",
        run: addBrowserPane,
      },
      {
        id: "layout.toggle-sidebar",
        label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
        description: "Toggle the workspace navigator",
        keywords: ["navigation", "layout", "panel"],
        section: "View",
        shortcut: "Ctrl B",
        run: () => setSidebarOpen((open) => !open),
      },
    ];

    if (activeWorkspace && activeWorkspace.panes.some((pane) => Boolean(attention[pane.id]))) {
      actions.push({
        id: "workspace.mark-read",
        label: "Mark workspace alerts as read",
        description: "Clear agent attention indicators",
        keywords: ["attention", "notification", "unread"],
        section: "View",
        run: clearAttention,
      });
    }

    if (activeWorkspace) {
      actions.push({
        id: "workspace.close",
        label: `Close ${activeWorkspace.title}`,
        description: "Close this workspace and its panes",
        keywords: ["remove", "delete", "workspace"],
        section: "Danger zone",
        shortcut: "Ctrl ⇧ W",
        danger: true,
        run: () => closeWorkspace(activeWorkspace.id),
      });
    }

    return [...actions, ...workspaceItems];
  }, [
    activeWorkspace,
    addBrowserPane,
    addWorkspace,
    attention,
    clearAttention,
    closeWorkspace,
    selectWorkspace,
    sidebarOpen,
    splitTerminalPane,
    workspaces,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey) return;

      const key = event.key.toLowerCase();
      if (key === "k" && !event.shiftKey) {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (commandPaletteOpen) return;

      if (event.key >= "1" && event.key <= "9") {
        const workspace = workspaces[Number(event.key) - 1];
        if (workspace) {
          event.preventDefault();
          selectWorkspace(workspace.id);
        }
        return;
      }

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
    commandPaletteOpen,
    selectWorkspace,
    splitTerminalPane,
    workspaces,
  ]);

  if (!activeWorkspace) return null;

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
        <WorkspaceTopbar
          workspace={activeWorkspace}
          metadata={activeMetadata}
          sidebarOpen={sidebarOpen}
          attentionCount={activeWorkspace.panes.filter((pane) => Boolean(attention[pane.id])).length}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onAddWorkspace={addWorkspace}
          onSplitTerminal={splitTerminalPane}
          onAddBrowser={addBrowserPane}
          onClearAttention={clearAttention}
          onCloseWorkspace={() => closeWorkspace(activeWorkspace.id)}
        />

        <div className="workspace-stage">
          {workspaces.map((workspace) => {
            const activePaneId = activePaneByWorkspace[workspace.id] ?? workspace.panes[0]?.id;

            return (
              <div
                className={`workspace-surface${workspace.id === activeWorkspace.id ? " workspace-surface--active" : ""}`}
                key={workspace.id}
                aria-hidden={workspace.id !== activeWorkspace.id}
              >
                <ResizablePaneGrid
                  splitRatio={splitRatioByWorkspace[workspace.id] ?? 50}
                  onSplitRatioChange={(ratio) =>
                    setSplitRatioByWorkspace((current) => ({ ...current, [workspace.id]: ratio }))
                  }
                >
                  {workspace.panes.map((pane) => {
                    const focusPane = () =>
                      setActivePaneByWorkspace((current) => ({ ...current, [workspace.id]: pane.id }));
                    const focused = pane.id === activePaneId;

                    return pane.kind === "browser" ? (
                      <BrowserPane
                        key={pane.id}
                        paneId={pane.id}
                        title={pane.title}
                        url={pane.url}
                        active={workspace.id === activeWorkspace.id}
                        focused={focused}
                        onFocus={focusPane}
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
                        focused={focused}
                        onFocus={focusPane}
                        onAttention={handleAttention}
                        onTitleChange={handleTitleChange}
                        onClose={closePane}
                      />
                    );
                  })}
                </ResizablePaneGrid>
              </div>
            );
          })}
        </div>
      </section>

      <CommandPalette
        open={commandPaletteOpen}
        items={commandPaletteItems}
        onClose={() => setCommandPaletteOpen(false)}
      />
    </main>
  );
}
