# TonyMux Agent Improvements — Implementation Plan

> **For Hermes:** Implement task-by-task; each phase lands as its own PR on `main` with green CI (`check` + `cross-check`; `installer` only via workflow_dispatch — see RELEASING.md).

**Goal:** Đưa TonyMux từ "terminal có notifications" lên ngang tầm cmux ở 3 mảng agent: notification panel, agent resume hooks, browser agent API.

**Architecture:** Cả 3 phase đều dựa trên hạ tầng đã có — attention state (OSC 9/99/777 → React), event journal (`attention.requested/cleared` đã publish), named-pipe protocol v1 + `cmux-cli`, Rust allowlist trust model. Không thêm backend mới.

**Tech Stack:** React 18 + TypeScript + Vite, Tauri 2 (Rust), xterm.js, WebView2 (`execute_script`), named-pipe (windows-ipc).

**Context / Giả định:**
- `docs/AUTOMATION-PROTOCOL.md` §Deferred methods đã liệt kê: `terminal.write`, bounded output subscriptions, browser script execution / DOM automation — **chưa được phép**; Phase 3 phải gỡ qua security review chủ động.
- Attention state hiện tại: `TerminalPane.tsx` (chip "Needs input", `terminal-pane--attention`), workspace unread indicator ở sidebar, journal `attention.requested/cleared` (đã có, cùng nguồn React state — không parse lại OSC).
- CLI hiện tại: `cmux-cli` (workspace/pane/event). CLIs build ở `src-tauri/src/bin/` (Windows-only, được build trong CI job `check`).
- Settings: `src/settings.ts` + `SettingsDialog.tsx` + `settings.test.ts` (79 vitest hiện tại). Rust allowlist: `src-tauri/src/settings.rs`-tương đương (shell profiles).
- Version hiện tại 0.2.0; bump 0.3.0 ở phase cuối (tránh nhiều lần bump).

---

## Phase 1 — Notification panel (frontend, ~1 PR, nhỏ)

**Objective:** Panel tập trung các attention events: list đang có + đã đọc, jump-to-pane, mark read/unread, badge unread trên nút — thay thế chỉ-indicator rải rác.

**Files:**
- Create: `src/components/NotificationPanel.tsx`, `src/notification-panel.css`, `src/components/__tests__/NotificationPanel.test.tsx`
- Modify: `src/components/WorkspaceTopbar.tsx` (nút chuông + badge), `src/App.tsx` hoặc nơi giữ attention state tổng, `src/command-palette.ts`-tương đương (command "Show notifications"), `src/styles.css` (tokens mới nếu cần — dùng `--tm-info`/`--tm-brand` sẵn có)
- Docs: `docs/DESIGN-SYSTEM.md` (Component rules → NotificationPanel), `docs/AUTOMATION-EVENTS.md` (ghi chú panel dùng cùng nguồn state)

**Tasks:**
1. **T1 — Attention registry hook**: `useAttentionRegistry()` — module `src/hooks/useAttentionRegistry.ts` duy nhất quản lý `Map<paneId, {title, at, read}>`; phụ thuộc từ attention state của pane; test thuần (add/clear/mark-read/order mới nhất trước).
2. **T2 — NotificationPanel component**: list + empty state + nút "Mark all read" + `Escape` đóng; row click → `workspace.select` + focus pane (dùng event `pane.focus`-tương đương hoặc invoke sẵn có); a11y: `role="dialog"`, focus trap tối thiểu.
3. **T3 — Topbar button + badge**: nút chuông (lucide `Bell`), badge đếm unread (`--tm-danger` khi ≥1? dùng `--tm-brand` theo design system — chọn: brand cho unread, danger không dùng cho đếm), toggle panel; shortcut gợi ý `Ctrl+Shift+U` (kiểm tra collision trong editable-shortcuts — nếu trống thì thêm default; nếu policy chưa cho default mới → chỉ nút).
4. **T4 — Test + docs**: vitest cho registry + component (79 → ~85); cập nhật 2 docs; commit mỗi task.

**Verify:** `npm run build` + `npx vitest run` xanh; manual: spawn 2 pane, gõ `\x1b]99;Agent needs input\x07` (hoặc OSC 9) → badge + panel hiện đúng, click jump đúng pane, mark-read xoá badge.

**Rủi ro:** attention state hiện nằm rải (mỗi pane tự quản) → registry phải là nguồn chân lý duy nhất; đảm bảo không double-render (StrictMode).

---

## Phase 2 — Agent resume hooks (Rust + CLI + hooks, ~1 PR, lớn)

