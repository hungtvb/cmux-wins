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
- `INTERNAL_ERROR`

## Deferred methods

The following require a separate security and backpressure review:

- `terminal.write`
- bounded terminal output subscriptions
- terminal lifecycle events
- browser script execution or DOM automation

No future method may accept an arbitrary backend command or unrestricted shell execution payload.