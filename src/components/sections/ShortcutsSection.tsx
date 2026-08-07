import { Keyboard, RotateCcw, X } from "lucide-react";
import type { KeyboardEvent } from "react";
import {
  SHORTCUT_ACTIONS,
  formatShortcutBinding,
  getShortcutAction,
} from "../../shortcuts";
import type { ShortcutActionId } from "../../shortcuts";

type ShortcutsSectionProps = {
  shortcuts: Record<ShortcutActionId, string | null>;
  recordingActionId: ShortcutActionId | null;
  shortcutError: string;
  shortcutsHelpId: string;
  shortcutsStatusId: string;
  resetShortcuts: () => void;
  recordShortcut: (actionId: ShortcutActionId, event: KeyboardEvent<HTMLButtonElement>) => void;
  clearShortcut: (actionId: ShortcutActionId) => void;
  setRecordingActionId: (actionId: ShortcutActionId | null) => void;
  setShortcutError: (error: string) => void;
};

export function ShortcutsSection({
  shortcuts,
  recordingActionId,
  shortcutError,
  shortcutsHelpId,
  shortcutsStatusId,
  resetShortcuts,
  recordShortcut,
  clearShortcut,
  setRecordingActionId,
  setShortcutError,
}: ShortcutsSectionProps) {
  return (
    <section className="settings-section" aria-labelledby="settings-shortcuts-title">
      <div className="settings-section__heading settings-section__heading--actions">
        <div className="settings-section__heading-main">
          <Keyboard size={15} aria-hidden="true" />
          <div>
            <h3 id="settings-shortcuts-title">Keyboard shortcuts</h3>
            <p id={shortcutsHelpId}>
              Select a binding, then press Ctrl or Alt with another key. Physical key positions
              keep bindings stable across keyboard layouts.
            </p>
          </div>
        </div>
        <button
          className="settings-button settings-button--quiet settings-button--compact"
          type="button"
          onClick={resetShortcuts}
        >
          <RotateCcw size={13} aria-hidden="true" />
          Reset shortcuts
        </button>
      </div>

      <div
        className="shortcut-list"
        role="list"
        aria-describedby={`${shortcutsHelpId} ${shortcutsStatusId}`}
      >
        {SHORTCUT_ACTIONS.map((action) => {
          const binding = shortcuts[action.id];
          const recording = recordingActionId === action.id;
          return (
            <div className="shortcut-row" role="listitem" key={action.id}>
              <div className="shortcut-row__copy">
                <span className="shortcut-row__section">{action.section}</span>
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </div>
              <div className="shortcut-row__actions">
                <button
                  className={`shortcut-recorder${recording ? " shortcut-recorder--recording" : ""}`}
                  type="button"
                  aria-pressed={recording}
                  aria-label={`${action.label}: ${recording ? "press a shortcut" : formatShortcutBinding(binding)}`}
                  onClick={() => {
                    setRecordingActionId(recording ? null : action.id);
                    setShortcutError("");
                  }}
                  onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                    if (recording) recordShortcut(action.id, event);
                  }}
                  onBlur={() => {
                    if (recording) setRecordingActionId(null);
                  }}
                >
                  {recording ? "Press shortcut…" : formatShortcutBinding(binding)}
                </button>
                <button
                  className="shortcut-clear"
                  type="button"
                  disabled={!binding}
                  aria-label={`Clear shortcut for ${action.label}`}
                  title="Clear shortcut"
                  onClick={() => clearShortcut(action.id)}
                >
                  <X size={13} aria-hidden="true" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      <div
        id={shortcutsStatusId}
        className={`shortcut-status${shortcutError ? " shortcut-status--error" : ""}`}
        role={shortcutError ? "alert" : "status"}
        aria-live="polite"
      >
        {shortcutError ||
          (recordingActionId
            ? `Recording ${getShortcutAction(recordingActionId).label}. Escape cancels; Backspace clears.`
            : "Unassigned actions remain available from visible controls and the command palette.")}
      </div>
    </section>
  );
}