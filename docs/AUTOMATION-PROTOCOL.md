# Local automation protocol v1

## Purpose

`cmux-cli` and local AI tools communicate with the running desktop app through a Windows named pipe. Protocol v1 exposes health, identity, workspace lifecycle and pane lifecycle methods through explicit schemas. Terminal input/output remains a later, separately reviewed slice.

## Security boundary

- The pipe DACL grants access only to the SID of the Windows user that started cmux.
- Remote pipe clients are rejected.
- The pipe name is user-specific and protocol-versioned.
- Every request must include the random token stored in `%LOCALAPPDATA%\cmux-windows\automation-v1.json`.
- The first server instance flag prevents a second process from impersonating the cmux endpoint while the real app is running.
- Requests and responses are bounded to 64 KiB. Oversized responses are replaced with `RESPONSE_TOO_LARGE`.
- Idle clients are disconnected after 30 seconds.
- A connection is limited to 128 requests.
- The Rust/UI bridge is limited to 64 requests awaiting acknowledgement.
- Protocol methods are allowlisted. There is no generic shell execution method.

The token is defense in depth and accidental-client protection. The current-user DACL is the primary local authorization boundary.

## Transport

Pipe name format:

```text
\\.\pipe\cmux-windows-v1-<current-user-sid>
```

Messages are UTF-8 JSON objects separated by a newline. A connection may send multiple sequential requests within the connection limits.

## Request

```json
{
  "version": 1,
  "id": "client-generated-id",
  "token": "64-character-hex-token",
  "method": "workspace.create",
  "params": {
    "title": "Agent work",
    "cwd": "C:\\code\\project",
    "activate": true
  }
}
```

Required fields:

- `version`: currently `1`
- `id`: non-empty correlation ID, maximum 128 characters
- `token`: exact token from the local automation config
- `method`: allowlisted method name
- `params`: JSON object; defaults to `{}`

Unknown fields in mutation method params are rejected.

## Response

Success:

```json
{
  "version": 1,
  "id": "client-generated-id",
  "ok": true,
  "result": {
    "workspaceId": "generated-id",
    "paneId": "generated-id",
    "active": true
  }
}
```

Failure:

```json
{
  "version": 1,
  "id": "client-generated-id",
  "ok": false,
  "error": {
    "code": "WORKSPACE_NOT_FOUND",
    "message": "workspace not found: generated-id"
  }
}
```

## Read-only methods

### `ping`

Params: `{}`

Returns protocol liveness.

### `app.info`

Params: `{}`

Returns the app version, protocol version and desktop process ID.

### `workspace.list`

Params: `{}`

Returns the active workspace ID and a serializable snapshot of workspaces and panes. Runtime-only PTY handles, browser handles and attention payloads are not exposed. If the snapshot cannot fit in one 64 KiB frame, the server returns `RESPONSE_TOO_LARGE` instead of a partial list.

## Workspace methods

### `workspace.create`

```json
{
  "title": "Agent work",
  "cwd": "C:\\code\\project",
  "activate": true
}
```

- `title`: required, 1–120 printable characters
- `cwd`: optional, maximum 2,048 characters and no control characters
- `activate`: optional, defaults to `true`

A new workspace starts with one terminal pane.

### `workspace.select`

```json
{ "workspaceId": "workspace-id" }
```

Selects the workspace and clears its unread marker.

### `workspace.close`

```json
{ "workspaceId": "workspace-id" }
```

Closes the workspace. The final workspace is protected and returns `LAST_WORKSPACE_PROTECTED` rather than silently creating a replacement.

## Pane methods

### `pane.createTerminal`

```json
{ "workspaceId": "workspace-id" }
```

Creates one terminal pane in the target workspace.

### `pane.createBrowser`

```json
{
  "workspaceId": "workspace-id",
  "url": "https://example.com/"
}
```

`url` is optional and defaults to GitHub. Only HTTP and HTTPS URLs are accepted. URLs are limited to 4,096 characters, must not contain control characters and must not embed a username or password.

### `pane.close`

```json
{
  "workspaceId": "workspace-id",
  "paneId": "pane-id"
}
```

Closes one pane. The final pane in a workspace is protected and returns `LAST_PANE_PROTECTED`.

## Browser methods (browser.eval gate)

