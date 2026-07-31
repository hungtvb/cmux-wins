# Windows 11 Runtime QA

This checklist covers behavior that compile checks and headless ConPTY tests cannot fully prove. Record the Windows build, shell versions, installer used, tester, date, and evidence for every run.

## Test environment

- Windows edition/build:
- Device architecture:
- cmux commit/version:
- Installer: MSI / NSIS / development build
- Windows PowerShell version:
- PowerShell 7 version:
- WebView2 Runtime version:
- Keyboard/IME:
- Tester/date:

## Automated prerequisite

The `Windows CI` workflow must pass all of these before interactive QA:

- Frontend TypeScript/Vite build
- Rust/Tauri `cargo check`
- Windows ConPTY integration tests
- MSI and NSIS packaging

The ConPTY suite verifies:

- PowerShell process spawn
- PTY input/output round trip
- Terminal resize API
- Clean shell exit
- Explicit child kill and termination
- PowerShell 7 round trip when `pwsh.exe` is installed on the runner

## Interactive smoke checklist

### Installation and launch

- [ ] MSI installs and launches the application
- [ ] MSI uninstall removes the application without removing unrelated user data
- [ ] NSIS EXE installs and launches the application
- [ ] NSIS uninstall succeeds
- [ ] App icon, name and version are correct in Windows Apps
- [ ] SmartScreen behavior is recorded for the unsigned build

### Terminal basics

- [ ] Default Windows PowerShell opens without an error banner
- [ ] `pwsh.exe` opens when `CMUX_SHELL=pwsh.exe`
- [ ] Typed commands execute and output streams continuously
- [ ] Copy and paste work with keyboard shortcuts and context menu
- [ ] Long-running commands remain active while switching workspaces
- [ ] Rapid resize does not freeze, corrupt or terminate the terminal
- [ ] Closing a pane ends its shell process
- [ ] Closing a workspace ends every shell process owned by it
- [ ] Closing the application leaves no orphan PowerShell process

### Text input

- [ ] Vietnamese Telex input works in the terminal
- [ ] Vietnamese VNI input works when available
- [ ] Composed characters render correctly
- [ ] Emoji and common Unicode symbols render without breaking input
- [ ] Backspace, Ctrl+C, Ctrl+V, Ctrl+Z and arrow keys behave correctly

### Workspaces and panes

- [ ] `Ctrl+N` creates a workspace
- [ ] `Ctrl+1` through `Ctrl+9` switch workspaces
- [ ] `Ctrl+B` toggles the sidebar
- [ ] `Ctrl+Shift+D` splits the active workspace
- [ ] `Ctrl+Shift+W` closes the active workspace after confirmation
- [ ] Switching workspace does not restart or duplicate terminal sessions
- [ ] Closing the final workspace creates a clean `Main` workspace
- [ ] Workspace layout and metadata survive an application restart

### Agent attention

Run inside a terminal pane:

```powershell
Write-Host "`e]9;Agent requires approval`a" -NoNewline
```

- [ ] Active pane receives the attention ring
- [ ] Inactive workspace receives the unread indicator
- [ ] Selecting the workspace clears its unread state
- [ ] `Mark read` clears pane attention state
- [ ] Split OSC sequences across output chunks are still detected

## Process cleanup evidence

Before and after closing panes/workspaces, capture:

```powershell
Get-Process powershell, pwsh -ErrorAction SilentlyContinue |
  Select-Object Id, ProcessName, StartTime
```

Any shell started by cmux must disappear after its owning pane or workspace is closed. Pre-existing shells must remain untouched.

## Exit criteria for issue #2

- Automated ConPTY tests pass on the PR head.
- Every interactive checklist item is pass or has a linked defect.
- MSI and NSIS installation results are recorded.
- No orphan-process defect remains open.
- QA evidence is posted to issue #2 before PR #1 is merged.
