# cmux Windows

A Windows 11 port of the core [cmux](https://github.com/manaflow-ai/cmux) workflow: vertical workspaces, split terminal panes, and agent-attention notifications.

The upstream application is native macOS software built with Swift, AppKit, and GhosttyKit. This project is therefore a platform port, not a direct recompilation. The Windows shell uses Tauri, React, xterm.js, Rust, and the Windows ConPTY API through `portable-pty`.

## MVP scope

Implemented on `feat/windows-mvp`:

- Native Windows desktop shell through Tauri/WebView2
- Vertical workspace sidebar
- Multiple persistent workspaces
- PowerShell terminals backed by ConPTY
- Split terminal panes
- Terminal resize and process cleanup
- OSC 9/99/777 agent-attention detection
- Per-pane attention ring and unread workspace indicator
- MSI and NSIS bundle configuration
- Windows CI for frontend and Rust checks

Not implemented yet:

- Embedded browser panes and browser automation
- Git branch, pull request, and listening-port metadata
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

## Build installers

```powershell
npm install
npm run tauri build
```

Generated MSI and NSIS installers are written under `src-tauri\target\release\bundle`.

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
