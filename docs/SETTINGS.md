# TonyMux settings

TonyMux stores a versioned, local settings document under:

```text
localStorage["tonymux.settings.v5"]
```

Versions 4, 3, 2 and 1 are migrated automatically and removed after the next successful save. The settings document contains no credentials, automation token or executable trust decision. Custom profile paths are configuration data and may be exported, but trust remains in the Rust-owned local store described below.

## Theme

Appearance theme (dark/light, SF-inspired with adaptive lime accent) is **not** part of the settings document — it lives in `localStorage["tm-theme"]` so it applies before first paint. First launch follows the system `prefers-color-scheme`; afterwards the topbar Sun/Moon toggle wins and persists. See `docs/DESIGN-SYSTEM.md` → Themes for token behavior.

## Shell profiles

New terminal panes can use one of four Rust-allowlisted profiles:

| Profile ID | Executable |
|---|---|
| `windows-powershell` | `powershell.exe` |
| `powershell-7` | `pwsh.exe` |
| `command-prompt` | `cmd.exe` |
| `wsl` | `wsl.exe` |

The legacy `CMUX_SHELL` environment variable remains a compatibility override for the four built-in profiles. It has precedence when set to a non-empty value.

Settings version 5 also supports at most 12 custom profiles. Each profile has a stable `custom:*` ID, a bounded label and one absolute local Windows `.exe` path. Paths cannot contain command-line arguments, quotes, wildcards, environment-variable expansion, alternate data-stream separators, empty segments, `.`/`..` traversal, UNC locations or control characters.

Changing a custom executable path immediately invalidates its UI trust state. The user must press **Trust executable** before selecting it as the default shell. Rust persists executable identities separately at:

```text
%LOCALAPPDATA%\cmux-windows\trusted-shells-v2.json
```

Each record binds the canonical case-insensitive path to its SHA-256 fingerprint and byte length. The store is bounded to 32 records and replaced through a temporary-file write with rollback when publication fails. The previous path-only `trusted-shells-v1.json` file is intentionally not migrated; custom executables must be trusted again after this upgrade.

Before every custom process spawn, Rust opens the file with write/delete sharing denied, checks the current fingerprint against the trusted record, keeps that handle alive through `CreateProcess`, and hashes the same handle again after process creation. If the file is missing, changed, replaced during launch or unavailable, the new child is rejected or terminated. Editing localStorage alone cannot authorize an executable.

Settings lists every trust record with `Identity matches`, `File changed`, `File missing` or `Unavailable` state. Users can refresh, revoke one record, clear all records or reset an unreadable/future-version store without editing files manually. Multiple profiles may share one executable path; removing one profile retains trust while another profile still references that path. Removing the final referencing profile asks before revoking trust.

## SSH connections

Settings version 5 also supports at most 12 SSH connection profiles. Each profile has a stable `ssh:*` ID, a bounded label, a host (letters, digits, dots, dashes, underscores, colons — IPv4, IPv6 and hostnames), a port (1–65535, default 22), a user and an optional identity-file path.

An SSH profile spawns the Windows OpenSSH client (`ssh.exe`, shipped with Windows 10+) inside the same ConPTY pane used for local shells: `ssh -p <port> [-i <identity file>] <user>@<host>`. Password prompts, host-key confirmation and interactive remote shells work directly in the terminal. Rust validates the connection again before spawning and bypasses the local-shell trust path because `ssh.exe` is a Windows system binary — no trust record is required.

SSH profiles are selectable as the default shell for new panes. Remote panes keep the local working-directory/startup-command behavior only where meaningful; the remote session is governed by the SSH server's default shell and the profile's identity settings. Credentials are never stored in settings; the profile stores only host, port, user and key path.

## Session behavior

Settings are snapshotted when a terminal pane is created:

- shell profile;
- snapshotted custom executable path, when applicable;
- effective working directory;
- optional startup command;
- font family and size;
- line height;
- cursor style and blinking;
- live xterm scrollback capacity.

Saving settings never restarts an existing PTY. Manual and automation-created terminal panes use the current snapshot when they are created.

The startup command is bounded to 4 KiB, must be a single line and cannot contain NUL bytes. Rust validates the profile ID, optional custom executable, trust decision and startup command again before spawning the shell.

## Keyboard shortcuts

Settings version 5 retains the version 4 conflict-free map of stable action IDs to canonical chords such as `Ctrl+Shift+KeyB`. The recorder uses `KeyboardEvent.code`, so a binding follows the physical key position rather than a locale-sensitive character.

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

Settings version 5 contains:

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

Exported settings intentionally exclude automation tokens, named-pipe details, workspace contents, terminal output, repository credentials and executable trust decisions. Custom profile labels and paths are exported so configuration can move between machines, but imported paths remain untrusted unless the destination Windows account had already trusted the same normalized executable. The export contains only the history-retention preference, never saved history itself.

## Keyboard access

- The configured Settings shortcut opens the dialog; the visible **Settings** menu action remains available when unassigned.
- `Escape` closes the dialog.
- Tab focus is trapped inside the modal while it is open.
- Shortcut recording and conflict messages use status/alert live regions.
- Custom-profile trust actions and store recovery report pending, success and failure state through polite live regions.
- Form errors use an alert region.
- The restored-history text block is keyboard-focusable so long content can be scrolled without a pointer.
