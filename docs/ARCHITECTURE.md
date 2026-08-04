# cmux Windows architecture

## Verdict

The upstream macOS application cannot be converted by changing build flags. Its shell, window management, terminal view, browser host, menu handling, notifications, and update mechanism are tied to AppKit, SwiftUI, WebKit, Sparkle, and GhosttyKit.

The Windows port keeps the product concepts and interaction model while replacing platform-bound infrastructure.

## Platform mapping

| Upstream macOS concern | Windows port |
| --- | --- |
| Swift/AppKit application shell | React UI hosted by Tauri/WebView2 |
| GhosttyKit terminal rendering | xterm.js rendering |
| Unix PTY | Windows ConPTY through `portable-pty` |
| NSWindow / native split views | CSS grid panes inside one desktop window |
| WKWebView browser panes | Native WebView2 child views owned by Rust |
| Unix domain socket automation | Named pipe or localhost WebSocket in phase 3 |
| Sparkle updater | Tauri updater in phase 4 |
| macOS key equivalents | Windows shortcut registry |
| macOS notification APIs | Windows App SDK notifications in phase 3 |

## Current process model

```text
React workspace shell
        |
        | Tauri invoke/events
        v
Rust desktop backend
        |                         |
        | portable-pty            | child-webview APIs + policy callbacks
        v                         v
Windows ConPTY              WebView2 browser panes
        |
        v
powershell.exe / pwsh.exe / configured shell
```

Each terminal pane owns a stable UUID. The frontend sends that UUID with spawn, input, resize, and close commands. Rust stores the matching PTY master, writer, and child process in a mutex-protected registry. Output is streamed back through a single `terminal-output` event and filtered by session ID in the frontend.

Each browser pane also owns a stable UUID, but its remote document runs in a separate native child WebView2 surface. React owns the trusted toolbar and pane model; Rust owns the child view and enforces credential-free HTTP(S)-only navigation, denies popups and downloads, and emits bounded load/title/policy events back only to the trusted `main` webview. Browser events are normalized again before React updates the persisted URL or pane title. Remote pages receive no Tauri capability.

See [`BROWSER-SECURITY.md`](BROWSER-SECURITY.md).

## Workspace persistence model

Workspace persistence is a frontend concern and remains separate from the Rust PTY registry. `tonymux.workspaces.v5` stores bounded workspace, pane, focus, split, launch-profile and optional inert terminal-history data; `tonymux.workspaces.v5.previous` is the normalized previous known-good generation used for corruption recovery.

Raw PTY bytes are never serialized. xterm.js first parses live output, then TonyMux reads plain text from the rendered buffer, strips terminal control protocols again, and applies line, per-pane and whole-envelope byte limits. Restored history is rendered in a separate DOM block and never enters `terminal.write`, `write_terminal` or shell startup input.

On launch, restored terminal panes receive their persisted launch-profile snapshot but always invoke Rust to create a new PTY and process. Built-in IDs remain allowlisted in Rust. A custom snapshot may include one validated absolute `.exe` path, but Rust still requires that normalized path to exist in its separate current-user trust store before spawning. Process IDs, PTY handles, automation credentials, executable trust decisions and browser session data are never serialized into the workspace envelope. Versions 4 and 3 plus legacy `cmux-wins.workspaces.v1/v2` records migrate through the same normalization boundary.

See [`SESSION-PERSISTENCE.md`](SESSION-PERSISTENCE.md).

## Agent attention protocol

The first MVP recognizes OSC notifications commonly emitted by terminal tools:

- OSC 9
- OSC 99
- OSC 777

Detection currently happens in the frontend output stream. A later hardening task should move parsing into a stateful stream parser so sequences split across read chunks are handled correctly.

## Delivery phases

### Phase 1 — terminal MVP

- Workspace sidebar
- Split PowerShell panes
- PTY lifecycle
- Resize handling
- OSC attention rings
- Local workspace persistence
- Windows installers

### Phase 2 — browser and metadata

- WebView2 browser pane type (implemented)
- Address bar, in-page URL/title synchronization and fail-closed popup/download policy (implemented)
- Accessibility snapshot API
- Git branch and repository metadata
- Pull request status
- Listening-port discovery

### Phase 3 — automation and remote workflows

- Local named-pipe API
- CLI client
- SSH workspace creation
- Remote localhost routing
- Windows toast notifications
- Agent hooks and command palette

### Phase 4 — production hardening

- Versioned workspace restore and corruption recovery (metadata slice implemented)
- Bounded inert terminal-history capture and restored-history rendering (implemented)
- Versioned Settings v5, trusted custom executables and conflict-safe shortcut editor (implemented)
- Auto-update and signing
- Crash recovery
- PTY integration tests
- Accessibility and IME regression suite


### Shortcut dispatch boundary

Shortcut configuration is data-only: stable action IDs map to canonical `KeyboardEvent.code` chords. The settings document cannot introduce commands or executable callbacks. Runtime dispatch is an allowlisted action table in React, with duplicate validation, modifier requirements, IME/repeat guards and editable-target suppression. Settings remains reachable through a visible menu even when its chord is unassigned.

### Custom executable trust boundary

Custom profile configuration and executable authorization are deliberately separated. React stores bounded profile IDs, labels and paths in settings and snapshots the selected path into new terminal panes. Rust owns `%LOCALAPPDATA%\cmux-windows\trusted-shells-v2.json`; each bounded record binds a canonical case-insensitive path to SHA-256 and file size. Imported settings never modify the trust store, and the previous path-only v1 store is not migrated.

A custom profile can launch exactly one absolute local `.exe`; command-line arguments, environment assignments, shell expressions, relative paths and UNC locations are rejected before process creation. Rust opens the executable with write/delete sharing denied, verifies its identity, retains the verification handle through process creation and verifies the same handle again before accepting the child. Standard same-path replacement during the verify-to-spawn window therefore fails closed. Settings provides inspect, revoke, clear and corrupt/future-store recovery actions. Shared configured paths may reuse one trust record, and removing the last profile requires an explicit revoke decision.

## Known risks

1. **Renderer parity:** xterm.js will not exactly match Ghostty's renderer, configuration, or performance characteristics.
2. **Browser embedding:** Dedicated WebView2 child views isolate remote content from the trusted React shell, but focus, DPI, renderer-process cleanup and native-overlay behavior still require real Windows 11 QA.
3. **OSC chunking:** notification control sequences may be split across PTY reads in the current MVP.
4. **Process trees:** killing a shell does not guarantee every detached descendant process exits. Windows Job Objects should be added before production use.
5. **Unverified runtime:** CI can compile the project, but interactive ConPTY, focus, IME, resize, and notification behavior must be tested on a real Windows 11 desktop session.
