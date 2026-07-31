# cmux Windows

A Windows 11 port of the core [cmux](https://github.com/manaflow-ai/cmux) workflow: vertical workspaces, split terminal panes, embedded browser surfaces, development metadata, and agent-attention notifications.

The upstream application is native macOS software built with Swift, AppKit, and GhosttyKit. This project is therefore a platform port, not a direct recompilation. The Windows shell uses Tauri, React, xterm.js, Rust, WebView2, and the Windows ConPTY API through `portable-pty`.

## Delivery stack

The work is split into reviewable stacked pull requests:

1. `feat/windows-mvp` — terminal/workspace MVP, QA harness, installers and release pipeline
2. `feat/browser-panes` — native child WebView2 browser panes
3. `feat/workspace-metadata` — Git, pull request and workspace-owned listening-port metadata
4. `feat/local-automation` — current-user named-pipe protocol and `cmux-cli`

Do not merge a stacked PR before its base PR.

## Implemented baseline

- Native Windows desktop shell through Tauri/WebView2
- Vertical workspace sidebar
- Multiple persistent workspaces
- PowerShell terminals backed by ConPTY
- Split terminal panes
- Terminal resize and process cleanup
- Workspace close lifecycle with PTY cleanup
- Keyboard shortcuts for common workspace actions
- OSC 9/99/777 agent-attention detection
- Per-pane attention ring and unread workspace indicator
- MSI and NSIS bundle configuration
- Windows CI for frontend, Rust, ConPTY and installer artifacts

Implemented on later stacked branches:

- Native WebView2 browser panes and navigation controls
- Git repository, branch, dirty state, PR and workspace-owned port metadata
- Versioned local named-pipe transport and read-only CLI health commands

Roadmap work still includes:

- Workspace and pane mutation through the local automation API
- Bounded terminal output/events for local agents
- SSH workspace orchestration
- Session scrollback restoration
- Settings UI and keyboard shortcut editor
- Ghostty renderer/config compatibility

## Prerequisites

Install these on Windows 11:

1. Git
2. Node.js 20 or newer
3. Rust stable with the MSVC toolchain
4. Microsoft Visual Studio Build Tools 2022 with **Desktop development with C++**
5. Microsoft Edge WebView2 Runtime

Using `winget`:

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Rustlang.Rustup -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e
winget install --id Microsoft.EdgeWebView2Runtime -e
```

Open Visual Studio Installer after installing Build Tools and enable **Desktop development with C++**.

## Run in development

```powershell
git clone https://github.com/hungtvb/cmux-wins.git
cd cmux-wins
git switch feat/windows-mvp

npm install
npm run tauri dev
```

The default shell is Windows PowerShell. Override it before launching when needed:

```powershell
$env:CMUX_SHELL = "pwsh.exe"
npm run tauri dev
```

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+N` | Create workspace |
| `Ctrl+1` … `Ctrl+9` | Switch workspace |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+B` | Add browser pane on the browser branch |
| `Ctrl+Shift+D` | Split terminal |
| `Ctrl+Shift+W` | Close current workspace |

## Build installers

```powershell
npm install
npm run tauri build
```

Generated MSI and NSIS installers are written under `src-tauri\target\release\bundle`.

The Windows CI workflow uploads both installers as the `cmux-windows-installers` artifact after the compile checks pass.

## Local automation CLI

The first automation slice is available on `feat/local-automation`.

Start the desktop app first:

```powershell
git switch feat/local-automation
npm install
npm run tauri dev
```

Build the CLI:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --release --bin cmux-cli
```

Call the running app:

```powershell
.\src-tauri\target\release\cmux-cli.exe ping
.\src-tauri\target\release\cmux-cli.exe info
```

The CLI prints machine-readable JSON. Endpoint discovery and its random token are stored in:

```text
%LOCALAPPDATA%\cmux-windows\automation-v1.json
```

The named pipe is protected with a DACL for the current Windows user, rejects remote clients, enforces protocol version 1, and exposes only allowlisted methods. There is no generic shell-execution endpoint. See [`docs/AUTOMATION-PROTOCOL.md`](docs/AUTOMATION-PROTOCOL.md).

## Agent notification smoke test

Run this inside a cmux Windows terminal pane:

```powershell
Write-Host "`e]9;Agent requires approval`a" -NoNewline
```

The pane should receive a blue attention ring. If the workspace is not active, its sidebar item should show an unread bell.

## Architecture

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the platform mapping and delivery phases.

## License

GPL-3.0-or-later, matching the upstream project.
