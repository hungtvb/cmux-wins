import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import {
  findSshProfile,
  isSshProfileId,
  loadSettings,
  normalizeTerminalPaneSettings,
  snapshotTerminalSettings,
  type TerminalPaneSettings,
} from "../settings";
import { sanitizeTerminalHistory } from "../terminalHistory";
import {
  getCurrentTheme,
  getXtermTheme,
  THEME_CHANGE_EVENT,
  type Theme,
} from "../theme";
import {
  createTerminalClientId,
  terminalSessionLeases,
} from "../terminalSessionLease";
import type { TerminalLifecycleEvent, TerminalOutputEvent } from "../types";

type UseTerminalSessionOptions = {
  workspaceId: string;
  sessionId: string;
  cwd: string;
  paneSettings?: TerminalPaneSettings;
  restoredHistory?: string;
  historyLineLimit: number;
  focused: boolean;
  onHistoryChange: (history: string) => void;
  onAttention: (message: string) => void;
  onTitleChange: (title: string) => void;
  onDisconnected?: (message: string) => void;
};

const notificationPattern = /\x1b\](?:9|99|777);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const HISTORY_CAPTURE_INTERVAL_MS = 2_000;

type SshConnectionPayload = {
  profileId: string;
  host: string;
  port: number;
  user: string;
  identityFile: string | null;
};

function resolveSshConnection(paneSettings: TerminalPaneSettings): SshConnectionPayload | null {
  if (!isSshProfileId(paneSettings.shellProfileId)) return null;
  const profile = findSshProfile(loadSettings(), paneSettings.shellProfileId);
  if (!profile) return null;
  return {
    profileId: profile.id,
    host: profile.host,
    port: profile.port,
    user: profile.user,
    identityFile: profile.identityFile || null,
  };
}

