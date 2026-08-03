# TonyMux settings

TonyMux stores a versioned, local settings document under:

```text
localStorage["tonymux.settings.v4"]
```

Versions 3, 2 and 1 are migrated automatically and removed after the next successful save. The settings document contains no credentials, automation token or shell executable path.

## Shell profiles

New terminal panes can use one of four Rust-allowlisted profiles:

| Profile ID | Executable |
|---|---|
| `windows-powershell` | `powershell.exe` |
| `powershell-7` | `pwsh.exe` |
| `command-prompt` | `cmd.exe` |
| `wsl` | `wsl.exe` |

The legacy `CMUX_SHELL` environment variable remains a compatibility override. It has precedence when set to a non-empty value.

TonyMux does not accept an executable path from the frontend settings document. Custom executable profiles are intentionally deferred until path validation and an explicit trust flow are implemented.

## Session behavior

Settings are snapshotted when a terminal pane is created:

- shell profile;
- effective working directory;
- optional startup command;
- font family and size;
- line height;
- cursor style and blinking;
- live xterm scrollback capacity.

Saving settings never restarts an existing PTY. Manual and automation-created terminal panes use the current snapshot when they are created.

The startup command is bounded to 4 KiB, must be a single line and cannot contain NUL bytes. Rust validates the profile ID and startup command again before spawning the shell.

## Keyboard shortcuts

Settings version 4 stores a conflict-free map of stable action IDs to canonical chords such as `Ctrl+Shift+KeyB`. The recorder uses `KeyboardEvent.code`, so a binding follows the physical key position rather than a locale-sensitive character.

The editable actions cover:

- Settings and command palette;
- new/close workspace;
- split terminal and open browser pane;
- sidebar visibility;
- workspace slots 1 through 9.

A global chord must include Ctrl or Alt. Shift can be added, but bare printable keys, modifier-only presses, the Windows key, `Alt+F4` and `Ctrl+Alt+Delete` are rejected. An action can be explicitly unassigned; visible toolbar/menu controls and the command palette remain available.

The Settings recorder names an existing action immediately when a duplicate is attempted. Validation repeats the conflict check during save and import. If persisted storage is externally modified to contain duplicates, TonyMux keeps unrelated settings and restores the shortcut map to safe defaults.

Global shortcuts are ignored while users type in form fields, selects or contenteditable surfaces and while IME composition is active. The xterm helper textarea is intentionally exempt so TonyMux shortcuts still work while the terminal has focus. App-level shortcuts are suspended while the Settings dialog is open so recorder input cannot trigger background actions.

## Workspace restore

Settings version 4 contains:

```text
persistence.restoreWorkspaces
persistence.terminalHistoryLines
```

`restoreWorkspaces` controls bounded workspace and pane metadata restoration. Restored terminals always start a new PTY.

`terminalHistoryLines` controls inert terminal-history retention:

- default: 500 lines;
- minimum: 0, which disables history persistence;
- maximum: 5,000 lines;
- hard storage limits: 512 KiB per pane and 4 MiB total history text.

Restored history is displayed in a separate block with a **New shell below** divider. It is never written into xterm or replayed into a shell process.

The Settings dialog can clear saved workspace state without deleting application settings or closing current panes. Disabling restore removes workspace generations and prevents further writes until the option is enabled again.

See [`SESSION-PERSISTENCE.md`](SESSION-PERSISTENCE.md) for the envelope, migration, sanitization and recovery contract.

## Import and export

The Settings dialog can export `tonymux-settings.json` and import the same versioned schema. Values are normalized and bounded during import. Invalid data falls back safely to supported defaults.

Exported settings intentionally exclude automation tokens, named-pipe details, workspace contents, terminal output and repository credentials. The export contains only the history-retention preference, never saved history itself.

## Keyboard access

- The configured Settings shortcut opens the dialog; the visible **Settings** menu action remains available when unassigned.
- `Escape` closes the dialog.
- Tab focus is trapped inside the modal while it is open.
- Shortcut recording and conflict messages use status/alert live regions.
- Form errors use an alert region.
- The restored-history text block is keyboard-focusable so long content can be scrolled without a pointer.
