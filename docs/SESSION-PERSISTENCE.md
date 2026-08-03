# TonyMux session persistence

TonyMux restores bounded workspace presentation state, not operating-system processes. Every restored terminal pane starts a new allowlisted shell and every restored browser pane creates a new WebView2 instance.

## Storage generations

The current workspace envelope is stored at:

```text
localStorage["tonymux.workspaces.v4"]
```

Before replacing a valid current envelope, TonyMux normalizes it with the current retention settings and stores that known-good generation at:

```text
localStorage["tonymux.workspaces.v4.previous"]
```

If the current value is malformed or cannot produce a valid workspace, TonyMux attempts the previous generation. Oversized history is truncated while valid workspace metadata is retained. If neither generation is usable, it starts with a clean `Main` workspace. Settings remain independent and are never removed by workspace recovery.

## Persisted metadata

Version 4 stores only bounded presentation and launch metadata:

- workspace ID, title and working directory;
- pane ID, type and title;
- active workspace and active pane per workspace;
- split ratios clamped to 28–72%;
- browser URLs limited to credential-free HTTP(S) URLs;
- terminal shell-profile, working-directory, startup-command and appearance snapshots;
- optional inert terminal-history text.

The envelope does not contain PTY handles, process IDs, automation tokens, named-pipe metadata, browser cookies or repository credentials.

## Terminal-history capture pipeline

TonyMux does not persist raw PTY output. Raw output is first parsed and rendered by xterm.js. After xterm completes a write batch, TonyMux reads immutable lines from the normal xterm scrollback buffer with `translateToString(true)`, joins wrapped rows, and then passes the resulting plain text through a second sanitizer.

The sanitizer:

- normalizes CRLF and CR to LF;
- strips complete CSI, OSC, DCS, SOS, PM and APC sequences, including C1 forms;
- removes C0/C1 control characters except line breaks and tabs;
- keeps the newest configured lines;
- truncates from the oldest UTF-8 content without splitting a code point.

Capture is coalesced to at most one snapshot per interval, so continuous output still makes progress without writing localStorage for every PTY chunk. TonyMux always reads the normal scrollback buffer; alternate-screen applications cannot replace saved history with viewport-only content.

## Retention limits

The default is 500 lines per terminal pane. Settings accepts values from 0 to 5,000 lines; `0` disables history persistence.

Hard limits apply even when imported or corrupted data requests more:

- 512 KiB UTF-8 text per terminal pane;
- 4 MiB UTF-8 terminal-history text across the workspace envelope;
- existing workspace and pane-count limits still apply.

When the total budget is exhausted, later panes in deterministic workspace order receive only the remaining safe budget. Valid workspace metadata is retained even when a history snapshot is dropped or truncated.

## Restored terminal behavior

Restored history is rendered in a separate read-only DOM block above the live xterm surface. TonyMux never passes restored history to `terminal.write`, `write_terminal`, a shell startup command or any PTY input path. Therefore captured bytes cannot change the live terminal title, create links, emit notifications or execute shell input during restoration.

The block includes a visible and keyboard-accessible divider:

```text
Restored history · New shell below
```

The stored profile snapshot selects the same Rust-allowlisted shell profile, but TonyMux always calls `spawn_terminal` for a new process. The history block remains immutable for that pane lifetime while new output is captured into the next bounded snapshot.

## Migration

TonyMux accepts the previous workspace formats:

```text
localStorage["tonymux.workspaces.v3"]
localStorage["tonymux.workspaces.v3.previous"]
localStorage["cmux-wins.workspaces.v2"]
localStorage["cmux-wins.workspaces.v1"]
```

Version 3 metadata migrates cleanly without terminal history. Legacy records are normalized into the v4 envelope and removed after the next successful save. Missing or duplicate IDs are replaced, unsafe URLs fall back to `https://github.com`, and unbounded strings, pane counts and history payloads are truncated to supported limits.

Unknown future envelope versions are rejected instead of being downgraded and overwritten.

## User controls

Settings includes **Restore workspaces on launch** and **Restored terminal history lines**. Disabling workspace restore removes all workspace generations and legacy keys while leaving current panes open until TonyMux closes.

Setting history retention to `0` removes history from both the next current generation and the normalized previous generation while preserving layout metadata.

**Clear saved state** removes every workspace generation immediately. It does not delete `tonymux.settings.*`, close panes or terminate processes. A later workspace mutation may create a fresh snapshot again while restore remains enabled.
