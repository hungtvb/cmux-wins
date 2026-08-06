import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserPane } from "./components/BrowserPane";
import { CommandPalette } from "./components/CommandPalette";
import type { CommandPaletteItem } from "./components/commandPaletteModel";
import { NotificationPanel } from "./components/NotificationPanel";
import { ResizablePaneGrid } from "./components/ResizablePaneGrid";
import { TerminalPane } from "./components/TerminalPane";
import { WorkspaceSidebar } from "./components/WorkspaceSidebar";
import { WorkspaceTopbar } from "./components/WorkspaceTopbar";
import { useAutomationBridge } from "./hooks/useAutomationBridge";
import { useAutomationEventPublisher } from "./hooks/useAutomationEventPublisher";
import { useResumeRecords } from "./hooks/useResumeRecords";
import { useWorkspaceMetadata } from "./hooks/useWorkspaceMetadata";
import {
  AGENT_DISPLAY_NAMES,
  recordsForCwd,
  toStartupCommand,
  type ResumeRecord,
} from "./resumeModel";
import {
  buildNotificationItems,
  countAttention,
  type NotificationItem,
} from "./notificationModel";
import { isSshProfileId, type AppSettings } from "./settings";
import { requestOpenSettings } from "./settingsEvents";
import {
  formatShortcutBinding,
  getWorkspaceShortcutActionId,
  isEditableShortcutTarget,
  shortcutMatchesEvent,
  type ShortcutActionId,
} from "./shortcuts";
import type { Pane, TerminalPaneModel, Workspace } from "./types";
import {
  WORKSPACE_STATE_VERSION,
  createBrowserPane,
  createSshTerminalPane,
  createTerminalPane,
  createWorkspace,
  loadWorkspaceState,
  saveWorkspaceState,
  type WorkspaceState,
} from "./workspacePersistence";

type AppProps = {
  settings: AppSettings;
  keyboardShortcutsEnabled?: boolean;
};

