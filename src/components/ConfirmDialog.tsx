import { AlertTriangle, Trash2 } from "lucide-react";
import { useEffect, useRef } from "react";

type ConfirmDialogProps = {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onClose: () => void;
};

/**
 * In-app replacement for window.confirm: a themed modal with a danger
 * variant, autofocus on Cancel (safe default), Enter confirms, Escape
 * cancels, and focus is restored to the opener on close.
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "Confirm",
  danger = false,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    requestAnimationFrame(() => cancelRef.current?.focus());

    return () => {
      returnFocusRef.current?.focus();
    };
  }, [open]);

  if (!open) return null;

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const handleConfirm = () => {
    onConfirm();
    onClose();
  };

  return (
    <div
      className="confirm-dialog"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      aria-describedby="confirm-dialog-message"
      onKeyDown={handleKeyDown}
    >
      <div className="confirm-dialog__card">
        <header className="confirm-dialog__header">
          <span className={`confirm-dialog__icon${danger ? " confirm-dialog__icon--danger" : ""}`}>
            {danger ? <AlertTriangle size={18} aria-hidden="true" /> : <Trash2 size={18} aria-hidden="true" />}
          </span>
          <h2 id="confirm-dialog-title">{title}</h2>
        </header>
        <p id="confirm-dialog-message" className="confirm-dialog__message">
          {message}
        </p>
        <footer className="confirm-dialog__footer">
          <button
            ref={cancelRef}
            type="button"
            className="settings-button settings-button--quiet"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            type="button"
            className={`settings-button${danger ? " settings-button--danger" : " settings-button--primary"}`}
            onClick={handleConfirm}
          >
            {confirmLabel}
          </button>
        </footer>
      </div>
    </div>
  );
}