Browser panes are native WebView2 child webviews owned by Rust. These methods steer
an existing pane and are bound to the **trusted-origin gate** described in
`BROWSER-SECURITY.md`:

- `browser.navigate` — navigate the pane to a validated HTTP(S) URL.
- `browser.reload` / `browser.goBack` / `browser.goForward` — navigation controls.
- `browser.close` — close the pane.
- `browser.eval` — **gated**: executes a bounded JavaScript expression in the pane
  only when the pane's current committed origin is a loopback address
  (`localhost`, `127.0.0.1`, `::1`) or an explicitly trusted remote origin.
  A pane with no committed URL yet is refused (`BROWSER_NOT_READY`).

### `browser.navigate`

```json
{
  "paneId": "pane-id",
  "url": "https://example.com/"
}
```

`url` is optional and defaults to GitHub. Only HTTP and HTTPS URLs are accepted;
URLs are limited to 4,096 characters, must not contain control characters and
must not embed a username or password.

### `browser.eval`

```json
{
  "paneId": "pane-id",
  "expression": "document.querySelector('h1').textContent"
}
```

- `expression`: required, 1 to 4,096 UTF-8 bytes, no NUL bytes.
- The expression runs in the page context. The result is intentionally
  fire-and-forget: no value is returned to the caller. This matches the browser
  pane's advisory, non-privileged role.
- Gate failure returns `ORIGIN_NOT_TRUSTED`; a pane that never committed a URL
  returns `BROWSER_NOT_READY`; an unparseable recorded URL is refused.

Trusted remote origins are managed in Settings → Trusted browser origins
(backed by the `trust_browser_origin` / `revoke_browser_origin` /
`get_trusted_browser_origins` / `clear_trusted_browser_origins` commands). The
allowlist is empty by default and the feature is fail-closed: no trust entries,
no remote eval.

## Rust/UI bridge

Workspace state remains owned by React. Rust validates and canonicalizes method params, emits an event only to the local `main` webview and waits for a matching UI acknowledgement.

- UI readiness is registered only after the listener is mounted.
- Each mounted listener receives a unique readiness session ID.
- Stale StrictMode or reload cleanup cannot disable a newer listener session.
- Readiness transitions are serialized so `ready=false` cannot overtake `ready=true` for the same session.
- Requests fail with `UI_NOT_READY` before mount or during reload.
- A bridge request times out after five seconds.
- No more than 64 bridge requests may wait for UI acknowledgement; additional requests return `BRIDGE_BUSY`.
- Replacing or unmounting the UI drains pending requests instead of leaving clients blocked.
- Late or duplicate UI responses are ignored.

## CLI mapping

```powershell
cmux-cli ping
cmux-cli info
cmux-cli workspace list
cmux-cli workspace create "Agent work" --cwd C:\code\project
cmux-cli workspace create "Background" --no-activate
cmux-cli workspace select <workspace-id>
cmux-cli workspace close <workspace-id>
cmux-cli pane terminal <workspace-id>
cmux-cli pane browser <workspace-id> https://example.com
cmux-cli pane close <workspace-id> <pane-id>
```

The CLI does not provide a raw-method escape hatch.

## Error codes

- `INVALID_JSON`
- `INVALID_REQUEST`
- `UNSUPPORTED_VERSION`
- `UNAUTHORIZED`
- `METHOD_NOT_FOUND`
- `REQUEST_TOO_LARGE`
- `RESPONSE_TOO_LARGE`
- `WORKSPACE_NOT_FOUND`
- `PANE_NOT_FOUND`
- `LAST_WORKSPACE_PROTECTED`
- `LAST_PANE_PROTECTED`
- `UI_NOT_READY`
- `UI_TIMEOUT`
- `BRIDGE_BUSY`
- `UI_ERROR`
- `BROWSER_PANE_NOT_FOUND`
- `BROWSER_NOT_READY`
- `ORIGIN_NOT_TRUSTED`
- `INVALID_EXPRESSION`
- `BROWSER_EVAL_FAILED`
- `BROWSER_IO_ERROR`
- `INTERNAL_ERROR`

## Deferred methods

The following require a separate security and backpressure review:

- push subscriptions over a persistent client connection
- terminal lifecycle events
- browser eval **value returns** (currently fire-and-forget; returning DOM
  snapshots or expression values needs a dedicated result channel and review)

No future method may accept an arbitrary backend command or unrestricted shell execution payload.