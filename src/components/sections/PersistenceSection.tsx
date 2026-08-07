import { Database, Trash2 } from "lucide-react";
import type { ChangeEvent } from "react";
import { MAX_TERMINAL_HISTORY_LINES } from "../../terminalHistory";
import type { AppSettings } from "../../settings";

type PersistenceSectionProps = {
  persistence: AppSettings["persistence"];
  setDraft: (updater: (current: AppSettings) => AppSettings) => void;
  historyHelpId: string;
  clearSavedWorkspaceState: () => void;
};

export function PersistenceSection({
  persistence,
  setDraft,
  historyHelpId,
  clearSavedWorkspaceState,
}: PersistenceSectionProps) {
  return (
    <section className="settings-section" aria-labelledby="settings-persistence-title">
      <div className="settings-section__heading">
        <Database size={15} aria-hidden="true" />
        <div>
          <h3 id="settings-persistence-title">Workspace restore</h3>
          <p>Restore saved layout metadata while always starting fresh terminal processes.</p>
        </div>
      </div>

      <div className="settings-form-grid">
        <label className="settings-toggle settings-field--wide">
          <input
            type="checkbox"
            checked={persistence.restoreWorkspaces}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setDraft((current) => ({
                ...current,
                persistence: {
                  ...current.persistence,
                  restoreWorkspaces: event.target.checked,
                },
              }))
            }
          />
          <span>
            <strong>Restore workspaces on launch</strong>
            <small>
              Stores bounded layout metadata and, when enabled below, inert terminal history.
            </small>
          </span>
        </label>
        <label className="settings-field settings-field--wide">
          <span>Restored terminal history lines</span>
          <input
            type="number"
            min={0}
            max={MAX_TERMINAL_HISTORY_LINES}
            step={100}
            value={persistence.terminalHistoryLines}
            disabled={!persistence.restoreWorkspaces}
            aria-describedby={historyHelpId}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              setDraft((current) => ({
                ...current,
                persistence: {
                  ...current.persistence,
                  terminalHistoryLines: Number(event.target.value),
                },
              }))
            }
          />
          <small id={historyHelpId}>
            Use 0 to disable history. TonyMux stores at most 5,000 lines, 512 KiB per pane and 4
            MiB total.
          </small>
        </label>
        <div className="settings-persistence-action settings-field--wide">
          <div>
            <strong>Saved workspace state</strong>
            <small>
              Clearing it does not remove TonyMux settings or close current panes.
            </small>
          </div>
          <button
            className="settings-button settings-button--danger"
            type="button"
            onClick={clearSavedWorkspaceState}
          >
            <Trash2 size={14} />
            Clear saved state
          </button>
        </div>
      </div>
    </section>
  );
}