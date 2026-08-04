# Windows 11 Runtime QA

This checklist covers behavior that compile checks and headless ConPTY tests cannot fully prove. Record the Windows build, shell versions, installer used, tester, date, and evidence for every run.

## Test environment

- Windows edition/build:
- Device architecture:
- cmux commit/version:
- Installer: MSI / NSIS / development build
- Windows PowerShell version:
- PowerShell 7 version:
- Git / GitHub CLI version:
- WebView2 Runtime version:
- Keyboard/IME:
- Tester/date:

## Automated prerequisite

The `Windows CI` workflow should pass all of these before interactive QA:

- Frontend reducer tests and TypeScript/Vite build
- Rust/Tauri `cargo check --all-targets`
- Rust unit tests
- Windows ConPTY integration tests
- `cmux-cli.exe` release build
- MSI and NSIS packaging

When GitHub-hosted runners are unavailable, run the equivalent local gate on Windows 11:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1
```

For a full app/CLI round trip:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1 -AutomationSmoke
```

Attach the complete console output to the relevant PR or issue. A local pass does not replace installer QA, DPI/input checks or an eventual CI pass.

The ConPTY suite verifies:

- PowerShell process spawn
- PTY input/output round trip
- Terminal resize API
- Clean shell exit
- Explicit child kill and termination
- PowerShell 7 round trip when `pwsh.exe` is installed

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
- [ ] Closing the final workspace creates a clean `Main` workspace through the UI
- [ ] Workspace layout and metadata survive an application restart

### Native browser panes

- [ ] `Ctrl+Shift+B` creates a browser pane
- [ ] GitHub and a local development URL load without iframe restrictions
- [ ] Back, forward, reload and address navigation work
- [ ] An in-page link or redirect updates the address bar to the committed HTTP(S) URL
- [ ] The pane title follows the loaded document title and remains bounded in the sidebar/layout
- [ ] Loading state appears during navigation and clears after completion
- [ ] A stalled navigation shows the 30-second retryable error; Retry starts a fresh navigation
- [ ] HTTP and HTTPS navigation work
- [ ] `file:`, `javascript:`, `data:`, custom protocols and credential-bearing URLs are rejected with visible feedback
- [ ] `window.open` or a `target=_blank` link is denied and shows a popup notice
- [ ] A download request is denied, shows a notice and creates no file
- [ ] Browser pane stays alive while switching workspaces
- [ ] Hidden workspace browser panes do not overlay the active workspace
- [ ] Pane bounds remain correct after window resize and DPI/display changes
- [ ] Browser focus returns correctly to terminal input
- [ ] Closing a browser pane removes its native WebView2 child
- [ ] Remote DevTools cannot invoke TonyMux/Tauri commands

### Git, PR and listening-port metadata

- [ ] Repository name and branch match the workspace cwd
- [ ] Dirty state appears and clears after working-tree changes
- [ ] Ahead/behind counts match the configured upstream
- [ ] Current PR appears when `gh` is installed and authenticated
- [ ] Missing or unauthenticated `gh` does not block terminal input
- [ ] A Node/Vite server port appears only on its owning workspace
- [ ] A Java or other child-process port appears only on its owning workspace
- [ ] Unrelated machine ports are not assigned to a workspace
- [ ] Port badges disappear after the process exits
- [ ] Metadata polling remains responsive with several workspaces

### Local automation API

Run the automated smoke first:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1 -AutomationSmoke
```

Then verify manually when deeper inspection is needed:

```powershell
.\src-tauri\target\release\cmux-cli.exe ping
.\src-tauri\target\release\cmux-cli.exe info
.\src-tauri\target\release\cmux-cli.exe workspace list
```

- [ ] Pipe config exists under `%LOCALAPPDATA%\cmux-windows\automation-v1.json`
- [ ] `ping` and `info` return valid JSON
- [ ] Workspace create/list/select/close round trips succeed
- [ ] Terminal and browser pane create/close round trips succeed
- [ ] Closing the final workspace returns `LAST_WORKSPACE_PROTECTED`
- [ ] Closing the final pane returns `LAST_PANE_PROTECTED`
- [ ] CLI fails with structured JSON when the desktop app is not running
- [ ] CLI requests during UI reload fail with `UI_NOT_READY` or complete after readiness; none hang indefinitely
- [ ] A browser child webview cannot call the local automation/Tauri commands
- [ ] Oversized request and response behavior is bounded and recorded
- [ ] Repeated create/close operations leave no orphan PTY or WebView2 process/resource

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

For local servers, capture listening ports before and after close:

```powershell
Get-NetTCPConnection -State Listen |
  Select-Object LocalAddress, LocalPort, OwningProcess |
  Sort-Object LocalPort
```

## Evidence template

Post one result block per tested commit:

```text
Commit:
Windows build:
Installer/development mode:
verify-local.ps1 result:
Automation smoke result:
Interactive sections passed:
Linked defects:
Screenshots/logs:
Tester/date:
```

## Exit criteria for issue #2 and stacked PRs

- Automated ConPTY tests pass on the tested head.
- Frontend reducer, Rust unit and local automation tests pass.
- Every applicable interactive checklist item is pass or has a linked defect.
- MSI and NSIS installation results are recorded.
- No orphan-process defect remains open.
- Browser, metadata and automation evidence is attached to their tracking issues.
- QA evidence is posted to issue #2 before PR #1 is merged.
