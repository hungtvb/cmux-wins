import { X } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppSettings } from "../settings";
import {
  formatShortcutBinding,
  SHORTCUT_ACTIONS,
  type ShortcutActionId,
} from "../shortcuts";

const STORAGE_KEY = "tonymux.shortcut-hints-dismissed";

const HINT_ORDER: ShortcutActionId[] = [
  "commandPalette.open",
  "settings.open",
  "pane.splitTerminal",
  "notifications.toggle",
];

/**
 * A small, dismissible list of the most-used keyboard shortcuts, shown just
 * above the sidebar footer until the user dismisses it once (persisted in
 * localStorage). Helps new users discover the core action chords without an
 * intrusive onboarding modal.
 */
export function ShortcutHints({ settings }: { settings: AppSettings }) {
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(STORAGE_KEY) === "1");
    } catch {
      setDismissed(true);
    }
  }, []);

  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      /* non-fatal */
    }
  };

  const hints = HINT_ORDER.map((actionId) => {
    const action = SHORTCUT_ACTIONS.find((candidate) => candidate.id === actionId);
    const binding = settings.shortcuts[actionId];
    return { action, binding };
  }).filter((hint) => hint.action && hint.binding) as {
    action: { label: string };
    binding: string;
  }[];

  return (
    <div className="shortcut-hints" role="complementary" aria-label="Keyboard shortcuts">
      <div className="shortcut-hints__header">
        <span>Shortcuts</span>
        <button
          type="button"
          className="shortcut-hints__dismiss"
          aria-label="Dismiss shortcut hints"
          onClick={dismiss}
        >
          <X size={12} />
        </button>
      </div>
      <ul className="shortcut-hints__list">
        {hints.map((hint) => (
          <li key={hint.action.label} className="shortcut-hints__row">
            <span className="shortcut-hints__action" title={hint.action.label}>
              {hint.action.label}
            </span>
            <kbd className="shortcut-hints__key">{formatShortcutBinding(hint.binding)}</kbd>
          </li>
        ))}
      </ul>
    </div>
  );
}