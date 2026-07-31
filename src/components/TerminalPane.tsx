import { BellRing, X } from "lucide-react";
import { memo, useCallback } from "react";
import { useTerminalSession } from "../hooks/useTerminalSession";

type TerminalPaneProps = {
  workspaceId: string;
  sessionId: string;
  title: string;
  cwd: string;
  attention: boolean;
  onAttention: (sessionId: string, message: string) => void;
  onTitleChange: (sessionId: string, title: string) => void;
  onClose: (sessionId: string) => void;
};

function TerminalPaneComponent({
  workspaceId,
  sessionId,
  title,
  cwd,
  attention,
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
    onAttention: handleAttention,
    onTitleChange: handleTitleChange,
  });

  return (
    <section className={`terminal-pane${attention ? " terminal-pane--attention" : ""}`}>
      <header className="terminal-pane__header">
        <div className="terminal-pane__title" title={title}>
          {attention && <BellRing size={14} aria-label="Agent requires attention" />}
          <span>{title}</span>
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