**Objective:** `cmux-cli surface resume set/show/clear` + `cmux-cli hooks setup [codex|opencode|claude]` — lưu checkpoint command theo surface, tự restore khi surface mở lại, có approve-prefix cho auto-restore (mô hình cmux, thu gọn: chỉ 3 agent CLIs phổ biến).

**Files:**
- Modify: `src-tauri/src/` — nơi quản lý surface/session (`session.rs`-tương đương), protocol dispatcher (`protocol.rs`-tương đương), thêm methods `surface.resume.set/show/clear` (đọc/ghi binding theo surface id)
- Modify: `src-tauri/src/bin/cmux-cli-*.rs` (2 CLIs) — thêm `resume` + `hooks` subcommands
- Create: `src-tauri/src/resume.rs` (binding store: per-surface, JSON ở app-data dir, allowlist prefix approve), `hooks/` scripts (POSIX `.sh` + Windows `.cmd` cho từng agent: `claude`, `codex`, `opencode` — gọi `cmux-cli surface resume set --kind <agent> --checkpoint <file> --shell "<cmd>"`)
- Docs: `docs/AUTOMATION-PROTOCOL.md` (§methods mới + §Deferred update), `docs/TERMINAL-AUTOMATION.md`, `docs/SETTINGS.md` (trusted resume prefixes)
- Security: binding chứa command string — **không thực thi tự động trừ khi prefix được approve** (ghi vào trust store Rust-owned như executable trust hiện tại)

**Tasks:**
1. **T1 — Resume binding store** (`resume.rs`): CRUD binding theo `(workspaceId, paneId)`; persist JSON; tests Rust (`cargo test` trên `src-tauri`).
2. **T2 — Protocol methods**: `surface.resume.set/show/clear` theo đúng format protocol v1 (validation, error codes mới: `RESUME_BINDING_NOT_FOUND`); test + docs protocol.
3. **T3 — Restore hook**: khi pane terminal được spawn với `resumeBinding` → nếu prefix approved: tự chạy `shell` command; nếu không: hiện chip "Resume available" + command trong command palette. Điểm nối: `useTerminalSession.ts` hoặc Rust spawn path (PTY backend — `terminal.rs`).
4. **T4 — CLI subcommands**: `cmux-cli surface resume set/show/clear`, `cmux-cli hooks setup [agent]` (tìm agent binary trên PATH, viết hook file vào `~/.claude/hooks` / `~/.codex/hooks` / `~/.opencode/hooks` tương ứng, in summary agent nào skipped — mô hình cmux).
5. **T5 — Hook scripts**: cho mỗi agent: script gọi `cmux-cli surface resume set` với checkpoint path từ env của agent (VD `CLAUDE_CODE_CURRENT_CHECKPOINT`-tương đương — cần tra docs agent theo version; fallback: cảnh báo nếu env không tồn tại). Windows `.cmd` + POSIX `.sh`.
6. **T6 — Trust approve UX**: Settings → Trusted executables mở rộng hoặc mục mới "Resume command prefixes"; approve/revoke; tương tác với Rust trust store hiện có.
7. **T7 — Docs + tests + commit**.

**Verify:** `cargo test` + `npm run build` + vitest; `cmux-cli surface resume set ...` → `show` → `clear` round-trip; spawn terminal có binding → shell command chạy (prefix approved) hoặc chip hiện (chưa approve); CI `check` job build 2 CLIs phải pass.

**Rủi ro:** env hook của từng agent thay đổi theo version (Claude Code dùng `Checkpoint` events; Codex/OpenCode khác nhau) — plan mỗi agent 1 script riêng, test trên Windows thật (chờ user QA); không auto-approve bất kỳ prefix nào.

---

## Phase 3 — Browser agent API (staged: design + security review trước, implementation sau)

**Objective:** Port thu gọn agent-browser API: `browser.snapshot` (DOM outline), `browser.click(selector)`, `browser.fill(selector, value)`, `browser.eval(js)` — qua WebView2 `execute_script`, gated bởi security review + allowlist.

