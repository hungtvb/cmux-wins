import { CornerDownLeft, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { filterCommandPaletteItems, type CommandPaletteItem } from "./commandPaletteModel";

type CommandPaletteProps = {
  open: boolean;
  items: CommandPaletteItem[];
  onClose: () => void;
};

export function CommandPalette({ open, items, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const filteredItems = useMemo(() => filterCommandPaletteItems(items, query), [items, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(filteredItems.length - 1, 0)));
  }, [filteredItems.length]);

  if (!open) return null;

  const runItem = (item: CommandPaletteItem) => {
    onClose();
    item.run();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();

    if (event.key === "Tab") {
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'input, button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );
      if (focusable.length > 0) {
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((index) => (filteredItems.length ? (index + 1) % filteredItems.length : 0));
      return;
    }

    if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) =>
        filteredItems.length ? (index - 1 + filteredItems.length) % filteredItems.length : 0,
      );
      return;
    }

    if (event.key === "Enter" && filteredItems[activeIndex]) {
      event.preventDefault();
      runItem(filteredItems[activeIndex]);
    }
  };

  const handleBackdropPointerDown = (event: MouseEvent<HTMLDivElement>) => {
    if (event.target === event.currentTarget) onClose();
  };

  let previousSection = "";

  return (
    <div
      className="command-palette-backdrop"
      role="presentation"
      onMouseDown={handleBackdropPointerDown}
      onKeyDown={handleKeyDown}
    >
      <section
        ref={dialogRef}
        className="command-palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="command-palette__search">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.currentTarget.value);
              setActiveIndex(0);
            }}
            placeholder="Search commands and workspaces"
            aria-label="Search commands and workspaces"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={filteredItems[activeIndex] ? `command-${filteredItems[activeIndex].id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>

        <div id="command-palette-results" className="command-palette__results" role="listbox" aria-label="Available commands">
          {filteredItems.length === 0 ? (
            <div className="command-palette__empty">
              <Search size={20} />
              <strong>No matching commands</strong>
              <span>Try a workspace name, “terminal”, or “browser”.</span>
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const showSection = item.section !== previousSection;
              previousSection = item.section;

              return (
                <div className="command-palette__group" key={item.id}>
                  {showSection && <div className="command-palette__section">{item.section}</div>}
                  <button
                    id={`command-${item.id}`}
                    className={`command-palette__item${index === activeIndex ? " command-palette__item--active" : ""}${item.danger ? " command-palette__item--danger" : ""}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeIndex}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => runItem(item)}
                  >
                    <span className="command-palette__item-copy">
                      <strong>{item.label}</strong>
                      {item.description && <small>{item.description}</small>}
                    </span>
                    <span className="command-palette__item-hint">
                      {item.shortcut ? <kbd>{item.shortcut}</kbd> : index === activeIndex ? <CornerDownLeft size={14} /> : null}
                    </span>
                  </button>
                </div>
              );
            })
          )}
        </div>

        <footer className="command-palette__footer">
          <span><kbd>↑</kbd><kbd>↓</kbd> Navigate</span>
          <span><kbd>Enter</kbd> Run</span>
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </div>
  );
}