function readTerminalBuffer(terminal: Terminal): string {
  // The normal buffer owns scrollback. Reading it directly prevents a temporary
  // alternate-screen application from replacing persisted history with its
  // viewport-only contents.
  const buffer = terminal.buffer.normal;
  const lines: string[] = [];

  for (let index = 0; index < buffer.length; index += 1) {
    const line = buffer.getLine(index);
    if (!line) continue;

    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  return lines.join("\n");
}

export function useTerminalSession({
  workspaceId,
  sessionId,
  cwd,
  paneSettings: providedPaneSettings,
  restoredHistory,
  historyLineLimit,
  focused,
  onHistoryChange,
  onAttention,
  onTitleChange,
  onDisconnected,
}: UseTerminalSessionOptions) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const focusedRef = useRef(focused);
  const paneSettingsRef = useRef<TerminalPaneSettings | null>(null);
  const historyLineLimitRef = useRef(historyLineLimit);
  const onHistoryChangeRef = useRef(onHistoryChange);
  const restoredHistoryRef = useRef<string | null>(null);
  const onDisconnectedRef = useRef(onDisconnected);

  historyLineLimitRef.current = historyLineLimit;
  focusedRef.current = focused;
  onDisconnectedRef.current = onDisconnected;
  onHistoryChangeRef.current = onHistoryChange;

  if (restoredHistoryRef.current === null) {
    restoredHistoryRef.current = sanitizeTerminalHistory(restoredHistory, historyLineLimit);
  }

  if (paneSettingsRef.current === null) {
    const currentSettings = loadSettings();
    paneSettingsRef.current = providedPaneSettings
      ? normalizeTerminalPaneSettings(providedPaneSettings, currentSettings)
      : snapshotTerminalSettings(currentSettings, cwd);
  }
  const paneSettings = paneSettingsRef.current;

  useEffect(() => {
    if (!focused) return;
    const frame = window.requestAnimationFrame(() => terminalRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, [focused]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: paneSettings.appearance.cursorBlink,
      cursorStyle: paneSettings.appearance.cursorStyle,
      fontFamily: paneSettings.appearance.fontFamily,
      fontSize: paneSettings.appearance.fontSize,
      lineHeight: paneSettings.appearance.lineHeight,
      scrollback: paneSettings.appearance.scrollback,
      theme: getXtermTheme(getCurrentTheme()),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();
    terminalRef.current = terminal;

    const clientId = createTerminalClientId(sessionId);
    terminalSessionLeases.claim(sessionId, clientId);

    let disposed = false;
    let started = false;
    let closeScheduled = false;
    let unlisten: UnlistenFn | undefined;
    let lifecycleUnlisten: UnlistenFn | undefined;
    let notificationBuffer = "";
    let historyCaptureTimer: number | undefined;
    const pendingInput: string[] = [];

    const scheduleOwnedClose = () => {
      if (closeScheduled) return;
      closeScheduled = true;
      queueMicrotask(() => {
        if (!terminalSessionLeases.release(sessionId, clientId)) return;
        void invoke("close_terminal", { sessionId, clientId }).catch(() => undefined);
      });
    };

    const captureHistory = () => {
      historyCaptureTimer = undefined;
      if (disposed) return;

      const combinedHistory = [restoredHistoryRef.current, readTerminalBuffer(terminal)]
        .filter(Boolean)
        .join("\n");
      onHistoryChangeRef.current(
        sanitizeTerminalHistory(combinedHistory, historyLineLimitRef.current),
      );
    };

    const scheduleHistoryCapture = () => {
      if (historyCaptureTimer !== undefined) return;
      historyCaptureTimer = window.setTimeout(captureHistory, HISTORY_CAPTURE_INTERVAL_MS);
    };

    const scanNotifications = (chunk: string) => {
      notificationBuffer += chunk;
      let consumed = 0;

      for (const match of notificationBuffer.matchAll(notificationPattern)) {
        onAttention(match[1]?.trim() || "Agent requires attention");
        consumed = (match.index ?? 0) + match[0].length;
      }

      if (consumed > 0) {
        notificationBuffer = notificationBuffer.slice(consumed);
      } else if (notificationBuffer.length > 4096) {
        notificationBuffer = notificationBuffer.slice(-256);
      }
    };

    const start = async () => {
      unlisten = await listen<TerminalOutputEvent>("terminal-output", (event) => {
        if (event.payload.sessionId !== sessionId || disposed) return;

        terminal.write(event.payload.data);
        scanNotifications(event.payload.data);
      });

      lifecycleUnlisten = await listen<TerminalLifecycleEvent>("terminal-lifecycle", (event) => {
        if (event.payload.sessionId !== sessionId || disposed) return;
        onDisconnectedRef.current?.(event.payload.message || "Terminal session ended");
      });

      if (disposed) {
        unlisten();
        return;
      }

      if (!terminalSessionLeases.owns(sessionId, clientId)) {
        unlisten();
        return;
      }

      await invoke("spawn_terminal", {
        workspaceId,
        sessionId,
        cwd: paneSettings.workingDirectory || null,
        shellProfileId: paneSettings.shellProfileId,
        customShellExecutable: paneSettings.customShellExecutable || null,
        startupCommand: paneSettings.startupCommand || null,
        clientId,
        ssh: resolveSshConnection(paneSettings),
        cols: terminal.cols,
        rows: terminal.rows,
      });

      if (disposed || !terminalSessionLeases.owns(sessionId, clientId)) {
        scheduleOwnedClose();
        return;
      }

      started = true;
      if (focusedRef.current) terminal.focus();
      for (const data of pendingInput.splice(0)) {
        await invoke("write_terminal", { sessionId, clientId, data });
      }
    };

    void start().catch((error) => {
      if (!disposed) {
        terminal.writeln(`\r\n[TonyMux] Failed to start terminal: ${String(error)}\r\n`);
      }
    });

    const inputDisposable = terminal.onData((data) => {
      if (!started) {
        pendingInput.push(data);
        return;
      }

      void invoke("write_terminal", { sessionId, clientId, data }).catch((error) => {
        if (!disposed) {
          terminal.writeln(`\r\n[TonyMux] Input error: ${String(error)}\r\n`);
        }
      });
    });

    const titleDisposable = terminal.onTitleChange((title) => {
      if (title.trim()) onTitleChange(title.trim());
    });
    const writeParsedDisposable = terminal.onWriteParsed(scheduleHistoryCapture);
    const focusTerminal = () => terminal.focus();
    host.addEventListener("pointerdown", focusTerminal);

    const onThemeChange = (event: Event) => {
      const theme = (event as CustomEvent<Theme>).detail;
      terminal.options.theme = getXtermTheme(theme);
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (!started) return;

      void invoke("resize_terminal", {
        sessionId,
        clientId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => undefined);
    });
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      if (historyCaptureTimer !== undefined) window.clearTimeout(historyCaptureTimer);
      resizeObserver.disconnect();
      inputDisposable.dispose();
      titleDisposable.dispose();
      writeParsedDisposable.dispose();
      host.removeEventListener("pointerdown", focusTerminal);
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      unlisten?.();
      lifecycleUnlisten?.();
      if (terminalRef.current === terminal) terminalRef.current = null;
      terminal.dispose();
      scheduleOwnedClose();
    };
  }, [onAttention, onTitleChange, paneSettings, sessionId, workspaceId]);

  return hostRef;
}
