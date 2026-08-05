# Windows 11 Runtime QA

This checklist covers behavior that compile checks and headless ConPTY tests cannot fully prove. Record the Windows build, shell versions, package used, tester, date, and evidence for every run.

## Test environment

- Windows edition/build:
- Device architecture:
- cmux commit/version:
- Package: portable ZIP / MSI / NSIS / development build
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
- Portable ZIP, MSI and NSIS packaging

When GitHub-hosted runners are unavailable, run the equivalent local gate on Windows 11:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1
```

For a full app/CLI round trip:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\verify-local.ps1 -AutomationSmoke
```

Attach the complete console output to the relevant PR or issue. A local pass does not replace portable/installer QA, DPI/input checks or an eventual CI pass.

## Reproducible evidence bundle

Use the evidence collector on the exact commit and Windows 11 device being tested:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\collect-windows-qa-evidence.ps1 `
  -PortablePaths .\tonymux-0.1.0-windows-portable-x64.zip `
  -InstallerPaths .\TonyMux_0.1.0_x64_en-US.msi, .\TonyMux_0.1.0_x64-setup.exe `
  -IncludeTerminalAutomation `
  -IncludeEventAutomation
```

The command writes a timestamped directory and ZIP under `artifacts\windows-qa`. It records:

- exact Git commit/tree and dirty-state count;
- privacy-bounded Windows, PowerShell, Git/GitHub CLI and WebView2 versions;
- SHA-256 hashes for supplied portable/installer packages and available release binaries;
- pass/fail/skipped results and complete logs for each requested automated step;
- before/after TonyMux/shell process and listening-port snapshots;
- a machine-readable manifest, checksums and a separate unchecked manual checklist.

Useful modes:

```powershell
# Reuse existing release binaries and skip the compile/test gate
powershell -ExecutionPolicy Bypass -File .\scripts\collect-windows-qa-evidence.ps1 -SkipBuild

# Run only the compile/test gate; do not launch desktop automation
powershell -ExecutionPolicy Bypass -File .\scripts\collect-windows-qa-evidence.ps1 -SkipAutomationSmoke
```

The collector completes the bundle even when a requested automated step fails, then exits non-zero. It scans generated text for common GitHub token and Authorization patterns before declaring the bundle safe to upload. It intentionally does not collect environment variables, arbitrary process command lines, terminal history or credentials.

The generated `manual-checklist.md` remains unchecked. MSI/NSIS install/uninstall, SmartScreen, Vietnamese IME, clipboard, DPI/display, native WebView2 focus/compositor behavior and visual orphan-process review still require a tester.

The ConPTY suite verifies:

- PowerShell process spawn
- PTY input/output round trip
- Terminal resize API
- Clean shell exit
- Explicit child kill and termination
- PowerShell 7 round trip when `pwsh.exe` is installed

## Portable quick-test build

For routine QA, use the exact-head portable artifact first:

```powershell
Expand-Archive .\tonymux-0.1.0-windows-portable-x64.zip .\tonymux-portable
Set-Location .\tonymux-portable
Get-Content .\SHA256SUMS.txt
.\TonyMux.exe
```

The archive requires no installation and does not register uninstall entries, file associations, startup tasks or machine-wide components. It intentionally shares the normal TonyMux Windows-profile settings/workspace data and `%LOCALAPPDATA%\cmux-windows` automation discovery path with installed builds. Close all TonyMux instances before switching package types; use a backed-up clean Windows profile when isolated-state evidence is required.

The system Microsoft Edge WebView2 Runtime remains required. Record missing-runtime behavior as a defect rather than silently installing dependencies during QA.

## Interactive smoke checklist

### Portable, installation and launch

- [ ] Portable ZIP extracts and launches `TonyMux.exe` without installation
- [ ] Portable ZIP works from a writable path containing spaces and Unicode characters
- [ ] Moving the extracted portable directory does not break launch
- [ ] `SHA256SUMS.txt` verifies every shipped portable file
- [ ] Deleting the extracted directory removes the portable binaries without creating an uninstall entry
- [ ] Shared Windows-profile data behavior matches `README-PORTABLE.txt`

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
- Portable launch plus MSI and NSIS installation results are recorded.
- No orphan-process defect remains open.
- Browser, metadata and automation evidence is attached to their tracking issues.
- QA evidence is posted to issue #2 before PR #1 is merged.
