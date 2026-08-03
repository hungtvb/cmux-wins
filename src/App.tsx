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
import type { AppSettings } from "./settings";
import type { Pane, Workspace } from "./types";
import {
  WORKSPACE_STATE_VERSION,
  createBrowserPane,
  createTerminalPane,
  createWorkspace,
  loadWorkspaceState,
  saveWorkspaceState,
  type WorkspaceState,
} from "./workspacePersistence";

type AppProps = {
  settings: AppSettings;
};

export default function App({ settings }: AppProps) {
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const initialStateRef = useRef<WorkspaceState | null>(null);
  if (initialStateRef.current === null) {
    initialStateRef.current = loadWorkspaceState(settings).state;
  }
  const initialState = initialStateRef.current;

  const [workspaces, setWorkspaces] = useState<Workspace[]>(() => initialState.workspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState(
    () => initialState.activeWorkspaceId,
  );
  const [attention, setAttention] = useState<Record<string, string>>({});
  const [historySnapshotByPane, setHistorySnapshotByPane] = useState<Record<string, string>>({});
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [activePaneByWorkspace, setActivePaneByWorkspace] = useState<Record<string, string>>(
    () => initialState.activePaneByWorkspace,
  );
  const [splitRatioByWorkspace, setSplitRatioByWorkspace] = useState<Record<string, number>>(
    () => initialState.splitRatioByWorkspace,
  );
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
    const persistedWorkspaces = workspaces.map((workspace) => ({
      ...workspace,
      panes: workspace.panes.map((pane) => {
        if (pane.kind !== "terminal") return pane;
        const historySnapshot = Object.prototype.hasOwnProperty.call(
          historySnapshotByPane,
          pane.id,
        )
          ? historySnapshotByPane[pane.id]
          : pane.historySnapshot;
        return { ...pane, historySnapshot };
      }),
    }));

    saveWorkspaceState(
      {
        version: WORKSPACE_STATE_VERSION,
        workspaces: persistedWorkspaces,
        activeWorkspaceId,
        activePaneByWorkspace,
        splitRatioByWorkspace,
      },
      settingsRef.current,
    );
  }, [
    activePaneByWorkspace,
    activeWorkspaceId,
    historySnapshotByPane,
    settings.persistence.restoreWorkspaces,
    settings.persistence.terminalHistoryLines,
    splitRatioByWorkspace,
    workspaces,
  ]);

  useEffect(() => {
    if (settings.persistence.terminalHistoryLines === 0) {
      setHistorySnapshotByPane({});
    }
  }, [settings.persistence.terminalHistoryLines]);

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
    const workspace = createWorkspace(settings, title, cwd);
    activeWorkspaceIdRef.current = workspace.id;
    setWorkspaces((current) => [...current, workspace]);
    setActiveWorkspaceId(workspace.id);
  }, [settings, workspaces.length]);

  const splitTerminalPane = useCallback(() => {
    if (!activeWorkspace) return;

    const pane = createTerminalPane(settings, activeWorkspace.cwd);
    setWorkspaces((current) =>
      current.map((workspace) =>
        workspace.id === activeWorkspace.id
          ? { ...workspace, panes: [...workspace.panes, pane] }
          : workspace,
      ),
    );
    setActivePaneByWorkspace((current) => ({ ...current, [activeWorkspace.id]: pane.id }));
  }, [activeWorkspace, settings]);

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
    setHistorySnapshotByPane((current) => {
      if (!Object.prototype.hasOwnProperty.call(current, paneId)) return current;
      const next = { ...current };
      delete next[paneId];
      return next;
    });
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
        return {
          ...workspace,
          panes: remaining.length
            ? remaining
            : [createTerminalPane(settings, workspace.cwd)],
        };
      }),
    );
  }, [settings]);

  const closeWorkspace = useCallback((workspaceId: string) => {
    setWorkspaces((current) => {
      const target = current.find((workspace) => workspace.id === workspaceId);
      if (!target) return current;

      setAttention((currentAttention) => {
        const next = { ...currentAttention };
        for (const pane of target.panes) delete next[pane.id];
        return next;
      });
      setHistorySnapshotByPane((currentHistory) => {
        const next = { ...currentHistory };
        let changed = false;
        for (const pane of target.panes) {
          if (Object.prototype.hasOwnProperty.call(next, pane.id)) {
            delete next[pane.id];
            changed = true;
          }
        }
        return changed ? next : currentHistory;
      });

      const remaining = current.filter((workspace) => workspace.id !== workspaceId);
      const nextWorkspaces = remaining.length ? remaining : [createWorkspace(settings, "Main")];

      if (activeWorkspaceIdRef.current === workspaceId) {
        const nextActive = nextWorkspaces[0].id;
        activeWorkspaceIdRef.current = nextActive;
        setActiveWorkspaceId(nextActive);
      }

      return nextWorkspaces;
    });
  }, [settings]);

  const handleHistoryChange = useCallback((sessionId: string, history: string) => {
    setHistorySnapshotByPane((current) => {
      if (!history) {
        if (!Object.prototype.hasOwnProperty.call(current, sessionId)) return current;
        const next = { ...current };
        delete next[sessionId];
        return next;
      }
      return current[sessionId] === history
        ? current
        : { ...current, [sessionId]: history };
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
                        paneSettings={pane.terminalSettings}
                        restored={pane.restored}
                        restoredHistory={pane.restored ? pane.historySnapshot : undefined}
                        historyLineLimit={
                          settings.persistence.restoreWorkspaces
                            ? settings.persistence.terminalHistoryLines
                            : 0
                        }
                        attention={Boolean(attention[pane.id])}
                        focused={focused}
                        onFocus={focusPane}
                        onHistoryChange={handleHistoryChange}
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
