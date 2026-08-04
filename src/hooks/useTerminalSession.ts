import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import {
  loadSettings,
  normalizeTerminalPaneSettings,
  snapshotTerminalSettings,
  type TerminalPaneSettings,
} from "../settings";
import { sanitizeTerminalHistory } from "../terminalHistory";
import type { TerminalOutputEvent } from "../types";

type UseTerminalSessionOptions = {
  workspaceId: string;
  sessionId: string;
  cwd: string;
  paneSettings?: TerminalPaneSettings;
  restoredHistory?: string;
  historyLineLimit: number;
  onHistoryChange: (history: string) => void;
  onAttention: (message: string) => void;
  onTitleChange: (title: string) => void;
};

const notificationPattern = /\x1b\](?:9|99|777);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
const HISTORY_CAPTURE_INTERVAL_MS = 2_000;

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
  onHistoryChange,
  onAttention,
  onTitleChange,
}: UseTerminalSessionOptions) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const paneSettingsRef = useRef<TerminalPaneSettings | null>(null);
  const historyLineLimitRef = useRef(historyLineLimit);
  const onHistoryChangeRef = useRef(onHistoryChange);
  const restoredHistoryRef = useRef<string | null>(null);

  historyLineLimitRef.current = historyLineLimit;
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
      theme: {
        background: "#0c0c0b",
        foreground: "#c6c6c1",
        cursor: "#d4ff40",
        selectionBackground: "#3a4216",
        black: "#10100f",
        brightBlack: "#73736e",
        red: "#ff9aa8",
        brightRed: "#ffc2cb",
        green: "#86d9a5",
        brightGreen: "#a9e8be",
        yellow: "#f1bd72",
        brightYellow: "#f8d59b",
        blue: "#7aa7ff",
        brightBlue: "#a7c4ff",
        magenta: "#c5a8ff",
        brightMagenta: "#dccaff",
        cyan: "#78d4d4",
        brightCyan: "#a4e6e6",
        white: "#d4d4d0",
        brightWhite: "#f5f5f4",
      },
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    fitAddon.fit();

    let disposed = false;
    let started = false;
    let unlisten: UnlistenFn | undefined;
    let notificationBuffer = "";
    let historyCaptureTimer: number | undefined;
    const pendingInput: string[] = [];

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

      if (disposed) {
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
        cols: terminal.cols,
        rows: terminal.rows,
      });

      if (disposed) {
        await invoke("close_terminal", { sessionId }).catch(() => undefined);
        return;
      }

      started = true;
      for (const data of pendingInput.splice(0)) {
        await invoke("write_terminal", { sessionId, data });
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

      void invoke("write_terminal", { sessionId, data }).catch((error) => {
        if (!disposed) {
          terminal.writeln(`\r\n[TonyMux] Input error: ${String(error)}\r\n`);
        }
      });
    });

    const titleDisposable = terminal.onTitleChange((title) => {
      if (title.trim()) onTitleChange(title.trim());
    });
    const writeParsedDisposable = terminal.onWriteParsed(scheduleHistoryCapture);

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (!started) return;

      void invoke("resize_terminal", {
        sessionId,
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
      unlisten?.();
      terminal.dispose();
      void invoke("close_terminal", { sessionId }).catch(() => undefined);
    };
  }, [onAttention, onTitleChange, paneSettings, sessionId, workspaceId]);

  return hostRef;
}
