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
| WKWebView browser panes | WebView2 child views in phase 2 |
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
Rust session registry
        |
        | portable-pty
        v
Windows ConPTY
        |
        v
powershell.exe / pwsh.exe / configured shell
```

Each terminal pane owns a stable UUID. The frontend sends that UUID with spawn, input, resize, and close commands. Rust stores the matching PTY master, writer, and child process in a mutex-protected registry. Output is streamed back through a single `terminal-output` event and filtered by session ID in the frontend.

## Workspace persistence model

Workspace persistence is a frontend metadata concern and remains separate from the Rust PTY registry. `tonymux.workspaces.v3` stores bounded workspace, pane, focus, split and launch-profile data; `tonymux.workspaces.v3.previous` is the previous known-good generation used for corruption recovery.

On launch, restored terminal panes receive their persisted allowlisted profile snapshot but always invoke Rust to create a new PTY and process. Process IDs, PTY handles, terminal output, automation credentials and browser session data are never serialized into the workspace envelope. Legacy `cmux-wins.workspaces.v1/v2` arrays migrate through the same normalization boundary.

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

- WebView2 browser pane type
- Address bar and navigation
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
- Bounded terminal scrollback capture and restored-history rendering
- Settings and shortcut editor
- Auto-update and signing
- Crash recovery
- PTY integration tests
- Accessibility and IME regression suite

## Known risks

1. **Renderer parity:** xterm.js will not exactly match Ghostty's renderer, configuration, or performance characteristics.
2. **Browser embedding:** Tauri's main webview cannot safely replace arbitrary embedded browser panes; dedicated WebView2 child views are required.
3. **OSC chunking:** notification control sequences may be split across PTY reads in the current MVP.
4. **Process trees:** killing a shell does not guarantee every detached descendant process exits. Windows Job Objects should be added before production use.
5. **Unverified runtime:** CI can compile the project, but interactive ConPTY, focus, IME, resize, and notification behavior must be tested on a real Windows 11 desktop session.