export default function App({ settings, keyboardShortcutsEnabled = true }: AppProps) {
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
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const activeWorkspaceIdRef = useRef(activeWorkspaceId);
  const workspacesRef = useRef(workspaces);
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
    workspacesRef.current = workspaces;
  }, [workspaces]);

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

  const addSshPane = useCallback(
    (profileId: string) => {
      if (!activeWorkspace) return;
      const profile = settings.sshProfiles.find((candidate) => candidate.id === profileId);
      if (!profile) return;
      const pane = createSshTerminalPane(settings, profile);
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === activeWorkspace.id
            ? { ...workspace, panes: [...workspace.panes, pane] }
            : workspace,
        ),
      );
      setActivePaneByWorkspace((current) => ({ ...current, [activeWorkspace.id]: pane.id }));
    },
    [activeWorkspace, settings],
  );

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

  const reconnectPane = useCallback(
    (paneId: string) => {
      const workspace = workspacesRef.current.find((ws) =>
        ws.panes.some((candidate) => candidate.id === paneId),
      );
      if (!workspace) return;
      const pane = workspace.panes.find((candidate) => candidate.id === paneId);
      if (!pane || pane.kind !== "terminal") return;

      const terminalPane = pane as TerminalPaneModel;
      const isSsh = isSshProfileId(terminalPane.terminalSettings?.shellProfileId ?? "");
      const profile = settings.sshProfiles.find(
        (candidate) => candidate.id === terminalPane.terminalSettings?.shellProfileId,
      );
      if (isSsh && !profile) return;

      const replacement = isSsh
        ? createSshTerminalPane(settings, profile!)
        : createTerminalPane(settings, workspace.cwd);

      setWorkspaces((current) =>
        current.map((candidateWorkspace) =>
          candidateWorkspace.id === workspace.id
            ? {
                ...candidateWorkspace,
                panes: candidateWorkspace.panes.map((candidate) =>
                  candidate.id === paneId ? { ...replacement, id: paneId } : candidate,
                ),
              }
            : candidateWorkspace,
        ),
      );
      setActivePaneByWorkspace((current) => ({ ...current, [workspace.id]: paneId }));
    },
    [settings],
  );

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

  const clearPaneAttention = useCallback(
    (paneId: string) => {
      const remaining = Object.fromEntries(
        Object.entries(attention).filter(([id]) => id !== paneId),
      );
      setAttention(remaining);
      setWorkspaces((current) =>
        current.map((workspace) => {
          if (!workspace.panes.some((pane) => pane.id === paneId)) return workspace;
          const stillUnread = workspace.panes.some(
            (pane) => pane.id !== paneId && remaining[pane.id],
          );
          return { ...workspace, unread: stillUnread };
        }),
      );
    },
    [attention],
  );

  const clearAllNotifications = useCallback(() => {
    setAttention({});
    setWorkspaces((current) => current.map((workspace) => ({ ...workspace, unread: false })));
  }, []);

  const jumpToNotification = useCallback(
    (item: NotificationItem) => {
      selectWorkspace(item.workspaceId);
      setActivePaneByWorkspace((current) => ({ ...current, [item.workspaceId]: item.paneId }));
      clearPaneAttention(item.paneId);
      setNotificationsOpen(false);
    },
    [clearPaneAttention, selectWorkspace],
  );

  const notificationItems = useMemo(
    () => buildNotificationItems(attention, workspaces),
    [attention, workspaces],
  );
  const unreadNotificationCount = useMemo(() => countAttention(attention), [attention]);

  const { records: resumeRecords } = useResumeRecords(activeWorkspace?.cwd, activeWorkspace?.id);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const workspaceResumeRecords = useMemo(
    () => (activeWorkspace ? recordsForCwd(resumeRecords, activeWorkspace.cwd) : []),
    [resumeRecords, activeWorkspace],
  );

  const resumeAgentSession = useCallback(
    async (record: ResumeRecord) => {
      if (!activeWorkspace) return;
      try {
        const trusted = await invoke<boolean>("is_shell_executable_trusted", {
          executable: record.executable,
        });
        if (!trusted) {
          setResumeNotice(
            `"${record.executable}" is not trusted yet. Approve it in Settings → Trusted executables, then try again.`,
          );
          return;
        }
      } catch {
        setResumeNotice("Could not verify the agent executable. Try again.");
        return;
      }
      const terminalBase = createTerminalPane(
        settings,
        record.cwd,
        AGENT_DISPLAY_NAMES[record.agent],
      ) as TerminalPaneModel;
      const pane: Pane = {
        ...terminalBase,
        terminalSettings: {
          ...terminalBase.terminalSettings!,
          startupCommand: toStartupCommand(record),
        },
      };
      setWorkspaces((current) =>
        current.map((workspace) =>
          workspace.id === activeWorkspace.id
            ? { ...workspace, panes: [...workspace.panes, pane] }
            : workspace,
        ),
      );
      setActivePaneByWorkspace((current) => ({ ...current, [activeWorkspace.id]: pane.id }));
      setResumeNotice(null);
    },
    [activeWorkspace, settings],
  );

  const shortcutLabel = useCallback(
    (actionId: ShortcutActionId): string | undefined => {
      const binding = settings.shortcuts[actionId];
      return binding ? formatShortcutBinding(binding) : undefined;
    },
    [settings.shortcuts],
  );

  const commandPaletteItems = useMemo<CommandPaletteItem[]>(() => {
    const workspaceItems: CommandPaletteItem[] = workspaces.map((workspace, index) => {
      const actionId = getWorkspaceShortcutActionId(index);
      return {
        id: `workspace.select.${workspace.id}`,
        label: `Switch to ${workspace.title}`,
        description: workspace.cwd || "Local workspace",
        keywords: ["switch", "select", "workspace", workspace.title, workspace.cwd],
        section: "Workspaces",
        shortcut: actionId ? shortcutLabel(actionId) : undefined,
        run: () => selectWorkspace(workspace.id),
      };
    });

    const actions: CommandPaletteItem[] = [
      {
        id: "settings.open",
        label: "Open settings",
        description: "Configure shells, terminal behavior, persistence and shortcuts",
        keywords: ["preferences", "configuration", "keyboard"],
        section: "General",
        shortcut: shortcutLabel("settings.open"),
        run: requestOpenSettings,
      },
      {
        id: "workspace.new",
        label: "New workspace",
        description: "Create a local developer workspace",
        keywords: ["create", "project", "folder"],
        section: "Actions",
        shortcut: shortcutLabel("workspace.new"),
        run: addWorkspace,
      },
      {
        id: "pane.split-terminal",
        label: "Split terminal",
        description: "Add another PowerShell terminal pane",
        keywords: ["shell", "powershell", "pane"],
        section: "Actions",
        shortcut: shortcutLabel("pane.splitTerminal"),
        run: splitTerminalPane,
      },
      ...settings.sshProfiles.map((profile) => ({
        id: `pane.ssh.${profile.id}`,
        label: `Connect to ${profile.label}`,
        description: `SSH ${profile.user}@${profile.host}:${profile.port}`,
        keywords: ["ssh", "remote", "shell", profile.label, profile.host, profile.user],
        section: "SSH connections",
        run: () => addSshPane(profile.id),
      })),
      {
        id: "pane.open-browser",
        label: "Open browser pane",
        description: "Create an embedded WebView2 browser",
        keywords: ["web", "url", "github", "pane"],
        section: "Actions",
        shortcut: shortcutLabel("pane.openBrowser"),
        run: addBrowserPane,
      },
      {
        id: "layout.toggle-sidebar",
        label: sidebarOpen ? "Hide sidebar" : "Show sidebar",
        description: "Toggle the workspace navigator",
        keywords: ["navigation", "layout", "panel"],
        section: "View",
        shortcut: shortcutLabel("layout.toggleSidebar"),
        run: () => setSidebarOpen((open) => !open),
      },
      {
        id: "notifications.toggle",
        label: notificationsOpen ? "Hide notifications" : "Show notifications",
        description: "Open the agent attention panel",
        keywords: ["attention", "notification", "unread", "panel"],
        section: "View",
        shortcut: shortcutLabel("notifications.toggle"),
        run: () => setNotificationsOpen((open) => !open),
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
        shortcut: shortcutLabel("workspace.close"),
        danger: true,
        run: () => closeWorkspace(activeWorkspace.id),
      });
    }

    return [...actions, ...workspaceItems];
  }, [
    activeWorkspace,
    addBrowserPane,
    addSshPane,
    addWorkspace,
    attention,
    clearAttention,
    closeWorkspace,
    notificationsOpen,
    selectWorkspace,
    settings.sshProfiles,
    shortcutLabel,
    sidebarOpen,
    splitTerminalPane,
    workspaces,
  ]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!keyboardShortcutsEnabled || isEditableShortcutTarget(event.target)) return;

      if (shortcutMatchesEvent(settings.shortcuts["commandPalette.open"], event)) {
        event.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }

      if (commandPaletteOpen) return;

      for (let index = 0; index < Math.min(workspaces.length, 9); index += 1) {
        const actionId = getWorkspaceShortcutActionId(index);
        if (actionId && shortcutMatchesEvent(settings.shortcuts[actionId], event)) {
          event.preventDefault();
          selectWorkspace(workspaces[index].id);
          return;
        }
      }

      if (shortcutMatchesEvent(settings.shortcuts["layout.toggleSidebar"], event)) {
        event.preventDefault();
        setSidebarOpen((open) => !open);
      } else if (shortcutMatchesEvent(settings.shortcuts["pane.openBrowser"], event)) {
        event.preventDefault();
        addBrowserPane();
      } else if (shortcutMatchesEvent(settings.shortcuts["workspace.new"], event)) {
        event.preventDefault();
        addWorkspace();
      } else if (shortcutMatchesEvent(settings.shortcuts["pane.splitTerminal"], event)) {
        event.preventDefault();
        splitTerminalPane();
      } else if (shortcutMatchesEvent(settings.shortcuts["notifications.toggle"], event)) {
        event.preventDefault();
        setNotificationsOpen((open) => !open);
      } else if (
        activeWorkspace &&
        shortcutMatchesEvent(settings.shortcuts["workspace.close"], event)
      ) {
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
    keyboardShortcutsEnabled,
    selectWorkspace,
    settings.shortcuts,
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
          unreadCount={unreadNotificationCount}
          notificationsOpen={notificationsOpen}
          resumeRecords={workspaceResumeRecords}
          resumeNotice={resumeNotice}
          onResume={resumeAgentSession}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onOpenSettings={requestOpenSettings}
          shortcutLabel={shortcutLabel}
          onAddWorkspace={addWorkspace}
          onSplitTerminal={splitTerminalPane}
          onAddBrowser={addBrowserPane}
          onToggleNotifications={() => setNotificationsOpen((open) => !open)}
          onCloseWorkspace={() => closeWorkspace(activeWorkspace.id)}
        />

        {notificationsOpen && (
          <NotificationPanel
            items={notificationItems}
            onJump={jumpToNotification}
            onClearPane={clearPaneAttention}
            onClearAll={clearAllNotifications}
            onClose={() => setNotificationsOpen(false)}
          />
        )}

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
                        onTitleChange={handleTitleChange}
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
                        onReconnect={reconnectPane}
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
