import { BellRing, SquareTerminal, X } from "lucide-react";
import { memo, useCallback } from "react";
import { useTerminalSession } from "../hooks/useTerminalSession";
import type { TerminalPaneSettings } from "../settings";

type TerminalPaneProps = {
  workspaceId: string;
  sessionId: string;
  title: string;
  cwd: string;
  paneSettings?: TerminalPaneSettings;
  restored?: boolean;
  attention: boolean;
  focused: boolean;
  onFocus: () => void;
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
  attention,
  focused,
  onFocus,
  onAttention,
  onTitleChange,
  onClose,
}: TerminalPaneProps) {
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
    onAttention: handleAttention,
    onTitleChange: handleTitleChange,
  });

  return (
    <section
      className={`terminal-pane${focused ? " terminal-pane--focused" : ""}${attention ? " terminal-pane--attention" : ""}`}
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
          {restored && <span className="pane-restore-label">Restored · new shell</span>}
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
      <div className="terminal-pane__host" ref={hostRef} />
    </section>
  );
}

export const TerminalPane = memo(TerminalPaneComponent);
