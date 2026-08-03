# TonyMux settings

TonyMux stores a versioned, local settings document under:

```text
localStorage["tonymux.settings.v2"]
```

The document contains no credentials, automation token or shell executable path. Version 1 settings are migrated automatically and removed after the next successful save.

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
- scrollback capacity.

Saving settings never restarts an existing PTY. Manual and automation-created terminal panes use the current snapshot when they are created.

The startup command is bounded to 4 KiB, must be a single line and cannot contain NUL bytes. Rust validates the profile ID and startup command again before spawning the shell.

## Workspace restore

Settings version 2 adds `persistence.restoreWorkspaces`. When enabled, TonyMux restores bounded workspace and pane metadata from a previous launch. Restored terminals always start a new PTY and show a `Restored · new shell` label.

The Settings dialog can clear saved workspace state without deleting application settings or closing current panes. Disabling restore removes workspace generations and prevents further writes until the option is enabled again.

See [`SESSION-PERSISTENCE.md`](SESSION-PERSISTENCE.md) for the envelope, migration and recovery contract.

## Import and export

The Settings dialog can export `tonymux-settings.json` and import the same versioned schema. Values are normalized and bounded during import. Invalid data falls back safely to supported defaults.

Exported settings intentionally exclude automation tokens, named-pipe details, workspace contents, terminal output and repository credentials.

## Keyboard access

- `Ctrl+,` opens Settings.
- `Escape` closes the dialog.
- Tab focus is trapped inside the modal while it is open.
- Form errors use an alert region.
