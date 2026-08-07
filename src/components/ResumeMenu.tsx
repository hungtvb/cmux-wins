import { History, Settings2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { agentSessionLabel, type ResumeRecord } from "../resumeModel";

/** Compact relative timestamp, e.g. "3h ago", "2d ago". */
function relativeTime(timestamp: number, now: number = Date.now()): string {
  const diffMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

type ResumeMenuProps = {
  records: ResumeRecord[];
  notice: string | null;
  onResume: (record: ResumeRecord) => void;
  onOpenSettings: () => void;
  /** Start with the popover open (used by SSR/static render tests). */
  defaultOpen?: boolean;
};

/**
 * Topbar dropdown listing agent sessions that can be resumed in the current
 * workspace. Only rendered when at least one record matches the workspace
 * directory; clicking a row gates on the trusted-executable store, then opens
 * a new terminal pane with the resume command as its startup command.
 */
export function ResumeMenu({ records, notice, onResume, onOpenSettings, defaultOpen = false }: ResumeMenuProps) {
  const [open, setOpen] = useState(defaultOpen);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="resume-menu" ref={rootRef}>
      <button
        type="button"
        className={`toolbar-button toolbar-button--compact${open ? " toolbar-button--active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        aria-label="Resume agent session"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Resume agent session"
      >
        <History size={15} />
      </button>
      {open ? (
        <div className="resume-menu__popover" role="menu" aria-label="Resume agent session">
          <div className="resume-menu__header">Resume agent session</div>
          {notice ? <div className="resume-menu__notice">{notice}</div> : null}
          {records.length === 0 ? (
            <div className="resume-menu__empty">No sessions to resume in this workspace</div>
          ) : (
            <ul className="resume-menu__list">
              {records.map((record) => (
                <li key={`${record.agent}:${record.sessionId}:${record.cwd}`}>
                  <button
                    type="button"
                    className="resume-menu__item"
                    role="menuitem"
                    onClick={() => {
                      setOpen(false);
                      onResume(record);
                    }}
                  >
                    <History size={12} aria-hidden="true" />
                    <span className="resume-menu__label">{agentSessionLabel(record)}</span>
                    <span className="resume-menu__meta" title={record.sessionId}>
                      {relativeTime(record.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <button
            type="button"
            className="resume-menu__settings"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            <Settings2 size={12} aria-hidden="true" />
            <span>Agent integrations…</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
