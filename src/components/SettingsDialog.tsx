import {
  Database,
  Download,
  Keyboard,
  RotateCcw,
  Settings2,
  TerminalSquare,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import {
  DEFAULT_SETTINGS,
  SHELL_PROFILES,
  exportSettings,
  importSettings,
  normalizeSettings,
  validateSettings,
  type AppSettings,
  type CursorStyle,
  type ShellProfileId,
} from "../settings";
import {
  DEFAULT_SHORTCUT_BINDINGS,
  SHORTCUT_ACTIONS,
  findShortcutConflict,
  formatShortcutBinding,
  getShortcutAction,
  shortcutFromKeyboardEvent,
  type ShortcutActionId,
} from "../shortcuts";
import { MAX_TERMINAL_HISTORY_LINES } from "../terminalHistory";

type SettingsDialogProps = {
  open: boolean;
  settings: AppSettings;
  onSave: (settings: AppSettings) => void;
  onClearWorkspaceState: () => void;
  onClose: () => void;
};

function cloneSettings(settings: AppSettings): AppSettings {
  return {
    ...settings,
    terminal: { ...settings.terminal },
    persistence: { ...settings.persistence },
    shortcuts: { ...settings.shortcuts },
  };
}

export function SettingsDialog({
  open,
  settings,
  onSave,
  onClearWorkspaceState,
  onClose,
}: SettingsDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const historyHelpId = useId();
  const shortcutsHelpId = useId();
  const shortcutsStatusId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState(() => cloneSettings(settings));
  const [errors, setErrors] = useState<string[]>([]);
  const [notice, setNotice] = useState("");
  const [recordingActionId, setRecordingActionId] = useState<ShortcutActionId | null>(null);
  const [shortcutError, setShortcutError] = useState("");

  useEffect(() => {
    if (!open) return;
    setDraft(cloneSettings(settings));
    setErrors([]);
    setNotice("");
    setRecordingActionId(null);
    setShortcutError("");
    requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>(
          "button:not([disabled]), input:not([disabled]), select:not([disabled])",
        )
        ?.focus();
    });
  }, [open, settings]);

  if (!open) return null;

  const updateTerminal = <Key extends keyof AppSettings["terminal"]>(
    key: Key,
    value: AppSettings["terminal"][Key],
  ) => {
    setDraft((current) => ({
      ...current,
      terminal: { ...current.terminal, [key]: value },
    }));
  };

  const handleDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" && recordingActionId) {
      event.preventDefault();
      setRecordingActionId(null);
      setShortcutError("");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;

    const focusable = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (focusable.length === 0) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const save = () => {
    const normalized = normalizeSettings(draft);
    const nextErrors = validateSettings(normalized);
    setErrors(nextErrors);
    if (nextErrors.length) return;
    onSave(normalized);
    onClose();
  };

  const reset = () => {
    setDraft(cloneSettings(DEFAULT_SETTINGS));
    setErrors([]);
    setNotice("");
    setRecordingActionId(null);
    setShortcutError("");
  };

  const resetShortcuts = () => {
    setDraft((current) => ({
      ...current,
      shortcuts: { ...DEFAULT_SHORTCUT_BINDINGS },
    }));
    setRecordingActionId(null);
    setShortcutError("");
    setNotice("Keyboard shortcuts reset to TonyMux defaults.");
  };

  const clearShortcut = (actionId: ShortcutActionId) => {
    setDraft((current) => ({
      ...current,
      shortcuts: { ...current.shortcuts, [actionId]: null },
    }));
    setRecordingActionId(null);
    setShortcutError("");
  };

  const recordShortcut = (
    actionId: ShortcutActionId,
    event: KeyboardEvent<HTMLButtonElement>,
  ) => {
    if (event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();

    if (event.key === "Escape") {
      setRecordingActionId(null);
      setShortcutError("");
      return;
    }

    if (
      (event.key === "Backspace" || event.key === "Delete") &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      clearShortcut(actionId);
      return;
    }

    const binding = shortcutFromKeyboardEvent(event);
    if (!binding) {
      setShortcutError(
        "Use Ctrl or Alt with a non-modifier key. Escape cancels; Backspace clears.",
      );
      return;
    }

    const conflictActionId = findShortcutConflict(draft.shortcuts, actionId, binding);
    if (conflictActionId) {
      setShortcutError(
        `${formatShortcutBinding(binding)} is already assigned to ${getShortcutAction(conflictActionId).label}.`,
      );
      return;
    }

    setDraft((current) => ({
      ...current,
      shortcuts: { ...current.shortcuts, [actionId]: binding },
    }));
    setRecordingActionId(null);
    setShortcutError("");
  };

  const clearSavedWorkspaceState = () => {
    if (!window.confirm("Clear saved TonyMux workspace state? Current panes will remain open.")) {
      return;
    }
    onClearWorkspaceState();
    setNotice("Saved workspace state cleared. Current panes remain open until you close TonyMux.");
    setErrors([]);
  };

  const exportFile = () => {
    const blob = new Blob([exportSettings(draft)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "tonymux-settings.json";
    link.click();
    URL.revokeObjectURL(url);
  };

  const importFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;

    try {
      setDraft(importSettings(await file.text()));
      setErrors([]);
      setRecordingActionId(null);
      setShortcutError("");
    } catch (cause) {
      setErrors([`Unable to import settings: ${String(cause)}`]);
    }
  };

  return (
    <div className="settings-scrim" role="presentation" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onMouseDown={(event: MouseEvent<HTMLDivElement>) => event.stopPropagation()}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="settings-dialog__header">
          <div className="settings-dialog__heading">
            <span className="settings-dialog__icon" aria-hidden="true">
              <Settings2 size={18} />
            </span>
            <div>
              <h2 id={titleId}>TonyMux settings</h2>
              <p id={descriptionId}>
                New terminal panes use these values. Existing sessions keep running unchanged.
              </p>
            </div>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close settings"
            title="Close settings (Esc)"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="settings-dialog__body">
          <section className="settings-section" aria-labelledby="settings-shell-title">
            <div className="settings-section__heading">
              <TerminalSquare size={15} aria-hidden="true" />
              <div>
                <h3 id="settings-shell-title">Shell profile</h3>
                <p>Choose the allowlisted executable used by newly created terminals.</p>
              </div>
            </div>

            <div className="profile-grid" role="radiogroup" aria-label="Default shell profile">
              {SHELL_PROFILES.map((profile) => {
                const selected = draft.defaultShellProfileId === profile.id;
                return (
                  <button
                    key={profile.id}
                    className={`profile-card${selected ? " profile-card--selected" : ""}`}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() =>
                      setDraft((current) => ({
                        ...current,
                        defaultShellProfileId: profile.id as ShellProfileId,
                      }))
                    }
                  >
                    <strong>{profile.label}</strong>
                    <span>{profile.description}</span>
                    <code>{profile.executable}</code>
                  </button>
                );
              })}
            </div>

            <div className="settings-form-grid">
              <label className="settings-field settings-field--wide">
                <span>Default working directory</span>
                <input
                  value={draft.defaultWorkingDirectory}
                  placeholder="Leave empty to inherit the workspace directory"
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setDraft((current) => ({
                      ...current,
                      defaultWorkingDirectory: event.target.value,
                    }))
                  }
                />
              </label>
              <label className="settings-field settings-field--wide">
                <span>Startup command</span>
                <input
                  value={draft.startupCommand}
                  placeholder="Optional command sent after the shell starts"
                  onChange={(event: ChangeEvent<HTMLInputElement>) =>
                    setDraft((current) => ({
                      ...current,
                      startupCommand: event.target.value,
                    }))
                  }
                />
              </label>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-terminal-title">
            <div className="settings-section__heading">
              <TerminalSquare size={15} aria-hidden="true" />
              <div>
                <h3 id="settings-terminal-title">Terminal appearance</h3>
                <p>Dense defaults tuned for long-running developer workspaces.</p>
              </div>
            </div>

            <div className="settings-form-grid">
              <label className="settings-field settings-field--wide">
                <span>Font family</span>
                <input
                  value={draft.terminal.fontFamily}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("fontFamily", event.target.value)}
                />
              </label>
              <label className="settings-field">
                <span>Font size</span>
                <input
                  type="number"
                  min={10}
                  max={24}
                  step={1}
                  value={draft.terminal.fontSize}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("fontSize", Number(event.target.value))}
                />
              </label>
              <label className="settings-field">
                <span>Line height</span>
                <input
                  type="number"
                  min={1}
                  max={2}
                  step={0.05}
                  value={draft.terminal.lineHeight}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("lineHeight", Number(event.target.value))}
                />
              </label>
              <label className="settings-field">
                <span>Cursor</span>
                <select
                  value={draft.terminal.cursorStyle}
                  onChange={(event: ChangeEvent<HTMLSelectElement>) =>
                    updateTerminal("cursorStyle", event.target.value as CursorStyle)
                  }
                >
                  <option value="bar">Bar</option>
                  <option value="block">Block</option>
                  <option value="underline">Underline</option>
                </select>
              </label>
              <label className="settings-field">
                <span>Scrollback lines</span>
                <input
                  type="number"
                  min={1_000}
                  max={100_000}
                  step={1_000}
                  value={draft.terminal.scrollback}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("scrollback", Number(event.target.value))}
                />
              </label>
              <label className="settings-toggle settings-field--wide">
                <input
                  type="checkbox"
                  checked={draft.terminal.cursorBlink}
                  onChange={(event: ChangeEvent<HTMLInputElement>) => updateTerminal("cursorBlink", event.target.checked)}
                />
                <span>
                  <strong>Blinking cursor</strong>
                  <small>Disable it for reduced visual motion.</small>
                </span>
              </label>
            </div>
          </section>

          <section className="settings-section" aria-labelledby="settings-shortcuts-title">
            <div className="settings-section__heading settings-section__heading--actions">
              <div className="settings-section__heading-main">
                <Keyboard size={15} aria-hidden="true" />
                <div>
                  <h3 id="settings-shortcuts-title">Keyboard shortcuts</h3>
                  <p id={shortcutsHelpId}>
                    Select a binding, then press Ctrl or Alt with another key. Physical key positions keep bindings stable across keyboard layouts.
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
                const binding = draft.shortcuts[action.id];
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
                        onKeyDown={(event) => {
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
                  checked={draft.persistence.restoreWorkspaces}
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
                  <small>Stores bounded layout metadata and, when enabled below, inert terminal history.</small>
                </span>
              </label>
              <label className="settings-field settings-field--wide">
                <span>Restored terminal history lines</span>
                <input
                  type="number"
                  min={0}
                  max={MAX_TERMINAL_HISTORY_LINES}
                  step={100}
                  value={draft.persistence.terminalHistoryLines}
                  disabled={!draft.persistence.restoreWorkspaces}
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
                  Use 0 to disable history. TonyMux stores at most 5,000 lines, 512 KiB per pane and 4 MiB total.
                </small>
              </label>
              <div className="settings-persistence-action settings-field--wide">
                <div>
                  <strong>Saved workspace state</strong>
                  <small>Clearing it does not remove TonyMux settings or close current panes.</small>
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

          {notice && (
            <div className="settings-notice" role="status">
              {notice}
            </div>
          )}

          {errors.length > 0 && (
            <div className="settings-errors" role="alert">
              {errors.map((error) => (
                <p key={error}>{error}</p>
              ))}
            </div>
          )}
        </div>

        <footer className="settings-dialog__footer">
          <div className="settings-dialog__utility-actions">
            <button className="settings-button settings-button--quiet" type="button" onClick={reset}>
              <RotateCcw size={14} />
              Reset
            </button>
            <button
              className="settings-button settings-button--quiet"
              type="button"
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={14} />
              Import
            </button>
            <button
              className="settings-button settings-button--quiet"
              type="button"
              onClick={exportFile}
            >
              <Download size={14} />
              Export
            </button>
            <input
              ref={importInputRef}
              className="sr-only"
              type="file"
              accept="application/json,.json"
              onChange={importFile}
            />
          </div>
          <div className="settings-dialog__primary-actions">
            <button className="settings-button settings-button--quiet" type="button" onClick={onClose}>
              Cancel
            </button>
            <button className="settings-button settings-button--primary" type="button" onClick={save}>
              Save settings
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