**Files:**
- Modify: `src-tauri/src/browser.rs` (execute_script bridge đã có? — kiểm tra `browser.rs` hiện tại; thêm methods), protocol dispatcher (`browser.*` methods)
- Modify: `src/components/BrowserPane.tsx` (nhận command từ Rust bridge, thực thi `executeJavaScript` — WebView2 IPC `browser:eval`), `src/browser-pane.css` (highlight element được snapshot)
- Docs: `docs/BROWSER-SECURITY.md` (bắt buộc — mở rộng trust model), `docs/AUTOMATION-PROTOCOL.md` (§Deferred: gỡ browser script execution sau review)
- Security review: threat model — remote content WebView2 (không tin cậy!) vs `execute_script` từ automation client (local, current-user pipe, đã có token) — **chỉ cho phép khi pane trust = trusted** (trust state đã có trong Settings/BrowserPane theo BROWSER-SECURITY.md)

**Tasks:**
1. **T1 — Security review + thiết kế**: viết `docs/BROWSER-SECURITY.md` bổ sung: điều kiện cho phép eval (pane trusted, không phải remote untrusted), sandbox notes (WebView2 không phải sandbox — eval trong trang untrusted = nguy hiểm; quyết định: chỉ cho phép trên localhost/trusted origins), bounds (payload 8 KiB, rate limit). **Gate: chưa qua review thì không code.**
2. **T2 — `browser.snapshot`**: DOM outline (title, url, headings, buttons/links/inputs có selector ổn định như cmux `agent-browser` element refs); Rust route qua UI bridge → BrowserPane `executeJavaScript` → trả JSON.
3. **T3 — `browser.click` / `browser.fill`**: thực thi qua `executeJavaScript` với selector cho phép (không regex, không eval tự do từ client chưa approve).
4. **T4 — `browser.eval` (restricted)**: chỉ khi trust = trusted + prefix approve; log mọi eval vào journal (`browser.eval` event kind mới).
5. **T5 — CLI + docs + tests**: `cmux-cli browser snapshot/click/fill/eval`; cập nhật protocol docs; vitest cho frontend bridge; cargo test cho validation.

**Verify:** unit tests; manual trên Windows (chờ user): mở `localhost` dev server + pane trusted → snapshot/click/fill chạy; untrusted remote → từ chối với lỗi rõ.

**Rủi ro:** cao nhất trong 3 phase — eval trên WebView2 remote content. Nếu review kết luận không an toàn với kiến trúc hiện tại → scope xuống chỉ `snapshot` (không click/fill/eval) hoặc chỉ cho phép trên `localhost`/trusted origins. Đây là quyết định đúng đắn để dừng — không vì "đuổi kịp cmux" mà mở lỗ hổng.

---

## Sequencing & Release

1. Phase 1 → PR → CI xanh → merge (quick win, không đụng Rust).
2. Phase 2 → PR → CI xanh (Rust tests + CLI build) → merge.
3. Phase 3 → **security review là gate**; review xong mới bắt đầu T2.
4. Cuối cùng: bump `0.2.0 → 0.3.0` (3 file đồng bộ: `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`) → tag `v0.3.0` → release workflow (đã verify: installer gated qua workflow_dispatch trước, rồi tag).
5. Đóng issues/ghi chú roadmap #12 (nếu còn mở — đã đóng; tạo issue mới cho 3 phase nếu cần theo dõi).

## Positioning & Distribution (đã chốt — từ phân tích win-strategy)

- **Định vị**: "Agent-native workspace cho Windows" — KHÔNG phải "terminal multiplexer". Mọi feature/communication xoay quanh: AI coding agents (Codex/Claude Code/OpenCode) làm việc trên Windows cần workspace model + attention + browser-in-split + automation API — thứ Windows Terminal không có và cmux không thể có (macOS-only).
- **Moat**: (1) first-mover agent-native trên Windows, (2) engineering trust (CI gated, tests, signing, SBOM) — đối nghịch trực tiếp với 4.041 issues mở của cmux, (3) kiến trúc mở (Tauri + web stack) dễ customize.
- **Distribution**: sau v0.3.0 → 1 bài giới thiệu "cmux for Windows" (HN/Reddit) đúng góc: dev Windows thiếu agent-native workspace.
- **Không đuổi theo feature parity cmux** — chỉ lấy 3 trụ (panel, hooks, browser API) đủ để giữ lời hứa định vị.

## Open questions (đã chốt mặc định)

1. Shortcut Notification panel: **`Ctrl+Shift+U`** (mới, không trùng) — verify collision với editable-shortcuts khi implement; nếu có conflict → chỉ nút.
2. Phase 2 approve: **per-prefix** (revoke được) — không auto-approve gì.
3. Phase 3 origin: **localhost + trusted origins từ v1** — remote untrusted luôn từ chối.
4. Release: **Phase 1+2 → v0.3.0**; Phase 3 tách **v0.4.0** (nếu security review trễ).
