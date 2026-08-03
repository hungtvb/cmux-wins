import { BellRing, History, SquareTerminal, X } from "lucide-react";
import { memo, useCallback, useId, useRef, type CSSProperties } from "react";
import { useTerminalSession } from "../hooks/useTerminalSession";
import type { TerminalPaneSettings } from "../settings";

type TerminalPaneProps = {
  workspaceId: string;
  sessionId: string;
  title: string;
  cwd: string;
  paneSettings?: TerminalPaneSettings;
  restored?: boolean;
  restoredHistory?: string;
  historyLineLimit: number;
  attention: boolean;
  focused: boolean;
  onFocus: () => void;
  onHistoryChange: (sessionId: string, history: string) => void;
  onAttention: (sessionId: string, message: string) => void;
  onTitleChange: (sessionId: string, title: string) => void;
  onClose: (sessionId: string) => void;
};

function TerminalPaneComponent({
  workspaceId,
  sessionId,
  title,
  cwd,
  paneSettings,
  restored,
  restoredHistory,
  historyLineLimit,
  attention,
  focused,
  onFocus,
  onHistoryChange,
  onAttention,
  onTitleChange,
  onClose,
}: TerminalPaneProps) {
  const historyTitleId = useId();
  const initialRestoredHistoryRef = useRef<string | null>(null);
  if (initialRestoredHistoryRef.current === null) {
    initialRestoredHistoryRef.current = restored ? restoredHistory ?? "" : "";
  }
  const initialRestoredHistory = initialRestoredHistoryRef.current;
  const restoredHistoryLineCount = initialRestoredHistory
    ? initialRestoredHistory.split("\n").length
    : 0;
  const restoredHistoryStyle = {
    "--restored-history-font-family":
      paneSettings?.appearance.fontFamily ?? '"Cascadia Code", "Cascadia Mono", Consolas, monospace',
    "--restored-history-font-size": `${paneSettings?.appearance.fontSize ?? 13}px`,
    "--restored-history-line-height": paneSettings?.appearance.lineHeight ?? 1.25,
  } as CSSProperties;

  const handleHistoryChange = useCallback(
    (history: string) => onHistoryChange(sessionId, history),
    [onHistoryChange, sessionId],
  );
  const handleAttention = useCallback(
    (message: string) => onAttention(sessionId, message),
    [onAttention, sessionId],
  );
  const handleTitleChange = useCallback(
    (nextTitle: string) => onTitleChange(sessionId, nextTitle),
    [onTitleChange, sessionId],
  );
  const hostRef = useTerminalSession({
    workspaceId,
    sessionId,
    cwd,
    paneSettings,
    restoredHistory: initialRestoredHistory,
    historyLineLimit,
    onHistoryChange: handleHistoryChange,
    onAttention: handleAttention,
    onTitleChange: handleTitleChange,
  });

  return (
    <section
      className={`terminal-pane${focused ? " terminal-pane--focused" : ""}${attention ? " terminal-pane--attention" : ""}${initialRestoredHistory ? " terminal-pane--with-history" : ""}`}
      onFocusCapture={onFocus}
      onPointerDown={onFocus}
    >
      <header className="terminal-pane__header">
        <div className="terminal-pane__title" title={title}>
          {attention ? (
            <BellRing size={14} aria-label="Agent requires attention" />
          ) : (
            <SquareTerminal size={13} aria-hidden="true" />
          )}
          <span>{title}</span>
          {restored && (
            <span className="pane-restore-label">
              {initialRestoredHistory ? "Restored history" : "Restored · new shell"}
            </span>
          )}
          {focused && <span className="pane-focus-label">Active</span>}
        </div>
        <button
          className="icon-button"
          type="button"
          title="Close pane"
          aria-label="Close pane"
          onClick={() => onClose(sessionId)}
        >
          <X size={15} />
        </button>
      </header>

      {initialRestoredHistory && (
        <aside
          className="terminal-pane__restored-history"
          aria-labelledby={historyTitleId}
          style={restoredHistoryStyle}
        >
          <div className="terminal-pane__history-heading">
            <History size={13} aria-hidden="true" />
            <span id={historyTitleId}>Restored terminal history</span>
            <span>{restoredHistoryLineCount.toLocaleString()} lines</span>
          </div>
          <pre
            tabIndex={0}
            role="region"
            aria-label="Restored terminal history, read only"
          >
            {initialRestoredHistory}
          </pre>
          <div
            className="terminal-pane__history-divider"
            role="separator"
            aria-label="Restored history ends. New shell begins below."
          >
            <span>Restored history</span>
            <strong>New shell below</strong>
          </div>
        </aside>
      )}

      <div className="terminal-pane__host" ref={hostRef} />
    </section>
  );
}

export const TerminalPane = memo(TerminalPaneComponent);
