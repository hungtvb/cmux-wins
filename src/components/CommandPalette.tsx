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
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const ranCommandRef = useRef(false);
  const filteredItems = useMemo(() => filterCommandPaletteItems(items, query), [items, query]);
  const groupedItems = useMemo(() => {
    const groups: Array<{
      section: string;
      items: Array<{ item: CommandPaletteItem; index: number }>;
    }> = [];

    filteredItems.forEach((item, index) => {
      const previousGroup = groups.at(-1);
      if (previousGroup?.section === item.section) {
        previousGroup.items.push({ item, index });
      } else {
        groups.push({ section: item.section, items: [{ item, index }] });
      }
    });

    return groups;
  }, [filteredItems]);

  useEffect(() => {
    if (!open) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    ranCommandRef.current = false;
    setQuery("");
    setActiveIndex(0);
    requestAnimationFrame(() => inputRef.current?.focus());

    return () => {
      if (ranCommandRef.current) return;
      requestAnimationFrame(() => returnFocusRef.current?.focus());
    };
  }, [open]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(filteredItems.length - 1, 0)));
  }, [filteredItems.length]);

  useEffect(() => {
    if (!open) return;
    const activeItem = filteredItems[activeIndex];
    if (!activeItem) return;
    document.getElementById(`command-${activeItem.id}`)?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, filteredItems, open]);

  if (!open) return null;

  const runItem = (item: CommandPaletteItem) => {
    ranCommandRef.current = true;
    onClose();
    item.run();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();

    if (event.key === "Tab") {
      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'input:not([disabled]):not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), [href]:not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])',
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
            aria-describedby="command-palette-status"
            aria-activedescendant={filteredItems[activeIndex] ? `command-${filteredItems[activeIndex].id}` : undefined}
            autoComplete="off"
            spellCheck={false}
          />
          <kbd>Esc</kbd>
        </div>

        <p id="command-palette-status" className="sr-only" aria-live="polite">
          {filteredItems.length === 1
            ? "1 command available"
            : `${filteredItems.length} commands available`}
        </p>

        <div id="command-palette-results" className="command-palette__results" role="listbox" aria-label="Available commands">
          {filteredItems.length === 0 ? (
            <div className="command-palette__empty">
              <Search size={20} aria-hidden="true" />
              <strong>No matching commands</strong>
              <span>Try a workspace name, “terminal”, or “browser”.</span>
            </div>
          ) : (
            groupedItems.map((group, groupIndex) => {
              const sectionId = `command-palette-section-${groupIndex}`;
              return (
                <div
                  className="command-palette__group"
                  key={`${group.section}-${groupIndex}`}
                  role="group"
                  aria-labelledby={sectionId}
                >
                  <div id={sectionId} className="command-palette__section">
                    {group.section}
                  </div>
                  {group.items.map(({ item, index }) => (
                    <button
                      id={`command-${item.id}`}
                      className={`command-palette__item${index === activeIndex ? " command-palette__item--active" : ""}${item.danger ? " command-palette__item--danger" : ""}`}
                      key={item.id}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={index === activeIndex}
                      onMouseEnter={() => setActiveIndex(index)}
                      onClick={() => runItem(item)}
                    >
                      <span className="command-palette__item-copy">
                        <strong>{item.label}</strong>
                        {item.description && <small>{item.description}</small>}
                      </span>
                      <span className="command-palette__item-hint">
                        {item.shortcut ? (
                          <kbd>{item.shortcut}</kbd>
                        ) : index === activeIndex ? (
                          <CornerDownLeft size={14} aria-hidden="true" />
                        ) : null}
                      </span>
                    </button>
                  ))}
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
