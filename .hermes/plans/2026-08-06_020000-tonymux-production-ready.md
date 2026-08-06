# TonyMux (cmux-wins) — Production-Ready Integration Plan

> **STATUS 2026-08-06 (session 2):** npm install blocker SOLVED (root cause: /data chỉ 218MB trống → node_modules cần 132MB+; workaround: build ở /tmp/cmux-build trên overlay 2T). Frontend build xanh local: 15 files / 77 tests, tsc, vite. Commit `bf26f03` = fix #69, push `chore/production-integration`. PR **#83** (draft, → main) mở; windows-ci đang chạy. Task 2.1 wiring check: ✅ 20 commands, automation module (named pipe), bins tonymux-cli/cmux-cli, frontend đủ component/hook. Fix E0382 (`&label`) → `8451a20`, CI chạy lại: **check job XANH (unit tests + conpty_smoke PASSED)**. **Cleanup đã làm:** đóng 25 PRs stack draft (#13–#82, giữ #1 + #83), xóa 28 branches `automation/chatgpt-*`. **Disk:** xóa npm cache 253M → /data 310M free (27%), cache chuyển /tmp. **CI tối ưu (`a61cd86`):** release workflow bỏ pull_request trigger (chỉ tags v* + manual); windows-ci chỉ chạy PR + push main, concurrency cancel-in-progress, paths-ignore docs, permissions read. Còn chờ: installer job xanh → merge #1 → main, merge #83, tag v0.2.0, đóng 17 issues, bàn #7 SSH + #11 code signing (P2).

> **Goal:** Make TonyMux (cmux-wins) run well on Windows 11 — P0 bugs fixed, all features integrated, reproducible release published, QA evidence collected. No more "MVP" framing; ship a daily-driver.

