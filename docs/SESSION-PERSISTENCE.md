# TonyMux session persistence

TonyMux restores workspace **metadata**, not operating-system processes. Every restored terminal pane starts a new allowlisted shell and every restored browser pane creates a new WebView2 instance.

## Storage generations

The current workspace envelope is stored at:

```text
localStorage["tonymux.workspaces.v3"]
```

Before replacing a valid current envelope, TonyMux copies it to:

```text
localStorage["tonymux.workspaces.v3.previous"]
```

If the current value is malformed or cannot produce a valid workspace, TonyMux attempts the previous generation. If neither generation is usable, it starts with a clean `Main` workspace. Settings remain independent and are never removed by workspace recovery.

## Persisted metadata

Version 3 stores only bounded presentation and launch metadata:

- workspace ID, title and working directory;
- pane ID, type and title;
- active workspace and active pane per workspace;
- split ratios clamped to 28–72%;
- browser URLs limited to credential-free HTTP(S) URLs;
- terminal shell-profile, working-directory, startup-command and appearance snapshots.

The envelope does not contain PTY handles, process IDs, automation tokens, named-pipe metadata, terminal output, browser cookies or repository credentials.

## Restored terminal behavior

A restored terminal displays `Restored · new shell` in its pane header. The stored profile snapshot selects the same Rust-allowlisted shell profile, but TonyMux always calls `spawn_terminal` for a new process. It never claims that a terminated PTY survived an application restart.

Terminal scrollback capture and restored-history rendering are deliberately deferred to the next #9 slice.

## Migration

TonyMux accepts the previous workspace array formats:

```text
localStorage["cmux-wins.workspaces.v2"]
localStorage["cmux-wins.workspaces.v1"]
```

Legacy records are normalized into the v3 envelope and removed after the next successful save. Missing or duplicate IDs are replaced, unsafe URLs fall back to `https://github.com`, and unbounded strings or pane counts are truncated to supported limits.

## User controls

Settings includes **Restore workspaces on launch**. Disabling it removes all workspace generations and legacy keys while leaving current panes open until TonyMux closes.

**Clear saved state** removes the same workspace keys immediately. It does not delete `tonymux.settings.*`, close panes or terminate processes. A later workspace mutation may create a fresh snapshot again while restore remains enabled.
