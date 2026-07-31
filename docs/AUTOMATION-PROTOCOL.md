# Local automation protocol v1

## Purpose

`cmux-cli` and local AI tools communicate with the running desktop app through a Windows named pipe. The first slice intentionally exposes only read-only health and identity methods. Workspace and terminal mutation commands will be added only after the transport and authorization boundary are proven.

## Security boundary

- The pipe DACL grants access only to the SID of the Windows user that started cmux.
- Remote pipe clients are rejected.
- The pipe name is user-specific and protocol-versioned.
- Every request must include the random token stored in `%LOCALAPPDATA%\cmux-windows\automation-v1.json`.
- The first server instance flag prevents a second process from impersonating the cmux endpoint while the real app is running.
- Requests are bounded to 64 KiB and malformed input closes the connection after a structured error.
- Protocol methods are allowlisted. There is no generic shell execution method.

The token is defense in depth and accidental-client protection. The current-user DACL is the primary local authorization boundary.

## Transport

Pipe name format:

```text
\\.\pipe\cmux-windows-v1-<current-user-sid>
```

Messages are UTF-8 JSON objects separated by a newline. A connection may send multiple sequential requests.

## Request

```json
{
  "version": 1,
  "id": "client-generated-id",
  "token": "64-character-hex-token",
  "method": "ping",
  "params": {}
}
```

Required fields:

- `version`: currently `1`
- `id`: non-empty correlation ID, maximum 128 characters
- `token`: exact token from the local automation config
- `method`: allowlisted method name
- `params`: JSON object; defaults to `{}`

## Response

Success:

```json
{
  "version": 1,
  "id": "client-generated-id",
  "ok": true,
  "result": {
    "pong": true
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
    "code": "METHOD_NOT_FOUND",
    "message": "unsupported automation method"
  }
}
```

## Methods in slice 1

### `ping`

Returns protocol liveness.

### `app.info`

Returns the app version, protocol version and desktop process ID.

## Error codes

- `INVALID_JSON`
- `INVALID_REQUEST`
- `UNSUPPORTED_VERSION`
- `UNAUTHORIZED`
- `METHOD_NOT_FOUND`
- `REQUEST_TOO_LARGE`
- `INTERNAL_ERROR`

## Planned slice 2

After the transport is validated on Windows 11:

- `workspace.list`
- `workspace.create`
- `workspace.select`
- `workspace.close`
- `pane.createTerminal`
- `pane.createBrowser`
- `terminal.write`
- bounded terminal output and lifecycle events

Mutation methods will use explicit schemas and will not accept arbitrary backend commands.