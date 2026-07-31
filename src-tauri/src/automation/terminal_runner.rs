#![cfg(windows)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::time::Duration;
use tokio::time::{sleep, Instant};

use super::{
    cli_parser::TERMINAL_READ_BYTES,
    client::{call, request_id},
    protocol::{AutomationError, AutomationResponse},
};

const MAX_RUN_COMMAND_BYTES: usize = 3 * 1024;
const MAX_RUN_CAPTURE_BYTES: usize = 512 * 1024;
const TERMINAL_READY_TIMEOUT: Duration = Duration::from_secs(5);
const TERMINAL_READY_RETRY_DELAY: Duration = Duration::from_millis(100);

#[derive(Debug)]
struct CallFailure {
    code: String,
    message: String,
}

pub(crate) async fn run_terminal_command(
    session_id: &str,
    command: &str,
    run_timeout: Duration,
) -> AutomationResponse {
    let run_id = request_id();
    let marker = format!("__CMUX_RUN_{}__", run_id.replace('-', "_"));
    let deadline = Instant::now() + run_timeout;

    let initial = match wait_for_terminal_snapshot(session_id, deadline).await {
        Ok(result) => result,
        Err(error) => {
            return AutomationResponse::failure(run_id, error.code, error.message);
        }
    };
    if initial.get("status").and_then(Value::as_str) != Some("running") {
        return AutomationResponse::failure(
            run_id,
            "TERMINAL_EXITED",
            "terminal is not running",
        );
    }

    let mut cursor = match value_u64(&initial, "latestSeq") {
        Ok(value) => value,
        Err(error) => return AutomationResponse::failure(run_id, "INVALID_RESPONSE", error),
    };
    let input = match build_powershell_run_input(command, &marker) {
        Ok(input) => input,
        Err(error) => return AutomationResponse::failure(run_id, "INVALID_COMMAND", error),
    };

    if let Err(error) = call_result(
        "terminal.write",
        json!({ "sessionId": session_id, "data": input }),
    )
    .await
    {
        return AutomationResponse::failure(run_id, error.code, error.message);
    }

    let mut captured = String::new();
    let mut started = false;

    loop {
        let now = Instant::now();
        if now >= deadline {
            return AutomationResponse::failure(
                run_id,
                "TERMINAL_RUN_TIMEOUT",
                format!(
                    "terminal command did not complete within {} seconds",
                    run_timeout.as_secs()
                ),
            );
        }

        let remaining_ms = (deadline - now).as_millis().min(30_000) as u64;
        let result = match call_result(
            "terminal.read",
            json!({
                "sessionId": session_id,
                "afterSeq": cursor,
                "maxBytes": TERMINAL_READ_BYTES,
                "waitMs": remaining_ms,
            }),
        )
        .await
        {
            Ok(result) => result,
            Err(error) => {
                return AutomationResponse::failure(run_id, error.code, error.message);
            }
        };

        if result.get("dropped").and_then(Value::as_bool) == Some(true) {
            return AutomationResponse::failure(
                run_id,
                "TERMINAL_OUTPUT_DROPPED",
                "terminal output cursor fell behind the bounded transcript",
            );
        }

        let chunks = match result.get("chunks").and_then(Value::as_array) {
            Some(chunks) => chunks,
            None => {
                return AutomationResponse::failure(
                    run_id,
                    "INVALID_RESPONSE",
                    "terminal.read response is missing chunks",
                );
            }
        };

        for chunk in chunks {
            let seq = match chunk.get("seq").and_then(Value::as_u64) {
                Some(seq) => seq,
                None => {
                    return AutomationResponse::failure(
                        run_id,
                        "INVALID_RESPONSE",
                        "terminal output chunk is missing seq",
                    );
                }
            };
            let data = match chunk.get("data").and_then(Value::as_str) {
                Some(data) => data,
                None => {
                    return AutomationResponse::failure(
                        run_id,
                        "INVALID_RESPONSE",
                        "terminal output chunk is missing data",
                    );
                }
            };
            cursor = cursor.max(seq);
            captured.push_str(data);
        }

        if !started {
            let start_token = format!("{marker}:START");
            if let Some(start_index) = captured.find(&start_token) {
                captured = captured[start_index..].to_owned();
                started = true;
            } else if captured.len() > 128 * 1024 {
                captured = utf8_tail(&captured, 64 * 1024).to_owned();
            }
        }

        if captured.len() > MAX_RUN_CAPTURE_BYTES {
            return AutomationResponse::failure(
                run_id,
                "TERMINAL_OUTPUT_TOO_LARGE",
                format!(
                    "terminal command output exceeds {MAX_RUN_CAPTURE_BYTES} captured bytes"
                ),
            );
        }

        if let Some((output, exit_code)) = extract_run_completion(&captured, &marker) {
            return AutomationResponse::success(
                run_id,
                json!({
                    "sessionId": session_id,
                    "command": command,
                    "output": output,
                    "exitCode": exit_code,
                    "nextSeq": cursor,
                }),
            );
        }

        let status = result
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("unknown");
        if status != "running" {
            return AutomationResponse::failure(
                run_id,
                "TERMINAL_EXITED",
                format!("terminal became {status} before the command completion marker"),
            );
        }
    }
}

