# TonyMux

**TonyMux** is a Windows 11 developer workspace for terminal-driven and AI-assisted workflows. It brings the useful workspace model popularized by [cmux](https://github.com/manaflow-ai/cmux) to Windows using Tauri, React, xterm.js, Rust, WebView2 and ConPTY.

TonyMux is a platform port and independent Windows implementation, not a direct recompilation of the macOS application.

## Current capabilities

- Versioned workspace persistence with previous-generation recovery
- Multiple ConPTY terminal panes
- Native WebView2 browser panes
- Git branch, dirty state, pull request and listening-port metadata
- Agent-attention notifications from OSC 9/99/777
- Current-user named-pipe automation API
- Workspace, pane, terminal and event automation
- Searchable `Ctrl+K` command palette
- Versioned Settings UI with allowlisted shell profiles
- MSI and NSIS Windows installers

The repository is delivered through stacked pull requests. Do not merge a stacked PR before its base PR.

## Design system

TonyMux uses the **Quiet Operator** design direction: a dark, low-distraction Windows developer workspace where terminal and browser content remain dominant, blue represents focus and selection, and violet is reserved for agent attention that requires human input.

See [`docs/DESIGN-SYSTEM.md`](docs/DESIGN-SYSTEM.md) before designing, reviewing, or implementing UI changes. It is the project baseline for layout, tokens, component states, accessibility, and future visual adoption.

## Prerequisites

Install on Windows 11:

1. Git
2. Node.js 20 or newer
3. Rust stable with the MSVC toolchain
4. Visual Studio Build Tools 2022 with **Desktop development with C++**
5. Microsoft Edge WebView2 Runtime

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Rustlang.Rustup -e
winget install --id Microsoft.VisualStudio.2022.BuildTools -e
winget install --id Microsoft.EdgeWebView2Runtime -e
```

## Run in development

The GitHub repository keeps its current name until the stacked PR chain is resolved:

```powershell
git clone https://github.com/hungtvb/cmux-wins.git
cd cmux-wins
git switch feat/session-persistence
npm install
npm run tauri dev
```

The default shell is Windows PowerShell. `CMUX_SHELL` remains the supported override during the compatibility period:

```powershell
$env:CMUX_SHELL = "pwsh.exe"
npm run tauri dev
```

## Keyboard shortcuts

These are the defaults. Every binding can be changed or unassigned in **Settings → Keyboard shortcuts**; TonyMux blocks duplicate assignments and uses physical key codes so bindings remain stable across keyboard layouts.

| Shortcut | Action |
|---|---|
| `Ctrl+K` | Open command palette |
| `Ctrl+,` | Open Settings |
| `Ctrl+N` | Create workspace |
| `Ctrl+1` … `Ctrl+9` | Switch workspace |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+Shift+B` | Add browser pane |
| `Ctrl+Shift+D` | Split terminal |
| `Ctrl+Shift+W` | Close current workspace |

## Settings

Settings are versioned, importable and exportable. Shell executable selection is validated again in Rust and limited to Windows PowerShell, PowerShell 7, Command Prompt and WSL. Shortcut bindings are conflict-checked and apply immediately; terminal profile changes apply to new panes without restarting existing sessions.

See [`docs/SETTINGS.md`](docs/SETTINGS.md) and [`docs/SESSION-PERSISTENCE.md`](docs/SESSION-PERSISTENCE.md).

## Build and verify

```powershell
npm install
npm run build
cargo check --manifest-path src-tauri/Cargo.toml --all-targets
npm run tauri build
```

The installer workflow publishes the `tonymux-windows-installers` artifact.

For the full Windows verification harness:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1 -AutomationSmoke
```

## Automation CLI

Build both the TonyMux CLI and the temporary compatibility alias:

```powershell
cargo build --manifest-path src-tauri/Cargo.toml --release --bin tonymux-cli --bin cmux-cli
```

Use the new command name:

```powershell
.\src-tauri\target\release\tonymux-cli.exe ping
.\src-tauri\target\release\tonymux-cli.exe info
.\src-tauri\target\release\tonymux-cli.exe workspace list
.\src-tauri\target\release\tonymux-cli.exe workspace create "Agent work" --cwd C:\code\project
.\src-tauri\target\release\tonymux-cli.exe pane terminal <workspace-id>
.\src-tauri\target\release\tonymux-cli.exe pane browser <workspace-id> https://example.com
.\src-tauri\target\release\tonymux-cli.exe terminal run <session-id> "Write-Output ok"
.\src-tauri\target\release\tonymux-cli.exe event read --wait-ms 30000
```

`cmux-cli.exe` remains available as a deprecated alias so existing scripts keep working during the rename.

## Compatibility during the rename

To preserve upgrades, existing workspaces and automation clients, these internal identifiers intentionally remain unchanged for now:

- Tauri application identifier: `com.hungtvb.cmuxwins`
- Legacy workspace localStorage keys and `tonymux.workspaces.v3/v4*` migrate into the bounded `tonymux.workspaces.v5` envelope
- Automation config: `%LOCALAPPDATA%\cmux-windows\automation-v1.json`
- Custom executable identity store: `%LOCALAPPDATA%\cmux-windows\trusted-shells-v2.json` (path-only v1 decisions are not migrated)
- Named pipe prefix: `cmux-windows-v1-*`
- Shell override: `CMUX_SHELL`

See [`docs/BRANDING.md`](docs/BRANDING.md) for the migration policy.

## License

GPL-3.0-or-later, matching the upstream project.
