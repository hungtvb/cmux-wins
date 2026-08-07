import { TerminalSquare } from "lucide-react";
import type { ChangeEvent } from "react";
import type { FontCheckResult } from "../../fontAvailability";
import type { AppSettings, CursorStyle } from "../../settings";

type TerminalAppearance = AppSettings["terminal"];

type TerminalAppearanceSectionProps = {
  terminal: TerminalAppearance;
  fontCheck: FontCheckResult;
  onChange: <Key extends keyof TerminalAppearance>(
    key: Key,
    value: TerminalAppearance[Key],
  ) => void;
};

export function TerminalAppearanceSection({
  terminal,
  fontCheck,
  onChange,
}: TerminalAppearanceSectionProps) {
  return (
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
            value={terminal.fontFamily}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange("fontFamily", event.target.value)
            }
          />
        </label>
        <label className="settings-field settings-field--wide">
          <span>Font preset</span>
          <select
            value={terminal.fontFamily}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              onChange("fontFamily", event.target.value)
            }
          >
            <optgroup label="Nerd Font (for Oh My Posh)">
              <option value='"CaskaydiaCove Nerd Font", "Cascadia Code", monospace'>
                CaskaydiaCove Nerd Font
              </option>
              <option value='"JetBrainsMono Nerd Font", "JetBrains Mono", Consolas, monospace'>
                JetBrainsMono Nerd Font
              </option>
              <option value='"MesloLGM Nerd Font", "Meslo LG M", Consolas, monospace'>
                MesloLGM Nerd Font
              </option>
            </optgroup>
            <optgroup label="Monospace">
              <option value='"JetBrains Mono", "SFMono-Regular", Consolas, monospace'>
                JetBrains Mono (default)
              </option>
              <option value='"Cascadia Mono", Consolas, monospace'>Cascadia Mono</option>
              <option value="Consolas, monospace">Consolas</option>
            </optgroup>
            <option value={terminal.fontFamily}>Custom — {terminal.fontFamily}</option>
          </select>
          {fontCheck.status === "unavailable" && fontCheck.missingFamily && (
            <span className="settings-field__hint settings-field__hint--warn" role="status">
              “{fontCheck.missingFamily}” not found on this machine. If you use Oh My Posh,
              install a Nerd Font for Powerline glyphs.
            </span>
          )}
        </label>
        <label className="settings-field">
          <span>Font size</span>
          <input
            type="number"
            min={10}
            max={24}
            step={1}
            value={terminal.fontSize}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange("fontSize", Number(event.target.value))
            }
          />
        </label>
        <label className="settings-field">
          <span>Line height</span>
          <input
            type="number"
            min={1}
            max={2}
            step={0.05}
            value={terminal.lineHeight}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange("lineHeight", Number(event.target.value))
            }
          />
        </label>
        <label className="settings-field">
          <span>Cursor</span>
          <select
            value={terminal.cursorStyle}
            onChange={(event: ChangeEvent<HTMLSelectElement>) =>
              onChange("cursorStyle", event.target.value as CursorStyle)
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
            value={terminal.scrollback}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange("scrollback", Number(event.target.value))
            }
          />
        </label>
        <label className="settings-toggle settings-field--wide">
          <input
            type="checkbox"
            checked={terminal.cursorBlink}
            onChange={(event: ChangeEvent<HTMLInputElement>) =>
              onChange("cursorBlink", event.target.checked)
            }
          />
          <span>
            <strong>Blinking cursor</strong>
            <small>Disable it for reduced visual motion.</small>
          </span>
        </label>
      </div>
    </section>
  );
}