async fn wait_for_terminal_snapshot(
    session_id: &str,
    run_deadline: Instant,
) -> Result<Value, CallFailure> {
    let started_at = Instant::now();
    let readiness_deadline = (started_at + TERMINAL_READY_TIMEOUT).min(run_deadline);

    loop {
        match call_result(
            "terminal.read",
            json!({
                "sessionId": session_id,
                "afterSeq": 0,
                "maxBytes": TERMINAL_READ_BYTES,
                "waitMs": 0,
            }),
        )
        .await
        {
            Ok(result) => return Ok(result),
            Err(error) if error.code == "TERMINAL_NOT_FOUND" && Instant::now() < readiness_deadline => {
                sleep(TERMINAL_READY_RETRY_DELAY).await;
            }
            Err(error) if error.code == "TERMINAL_NOT_FOUND" => {
                let waited = readiness_deadline.saturating_duration_since(started_at);
                return Err(CallFailure {
                    code: "TERMINAL_NOT_READY".to_owned(),
                    message: format!(
                        "terminal session did not become ready within {} seconds",
                        waited.as_secs().max(1)
                    ),
                });
            }
            Err(error) => return Err(error),
        }
    }
}

async fn call_result(method: &str, params: Value) -> Result<Value, CallFailure> {
    let response = call(method, params).await.map_err(|error| CallFailure {
        code: "CLIENT_ERROR".to_owned(),
        message: format!("unable to call cmux automation endpoint: {error}"),
    })?;
    if response.ok {
        return Ok(response.result.unwrap_or_else(|| json!({})));
    }

    let error = response.error.unwrap_or_else(|| AutomationError {
        code: "UNKNOWN".to_owned(),
        message: "automation request failed without an error payload".to_owned(),
    });
    Err(CallFailure {
        code: error.code,
        message: error.message,
    })
}

fn build_powershell_run_input(command: &str, marker: &str) -> Result<String, String> {
    if command.is_empty() || command.len() > MAX_RUN_COMMAND_BYTES {
        return Err(format!(
            "command must contain 1 to {MAX_RUN_COMMAND_BYTES} UTF-8 bytes"
        ));
    }
    if command.as_bytes().contains(&0) {
        return Err("command must not contain NUL bytes".to_owned());
    }

    let encoded_command = STANDARD.encode(command.as_bytes());
    let script = format!(
        "$__cmuxMarker='{marker}'; $__cmuxCommand=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_command}')); Write-Output ($__cmuxMarker + ':START'); $__cmuxExit=0; try {{ $global:LASTEXITCODE=$null; Invoke-Expression $__cmuxCommand; $__cmuxSucceeded=$?; $__cmuxExternal=$LASTEXITCODE; if ($null -ne $__cmuxExternal) {{ $__cmuxExit=[int]$__cmuxExternal }} elseif (-not $__cmuxSucceeded) {{ $__cmuxExit=1 }} }} catch {{ $__cmuxExit=1; Write-Error $_ }}; Write-Output ($__cmuxMarker + ':END:' + $__cmuxExit)"
    );
    let mut utf16 = Vec::with_capacity(script.len() * 2);
    for unit in script.encode_utf16() {
        utf16.extend_from_slice(&unit.to_le_bytes());
    }
    let encoded_script = STANDARD.encode(utf16);
    let input = format!(
        "powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded_script}\r"
    );
    if input.len() > 16 * 1024 {
        return Err("encoded terminal command exceeds terminal.write limit".to_owned());
    }
    Ok(input)
}

fn extract_run_completion(buffer: &str, marker: &str) -> Option<(String, i64)> {
    let start_token = format!("{marker}:START");
    let end_prefix = format!("{marker}:END:");
    let start = buffer.find(&start_token)? + start_token.len();
    let remaining = &buffer[start..];
    let end_offset = remaining.find(&end_prefix)?;
    let code_start = start + end_offset + end_prefix.len();
    let code_text: String = buffer[code_start..]
        .chars()
        .take_while(|character| character.is_ascii_digit() || *character == '-')
        .collect();
    if code_text.is_empty() {
        return None;
    }
    let exit_code = code_text.parse().ok()?;
    let output = buffer[start..start + end_offset]
        .trim_matches(|character| matches!(character, '\r' | '\n'))
        .to_owned();
    Some((output, exit_code))
}

fn utf8_tail(value: &str, max_bytes: usize) -> &str {
    if value.len() <= max_bytes {
        return value;
    }

    let mut start = value.len() - max_bytes;
    while start < value.len() && !value.is_char_boundary(start) {
        start += 1;
    }
    &value[start..]
}

fn value_u64(value: &Value, field: &str) -> Result<u64, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("automation response is missing numeric field: {field}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encoded_run_input_hides_marker_and_stays_bounded() {
        let marker = "__CMUX_RUN_TEST__";
        let input = build_powershell_run_input(&"x".repeat(MAX_RUN_COMMAND_BYTES), marker)
            .expect("maximum command should fit");
        assert!(!input.contains(marker));
        assert!(input.starts_with("powershell.exe "));
        assert!(input.ends_with('\r'));
        assert!(input.len() <= 16 * 1024);
    }

    #[test]
    fn wrapper_no_longer_overwrites_external_exit_code_with_zero() {
        let marker = "__CMUX_RUN_TEST__";
        let input = build_powershell_run_input("cmd /c exit 7", marker)
            .expect("input should build");
        assert!(!input.contains("$global:LASTEXITCODE=0"));
    }

    #[test]
    fn extracts_output_and_exit_code_across_marker_noise() {
        let marker = "__CMUX_RUN_TEST__";
        let buffer = format!(
            "shell echo\r\n{marker}:START\r\nhello\r\nworld\r\n{marker}:END:7\r\n"
        );
        assert_eq!(
            extract_run_completion(&buffer, marker),
            Some(("hello\r\nworld".to_owned(), 7))
        );
    }

    #[test]
    fn utf8_tail_never_slices_inside_a_character() {
        let value = format!("{}tail", "ế".repeat(100));
        let tail = utf8_tail(&value, 17);
        assert!(tail.len() <= 17);
        assert!(value.ends_with(tail));
        assert!(tail.is_char_boundary(0));
    }
}
