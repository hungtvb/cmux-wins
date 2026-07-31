# Terminal automation

This slice extends local automation protocol v1 with bounded terminal input, output and command completion.

## Security model

- Named-pipe authorization remains current-Windows-user DACL plus the random local token.
- `terminal.write` targets an already running cmux terminal session. It does not spawn a hidden backend shell.
- There is no raw backend-method or arbitrary process-execution endpoint.
- `cmux-cli terminal run` is a client-side composite command. It writes an encoded nested PowerShell command through the target PTY and observes bounded terminal output until a random completion marker appears.
- Terminal transcript data is retained in memory only. It is not written to localStorage or disk.

Terminal access is powerful: a caller authorized to the local automation pipe can type into the user's existing terminal. The current-user pipe boundary is therefore mandatory.

## Transcript limits

Each terminal session keeps a ring buffer with these limits:

- 256 KiB total transcript per session
- UTF-8 chunks of at most 4 KiB
- maximum 128 retained terminal records; running records are never evicted
- read payload from 1 KiB to 8 KiB
- long-poll wait from 0 to 30 seconds

Output chunks receive monotonically increasing `seq` values. Restarting a session ID creates a new generation so a stale reader thread cannot append to the replacement session.

## `terminal.write`

Request:

```json
{
  "version": 1,
  "id": "request-id",
  "token": "token",
  "method": "terminal.write",
  "params": {
    "sessionId": "pane-id",
    "data": "Get-Date\r"
  }
}
```

Rules:

- `sessionId` uses the safe identifier character allowlist.
- `data` must contain 1 to 16,384 UTF-8 bytes.
- Control input such as Ctrl+C is allowed.
- NUL bytes are rejected.

Response:

```json
{
  "version": 1,
  "id": "request-id",
  "ok": true,
  "result": {
    "sessionId": "pane-id",
    "bytesWritten": 9
  }
}
```

## `terminal.read`

Request:

```json
{
  "version": 1,
  "id": "request-id",
  "token": "token",
  "method": "terminal.read",
  "params": {
    "sessionId": "pane-id",
    "afterSeq": 42,
    "maxBytes": 8192,
    "waitMs": 30000
  }
}
```

Response:

```json
{
  "version": 1,
  "id": "request-id",
  "ok": true,
  "result": {
    "sessionId": "pane-id",
    "workspaceId": "workspace-id",
    "chunks": [
      {
        "seq": 43,
        "data": "command output\r\n"
      }
    ],
    "nextSeq": 43,
    "earliestSeq": 10,
    "latestSeq": 43,
    "dropped": false,
    "hasMore": false,
    "status": "running"
  }
}
```

Lifecycle status is one of:

- `running`
- `exited`, with `exitCode` when available
- `closed`
- `error`, with an error message

`dropped: true` means `afterSeq` is older than the retained ring-buffer window. A client must not silently treat the resulting output as complete.

The long-poll implementation registers its Tokio `Notified` future before reading the current snapshot, preventing a wakeup from being lost between the state check and await.

## CLI

Write input:

```powershell
cmux-cli terminal write <session-id> "Get-Date" --enter
```

Read output:

```powershell
cmux-cli terminal read <session-id> --after 0 --max-bytes 8192 --wait-ms 30000
```

Run a PowerShell command and observe completion:

```powershell
cmux-cli terminal run <session-id> "Write-Output hello" --timeout 60
```

`terminal run` performs these steps:

1. Reads `latestSeq` before sending input.
2. Builds a nested `powershell.exe -EncodedCommand` invocation.
3. Writes random start/end markers that are not present in plain text in the echoed command line.
4. Long-polls output from the saved cursor.
5. Returns output and exit code when the end marker is observed.
6. Fails if output is dropped, the terminal exits, capture exceeds the local bound, or timeout is reached.

Example result:

```json
{
  "version": 1,
  "id": "cli-generated-id",
  "ok": true,
  "result": {
    "sessionId": "pane-id",
    "command": "Write-Output hello",
    "output": "hello",
    "exitCode": 0,
    "nextSeq": 51
  }
}
```

A completed command with a non-zero `exitCode` produces JSON with `ok: true`, but `cmux-cli` exits non-zero so scripts can use the process status.

## Error codes

New codes in this slice:

- `TERMINAL_NOT_FOUND`
- `TERMINAL_IO_ERROR`
- `TERMINAL_RUN_FAILED`
- `TERMINAL_RUN_TIMEOUT`
- `TERMINAL_OUTPUT_DROPPED`
- `TERMINAL_OUTPUT_TOO_LARGE`
- `TERMINAL_EXITED`
- `INVALID_COMMAND`
- `INVALID_RESPONSE`

## Deferred

- Push subscriptions over a persistent client connection
- Attention and workspace-change event subscriptions
- Multi-shell command wrappers beyond the nested Windows PowerShell runner
- Durable scrollback restoration