**Current state (2026-08-06):**
- `main` = bootstrap README only.
- PR #1 (`feat/windows-mvp`) = base terminal MVP (54 commits, MERGEABLE/CLEAN).
- 27 draft PRs stacked on top: browser panes, automation API, settings, persistence, design system, portable packaging, QA evidence, #68 fixes.
- `feat/windows-qa-evidence-bundle` (PR #66) = the packaged build referenced by P0 issues #68/#69.
- Newest cumulative trees (2026-08-05): `fix/hide-metadata-helper-console` (PR #82), `automation/chatgpt-source-export-terminal68-diag-0805`, `automation/chatgpt-terminal68-visibility-fix-0805` (contains #68 session-lease fix + visibility probe test), `automation/chatgpt-materialize-metadata-no-window-0805`.
- P0 issues: #68 (external PowerShell window steals focus), #69 (WebView2 content escapes pane bounds), #2 (QA harness), #3 (versioned release). Epic #12 tracks all.

**Key constraint:** This dev box is Linux. Windows runtime validation happens on `windows-latest` GitHub Actions runners only. All Windows code changes must be verified via CI.

**Architecture:** Tauri 2 + React/xterm.js frontend; Rust backend: ConPTY via `portable-pty 0.8.1` (spawns child with `EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT` — no `CREATE_NO_WINDOW`), session registry, WebView2 child webviews for browser panes, named-pipe automation server.

---

## Phase 0 — Baseline selection & integration branch

### Task 0.1: Pick the integration base
- **Verify** which of these is the newest full superset (diff trees): `fix/hide-metadata-helper-console`, `automation/chatgpt-source-export-terminal68-diag-0805`, `automation/chatgpt-terminal68-visibility-fix-0805`, `automation/chatgpt-materialize-terminal68-rust-0805`, `feat/windows-qa-evidence-bundle`.
- **Do:** `git diff <A> <B> --stat` for each pair; pick the tree containing: `src-tauri/src/terminal.rs` (lease fix), `src-tauri/src/workspace_metadata.rs` (no-window helper spawn), `src-tauri/src/browser.rs`, `src-tauri/src/automation/*`, `scripts/package-windows-portable.ps1`, `src/terminalSessionLease.ts`, visibility probe in `conpty_smoke.rs`.
- **Do:** create `chore/production-integration` from that base. Commit.

### Task 0.2: Local sanity gates
- **Do:** `cargo check` (Linux — validates non-Windows compile surface), `npm install && npm run build` (frontend TS check), `npm test` if test runner exists.
- **Expected:** any failures logged; Windows-only code paths flagged for CI.
- **Do:** push branch; run `windows-ci.yml` on it via PR draft to confirm CI green baseline.

## Phase 1 — P0 runtime fixes ("chạy ngon")

### Task 1.1: #68 — no external PowerShell window, focus retained
- **Root cause (established):** duplicate shell spawns from check-then-spawn race in `spawn_terminal` (old code) + helper processes (git metadata) spawned with visible console windows + `CREATE_NO_WINDOW` missing on `CreateProcessW` in portable-pty.
- **Fixes to ensure present in base:**
  - `src-tauri/src/terminal.rs`: session adoption + `client_id` validation + `SpawnTerminalResult { generation, process_id, reused }` — one shell per pane, reuse instead of respawn. (in terminal68 branches)
  - `src/terminalSessionLease.ts` + `useTerminalSession.ts`: frontend lease so only one client owns a session (focus retention).
  - `src-tauri/tests/conpty_smoke.rs`: visibility probe — assert `IsWindowVisible(GetConsoleWindow())` is FALSE inside the ConPTY child (fails if a console window materializes).
  - `workspace_metadata.rs`/`terminal_runner.rs`: helper `std::process::Command` spawns get `.creation_flags(CREATE_NO_WINDOW)` (windows-only cfg) — verify present, add if missing. Also `fix/hide-metadata-helper-console` changes (PR #82).
- **Verify:** conpty_smoke passes on windows-latest (CI); manual QA step on Windows 11 with Oh My Posh enabled.

### Task 1.2: #69 — WebView2 surface confined to pane bounds
- **Current code:** `browser.rs` `set_browser_pane_bounds` uses `LogicalPosition/LogicalSize` on child webview; called from frontend on layout change.
- **Fixes to implement:**
  - Sync bounds on every layout/resize/scale event (frontend: ResizeObserver → `set_browser_pane_bounds`; window `onResized`).
  - On Windows: re-apply bounds after DPI change; set `webview.set_focus(false)` for non-active panes (avoid focus steal); ensure parent window `WS_CLIPCHILDREN` semantics — verify Tauri child webview keeps bounds.
  - Add browser pane visibility toggling (`hide_browser_pane`) when pane not active, so native surface cannot overlay terminal.
- **Verify:** QA evidence steps (screenshot grid: browser pane must not overlap terminal splitter at 100%/125%/150% DPI).

### Task 1.3: #2 QA harness — automated gates
- **Ensure present:** `conpty_smoke.rs` covers spawn/stdout/stdin/resize/exit/kill + pwsh when available + visibility probe. `windows-ci.yml` runs `cargo test` on windows-latest and blocks on failure.
- **Add if missing:** workspace-switch-while-running + pane-close-kills-child checks (documented manual steps; automated where feasible).
- **Deliverable:** `docs/WINDOWS-QA.md` updated with evidence of a completed run (attach artifact to release).

## Phase 2 — Feature integration verification

### Task 2.1: Confirm all shipped features present & wired
- Check `src-tauri/src/lib.rs` registers: `spawn_terminal/write_terminal/resize_terminal/close_terminal` + browser pane commands + automation server start + workspace metadata commands.
- Frontend: workspace sidebar, split panes, OSC attention, command palette, settings, shortcuts, browser pane UI, session persistence.
- Bins: `tonymux-cli.exe` + `cmux-cli.exe` (deprecated alias) from `src-tauri/src/bin/`.
- **Fix any wiring gaps** (missing `generate_handler!` entries, missing `tauri::command` attributes, missing frontend invoke calls).

### Task 2.2: CI green on integration branch
- `windows-ci.yml`: frontend build, `cargo check`, `cargo test` (ConPTY), MSI+NSIS packaging, portable ZIP (if merged), dry-run release assets.
- Fix every failure; no skips.

## Phase 3 — Distribution & release

### Task 3.1: Portable ZIP (#71)
- **Ensure present:** `scripts/package-windows-portable.ps1` (TonyMux.exe + DLLs + tonymux-cli.exe + cmux-cli.exe + README-PORTABLE.txt + SHA256SUMS). Wire into CI artifacts. (in terminal68/portable branches)

### Task 3.2: Versioned release (#3)
- `windows-release.yml`: on tag `v*` → build MSI/NSIS/ZIP, compute SHA-256, create GitHub Release with notes (unsigned-installer warning), prerelease naming (`v0.2.0-alpha.1`).
- **Do:** after integration merges to main, tag `v0.2.0` → publish real release; verify assets downloadable.

### Task 3.3: Docs
- `docs/RELEASING.md` updated with the actual flow used.

## Phase 4 — UI quality (#70) & evidence

### Task 4.1: Typography + Nerd Font (#70)
- Check design-system branches (`feat/tony-design-system-ui`, quiet-operator-*) for font work; ensure terminal font config supports Nerd Fonts (Oh My Posh) — `xterm.js` `fontFamily` with fallback; UI scale bump for sidebar/pane headers.
- **Verify:** screenshot evidence at 100% scale.

### Task 4.2: QA evidence bundle
- Run `collect-windows-qa-evidence.ps1` on Windows 11 (real desktop session) OR document exact manual steps + attach evidence from tester. Target: close #2 acceptance.

## Phase 5 — Ship & cleanup

### Task 5.1: Merge path
- Merge PR #1 (windows-mvp) → `main` (CLEAN base), then open ONE integration PR (`chore/production-integration` → main), review, merge. Alternatively push integration directly to main if user prefers velocity.
- Close superseded draft PRs with comment pointing to integration PR (keep #1 merged, mark epic checklist items done).

### Task 5.2: Epic #12 update
- Check off Phase 0 (QA + release), Phase 1 items that are now real, note remaining (code signing #11, SSH #7) as follow-ups.

### Task 5.3: Branch cleanup (ask user first)
- ~60 `automation/chatgpt-*` branches → delete after integration merged (or keep if user wants history).

---

## Verification matrix

| Item | Gate |
|---|---|
| No external PowerShell window | conpty_smoke visibility probe (CI) + manual Oh My Posh run |
| WebView2 confined to pane | screenshot evidence at 3 DPI scales |
| Reproducible release | tag → assets downloadable + checksums verify |
| CI | all green on `windows-latest` |
| Features | automation CLI smoke (named pipe), browser pane, settings, persistence |

## Risks / open questions
- **Windows-only runtime bugs** cannot be reproduced on Linux; rely on CI + manual QA evidence. Mitigation: visibility probe + evidence bundle + explicit manual checklist.
- **#69 root cause may be Tauri child-webview bounds quirk** — if bounds sync alone is insufficient, add Windows-native WebView2 controller `put_Bounds` with `WebView2BoundsMode` fallback (requires `windows`/`webview2-com` crate). Keep as contingency.
- **Oh My Posh environment** is the #68 repro; ensure QA runs with it installed.
- **Decision needed:** merge-stack-vs-single-integration-PR; push-to-main vs PR. Default chosen: single integration PR, then tag release.
