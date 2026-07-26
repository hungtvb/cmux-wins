import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef } from "react";
import type { TerminalOutputEvent } from "../types";

type UseTerminalSessionOptions = {
  sessionId: string;
  cwd: string;
  onAttention: (message: string) => void;
  onTitleChange: (title: string) => void;
};

const notificationPattern = /\x1b\](?:9|99|777);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;

export function useTerminalSession({
  sessionId,
  cwd,
  onAttention,
  onTitleChange,
}: UseTerminalSessionOptions) {
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 10_000,
      theme: {
        background: "#0b0d12",
        foreground: "#d7dce5",
        cursor: "#80a4ff",
        selectionBackground: "#31415f",
        black: "#11131a",
        brightBlack: "#5a6270",
        red: "#ff7a90",
        brightRed: "#ff9aad",
        green: "#72d69c",
        brightGreen: "#92e6b2",
        yellow: "#e9c46a",
        brightYellow: "#f3d98d",
        blue: "#80a4ff",
        brightBlue: "#9cb8ff",
        magenta: "#bd93f9",
        brightMagenta: "#d2b4ff",
        cyan: "#74c7d8",
        brightCyan: "#9adce8",
        white: "#d7dce5",
        brightWhite: "#ffffff",
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
    const pendingInput: string[] = [];

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
        if (event.payload.sessionId !== sessionId || disposed) {
          return;
        }

        terminal.write(event.payload.data);
        scanNotifications(event.payload.data);
      });

      if (disposed) {
        unlisten();
        return;
      }

      await invoke("spawn_terminal", {
        sessionId,
        cwd: cwd || null,
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
        terminal.writeln(`\r\n[cmux] Failed to start terminal: ${String(error)}\r\n`);
      }
    });

    const inputDisposable = terminal.onData((data) => {
      if (!started) {
        pendingInput.push(data);
        return;
      }

      void invoke("write_terminal", { sessionId, data }).catch((error) => {
        if (!disposed) {
          terminal.writeln(`\r\n[cmux] Input error: ${String(error)}\r\n`);
        }
      });
    });

    const titleDisposable = terminal.onTitleChange((title) => {
      if (title.trim()) {
        onTitleChange(title.trim());
      }
    });

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit();
      if (!started) {
        return;
      }

      void invoke("resize_terminal", {
        sessionId,
        cols: terminal.cols,
        rows: terminal.rows,
      }).catch(() => undefined);
    });
    resizeObserver.observe(host);

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      inputDisposable.dispose();
      titleDisposable.dispose();
      unlisten?.();
      terminal.dispose();
      void invoke("close_terminal", { sessionId }).catch(() => undefined);
    };
  }, [cwd, onAttention, onTitleChange, sessionId]);

  return hostRef;
}
