import { FolderPlus } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";

type CreateWorkspaceDialogProps = {
  open: boolean;
  defaultTitle: string;
  onCreate: (title: string, cwd: string) => void;
  onClose: () => void;
};

/**
 * In-app replacement for the native window.prompt used when creating a
 * workspace: same flow, but rendered with the app theme and full keyboard
 * support (Enter submits, Escape cancels, focus is restored on close).
 */
export function CreateWorkspaceDialog({
  open,
  defaultTitle,
  onCreate,
  onClose,
}: CreateWorkspaceDialogProps) {
  const [title, setTitle] = useState(defaultTitle);
  const [cwd, setCwd] = useState("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setTitle(defaultTitle);
    setCwd("");
    requestAnimationFrame(() => {
      titleInputRef.current?.focus();
      titleInputRef.current?.select();
    });

    return () => {
      returnFocusRef.current?.focus();
    };
  }, [open, defaultTitle]);

  if (!open) return null;

  const trimmedTitle = title.trim();
  const canSubmit = trimmedTitle.length > 0;

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canSubmit) return;
    onCreate(trimmedTitle, cwd.trim());
    onClose();
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="create-workspace-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-workspace-title"
      onKeyDown={handleKeyDown}
    >
      <form className="create-workspace-dialog__card" onSubmit={handleSubmit}>
        <header className="create-workspace-dialog__header">
          <FolderPlus size={18} aria-hidden="true" />
          <h2 id="create-workspace-title">New workspace</h2>
        </header>

        <label className="create-workspace-dialog__field">
          <span>Workspace name</span>
          <input
            ref={titleInputRef}
            type="text"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Workspace name"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </label>

        <label className="create-workspace-dialog__field">
          <span>Working directory <em>(optional)</em></span>
          <input
            type="text"
            value={cwd}
            onChange={(event) => setCwd(event.target.value)}
            placeholder="e.g. C:\projects\my-app"
            autoComplete="off"
            spellCheck={false}
          />
        </label>

        <footer className="create-workspace-dialog__footer">
          <button type="button" className="settings-button settings-button--quiet" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            className="settings-button settings-button--primary"
            disabled={!canSubmit}
          >
            Create workspace
          </button>
        </footer>
      </form>
    </div>
  );
}
