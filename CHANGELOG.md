# Changelog

All notable changes to TonyMux are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and the project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0] - 2026-08-06

### Added
- **Agent-native notification panel** — a dockable panel that surfaces
  agent-generated attention notifications with workspace, pane and message
  context, jump/dismiss controls, an unread-count badge and an empty state.
- **Agent resume hooks** — resume records (agents, workspace, panes and
  working directory) are persisted to a JSONL store and surfaced through a
  resume menu. Tauri agent hooks (`agent_hooks.rs`) wire the supported agents
  into the app's resume flow. A Settings entry point exposes the integration
  under *Agent integrations*.
- **Browser eval automation (Phase 3)** — the automation protocol now drives
  existing browser panes (`browser.navigate`, `reload`, `goBack`, `goForward`,
  `close`) and executes bounded JavaScript (`browser.eval`) behind a
  **trusted-origin security gate**:
  - `browser.eval` runs only when a pane's committed origin is loopback
    (`localhost`, `127.0.0.1`, `::1`) or an origin explicitly trusted in the
    new *Trusted browser origins* settings section.
  - The trusted-origin allowlist is empty by default (fail-closed), bounded to
    64 origins / 128 KiB, and loopback is always evaluable without an entry.
  - Evals are bounded (4 KiB, NUL-free) and fire-and-forget; no value is
    returned to the caller, nothing is written to disk, and no new Tauri
    capability is granted.
- **SF-inspired adaptive design system** — a light/dark adaptive theme with
  the TonyMux lime accent, used across the notification panel, resume menu
  and browser/origin settings.

### Changed
- Version bumped to `0.3.0` across `package.json`,
  `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
- Installer jobs now run only when explicitly requested via
  `workflow_dispatch` (build_installers) to conserve Windows runner time;
  release artifacts are built by the tag-triggered release workflow.

### Fixed
- Non-null spread of `terminalSettings` when constructing a resume pane
  (TS2322).
- Silenced dead-code warnings in `resume.rs` (functions are retained as a
  Rust/TypeScript parity mirror and covered by tests).
- CI cross-check borrow-of-moved-value (`E0382`) in
  `browser_origins.rs` store tests.

### Security
- `browser.eval` is fail-closed: no trusted-origin entries means no remote
  evals; loopback stays evaluable. See `docs/BROWSER-SECURITY.md`.

## [0.2.0]

Initial public release. (Artifacts built by the tag-triggered release workflow;
see `docs/RELEASING.md` for the process.)