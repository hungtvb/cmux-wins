# Browser Pane Security Model

Browser panes load untrusted remote content in native WebView2 child webviews. They must never be treated as trusted application UI.

## Trust boundary

- The React application is bundled local content and owns the workspace controls.
- Browser panes are remote content and may contain hostile JavaScript.
- The Rust backend owns browser creation, navigation, visibility, bounds and destruction.
- Browser pages do not receive a remote Tauri capability.

Tauri 2 resolves IPC access using the webview label and origin. Remote origins cannot reach custom commands unless an explicit `remote` capability is configured. This project intentionally defines no remote capability for browser panes.

## Navigation policy

The initial implementation accepts only:

- `http://`
- `https://`

The backend validates every URL before initial creation and programmatic navigation. The WebView navigation callback also rejects every other scheme.

Blocked schemes include, but are not limited to:

- `file:`
- `javascript:`
- `data:`
- `tauri:`
- custom application protocols

## Capability invariant

Do not add a wildcard or browser-label remote capability to `src-tauri/capabilities`.

Any future remote capability must:

1. Name exact trusted origins rather than wildcards.
2. Name exact browser webview labels or a deliberately narrow pattern.
3. Grant the minimum command set.
4. Receive a dedicated security review and tests.
5. Never grant terminal input, process lifecycle or local filesystem commands to arbitrary websites.

## Downloads and new windows

Downloads, popups, external protocols and permission prompts are not accepted implicitly. They remain disabled or unsupported until an explicit policy is implemented and tested.

## Runtime validation

Windows QA for browser panes must cover:

- HTTP/HTTPS navigation
- blocked non-web schemes
- no access to Tauri custom commands from remote DevTools
- popup behavior
- download behavior
- focus transfer between terminal, address bar and WebView2
- correct hiding of browser surfaces in inactive workspaces
- child WebView cleanup after pane, workspace and app close
