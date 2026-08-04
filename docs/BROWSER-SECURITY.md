# Browser Pane Security Model

Browser panes load untrusted remote content in native WebView2 child webviews. They must never be treated as trusted application UI.

## Trust boundary

- The React application is bundled local content and owns workspace controls, persistence and visible browser status.
- Browser panes are remote content and may contain hostile JavaScript.
- The Rust backend owns child-webview creation, navigation policy, visibility, bounds and destruction.
- Browser pages receive no remote Tauri capability.

Tauri 2 resolves IPC access using the webview label and origin. Remote origins cannot reach custom commands unless an explicit `remote` capability is configured. TonyMux intentionally defines no remote capability for browser panes.

## Navigation policy

TonyMux permits only bounded, credential-free `http://` and `https://` URLs inside browser panes.

Rust validates the initial URL and every programmatic navigation. The child WebView navigation callback independently applies the same policy to in-page navigation and redirects. The address-bar parser also rejects unsupported schemes before invoking Rust, but frontend validation is not a security boundary.

Blocked inputs include:

- `file:`, `javascript:`, `data:`, `tauri:` and custom application protocols;
- URLs containing a username or password;
- URLs longer than 2,048 bytes at the Rust boundary;
- malformed URLs.

A blocked navigation remains in the current pane and produces a bounded visible notice in the React toolbar.

## Lifecycle synchronization

The Rust child-webview host emits a bounded `browser-pane-event` stream only to the trusted `main` webview:

- `load-started` and `load-finished` synchronize the committed HTTP(S) URL and loading state;
- `title-changed` synchronizes the pane title;
- `navigation-blocked`, `new-window-blocked` and `download-blocked` provide policy feedback.

React rejects malformed event payloads, unsafe URLs, unknown kinds and unbounded text before changing workspace state. The event stream is advisory UI state; failure to deliver an event never relaxes the Rust navigation policy or keeps a child webview alive.

Loading that does not finish within 30 seconds becomes a retryable toolbar error. This timeout detects a missing completion event or stalled navigation; it does not claim to classify HTTP response status codes.

## Popups, downloads and external protocols

The current policy is deliberately fail-closed:

- all new-window and popup requests are denied;
- all WebView2 download requests are denied before a destination is selected or a file is written;
- external protocols and every non-HTTP(S) navigation are denied;
- blocked operations show a non-destructive notice in the trusted toolbar.

TonyMux does not silently open the system browser, invoke protocol handlers or write downloaded files. A future opt-in external-open or download feature requires a separate allowlisted Rust command, explicit user action, destination/protocol validation and dedicated tests.

## Capability invariant

Do not add a wildcard or browser-label remote capability to `src-tauri/capabilities`.

Any future remote capability must:

1. Name exact trusted origins rather than wildcards.
2. Name exact browser webview labels or a deliberately narrow pattern.
3. Grant the minimum command set.
4. Receive a dedicated security review and tests.
5. Never grant terminal input, process lifecycle, local automation or filesystem commands to arbitrary websites.

## Runtime validation

Windows QA for browser panes must cover:

- HTTP/HTTPS navigation and redirect URL synchronization;
- document-title synchronization;
- visible loading, timeout and retry behavior;
- blocked non-web schemes and credential-bearing URLs;
- denied popup/new-window requests;
- denied downloads with no created file;
- no access to Tauri custom commands from remote DevTools;
- focus transfer between terminal, address bar and WebView2;
- correct hiding of browser surfaces in inactive workspaces;
- child WebView cleanup after pane, workspace and app close.
