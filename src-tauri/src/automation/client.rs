#![cfg(windows)]

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};
use std::{
    io, process,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    time::{sleep, Instant},
};

use super::{
    config::load,
    protocol::{AutomationRequest, AutomationResponse, MAX_REQUEST_BYTES, PROTOCOL_VERSION},
};

const CONNECT_RETRIES: usize = 40;
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(50);
const ERROR_PIPE_BUSY_CODE: i32 = 231;
const DEFAULT_RUN_TIMEOUT_SECONDS: u64 = 60;
const MAX_RUN_TIMEOUT_SECONDS: u64 = 600;
const MAX_RUN_COMMAND_BYTES: usize = 8 * 1024;
const MAX_RUN_CAPTURE_BYTES: usize = 512 * 1024;
const TERMINAL_READ_BYTES: u64 = 8 * 1024;
const HELP: &str = "cmux-cli <ping|info|workspace|pane|terminal>\n\n\
  cmux-cli workspace list\n\
  cmux-cli workspace create <title> [--cwd <path>] [--no-activate]\n\
  cmux-cli workspace select <workspace-id>\n\
  cmux-cli workspace close <workspace-id>\n\
  cmux-cli pane terminal <workspace-id>\n\
  cmux-cli pane browser <workspace-id> [url]\n\
  cmux-cli pane close <workspace-id> <pane-id>\n\
  cmux-cli terminal write <session-id> <data> [--enter]\n\
  cmux-cli terminal read <session-id> [--after <seq>] [--max-bytes <n>] [--wait-ms <n>]\n\
  cmux-cli terminal run <session-id> <command> [--timeout <seconds>]";

#[derive(Debug, PartialEq)]
enum CliAction {
    Help,
    Call { method: &'static str, params: Value },
    RunTerminal {
        session_id: String,
        command: String,
        timeout: Duration,
    },
}

pub async fn call(method: &str, params: Value) -> io::Result<AutomationResponse> {
    let config = load()?;
    let mut client = connect(&config.pipe_name).await?;
    let request_id = request_id();
    let request = AutomationRequest {
        version: PROTOCOL_VERSION,
        id: request_id.clone(),
        token: config.token,
        method: method.to_owned(),
        params,
    };

    let mut encoded = serde_json::to_vec(&request).map_err(io::Error::other)?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "automation request exceeds protocol limit",
        ));
    }
    encoded.push(b'\n');
    client.write_all(&encoded).await?;
    client.flush().await?;

    let mut reader = BufReader::new(client);
    let line = read_response_line(&mut reader).await?;
    let response: AutomationResponse = serde_json::from_slice(&line).map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidData,
            format!("automation server returned invalid JSON: {error}"),
        )
    })?;

    if response.version != PROTOCOL_VERSION {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "automation server returned protocol version {}; expected {}",
                response.version, PROTOCOL_VERSION
            ),
        ));
    }
    if response.id != request_id {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "automation response correlation ID does not match request",
        ));
    }

    Ok(response)
}

pub async fn run_cli() -> Result<bool, String> {
    let action = parse_cli_args(std::env::args().skip(1))?;
    let response = match action {
        CliAction::Help => {
            println!("{HELP}");
            return Ok(true);
        }
        CliAction::Call { method, params } => call(method, params)
            .await
            .map_err(|error| format!("unable to call cmux automation endpoint: {error}"))?,
        CliAction::RunTerminal {
            session_id,
            command,
            timeout,
        } => run_terminal_command(&session_id, &command, timeout).await,
    };

    println!(
        "{}",
        serde_json::to_string_pretty(&response)
            .map_err(|error| format!("unable to serialize response: {error}"))?
    );

    let command_succeeded = response
        .result
        .as_ref()
        .and_then(|result| result.get("exitCode"))
        .and_then(Value::as_i64)
        .is_none_or(|exit_code| exit_code == 0);
    Ok(response.ok && command_succeeded)
}

async fn run_terminal_command(
    session_id: &str,
    command: &str,
    run_timeout: Duration,
) -> AutomationResponse {
    let run_id = request_id();
    let marker = format!("__CMUX_RUN_{}__", run_id.replace('-', "_"));

    let initial = match call_result(
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
        Ok(result) => result,
        Err(error) => return AutomationResponse::failure(run_id, "TERMINAL_RUN_FAILED", error),
    };
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
        return AutomationResponse::failure(run_id, "TERMINAL_RUN_FAILED", error);
    }

    let deadline = Instant::now() + run_timeout;
    let mut captured = String::new();
    let mut started = false;

    loop {
        let now = Instant::now();
        if now >= deadline {
            return AutomationResponse::failure(
                run_id,
                "TERMINAL_RUN_TIMEOUT",
                format!("terminal command did not complete within {} seconds", run_timeout.as_secs()),
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
            Err(error) => return AutomationResponse::failure(run_id, "TERMINAL_RUN_FAILED", error),
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
                )
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
                    )
                }
            };
            let data = match chunk.get("data").and_then(Value::as_str) {
                Some(data) => data,
                None => {
                    return AutomationResponse::failure(
                        run_id,
                        "INVALID_RESPONSE",
                        "terminal output chunk is missing data",
                    )
                }
            };
            cursor = cursor.max(seq);
            captured.push_str(data);
        }

        if !started {
            if let Some(start_index) = captured.find(&format!("{marker}:START")) {
                captured = captured[start_index..].to_owned();
                started = true;
            } else if captured.len() > 128 * 1024 {
                let keep_from = captured.len().saturating_sub(64 * 1024);
                captured = captured[keep_from..].to_owned();
            }
        }

        if captured.len() > MAX_RUN_CAPTURE_BYTES {
            return AutomationResponse::failure(
                run_id,
                "TERMINAL_OUTPUT_TOO_LARGE",
                format!("terminal command output exceeds {MAX_RUN_CAPTURE_BYTES} captured bytes"),
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

        if result.get("hasMore").and_then(Value::as_bool) == Some(true) {
            continue;
        }
    }
}

async fn call_result(method: &str, params: Value) -> Result<Value, String> {
    let response = call(method, params)
        .await
        .map_err(|error| format!("unable to call cmux automation endpoint: {error}"))?;
    if response.ok {
        return Ok(response.result.unwrap_or_else(|| json!({})));
    }

    let error = response.error.unwrap_or_else(|| super::protocol::AutomationError {
        code: "UNKNOWN".to_owned(),
        message: "automation request failed without an error payload".to_owned(),
    });
    Err(format!("[{}] {}", error.code, error.message))
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
        "$__cmuxMarker='{marker}'; $__cmuxCommand=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('{encoded_command}')); Write-Output ($__cmuxMarker + ':START'); $__cmuxExit=0; try {{ $global:LASTEXITCODE=0; Invoke-Expression $__cmuxCommand; $__cmuxSucceeded=$?; $__cmuxExternal=$LASTEXITCODE; if (-not $__cmuxSucceeded) {{ $__cmuxExit=1 }} elseif ($null -ne $__cmuxExternal) {{ $__cmuxExit=[int]$__cmuxExternal }} }} catch {{ $__cmuxExit=1; Write-Error $_ }}; Write-Output ($__cmuxMarker + ':END:' + $__cmuxExit)"
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

fn value_u64(value: &Value, field: &str) -> Result<u64, String> {
    value
        .get(field)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("automation response is missing numeric field: {field}"))
}

fn parse_cli_args<I>(arguments: I) -> Result<CliAction, String>
where
    I: IntoIterator<Item = String>,
{
    let mut arguments = arguments.into_iter();
    let command = arguments.next().unwrap_or_else(|| "help".to_owned());

    match command.as_str() {
        "help" | "--help" | "-h" => ensure_finished(arguments).map(|_| CliAction::Help),
        "ping" => ensure_finished(arguments).map(|_| CliAction::Call {
            method: "ping",
            params: json!({}),
        }),
        "info" => ensure_finished(arguments).map(|_| CliAction::Call {
            method: "app.info",
            params: json!({}),
        }),
        "workspace" => parse_workspace_command(arguments),
        "pane" => parse_pane_command(arguments),
        "terminal" => parse_terminal_command(arguments),
        _ => Err(format!("unsupported command: {command}\n\n{HELP}")),
    }
}

fn parse_workspace_command<I>(mut arguments: I) -> Result<CliAction, String>
where
    I: Iterator<Item = String>,
{
    let command = arguments
        .next()
        .ok_or_else(|| format!("workspace subcommand is required\n\n{HELP}"))?;

    match command.as_str() {
        "list" => ensure_finished(arguments).map(|_| CliAction::Call {
            method: "workspace.list",
            params: json!({}),
        }),
        "select" | "close" => {
            let workspace_id = required_argument(&mut arguments, "workspace-id")?;
            ensure_finished(arguments)?;
            Ok(CliAction::Call {
                method: if command == "select" {
                    "workspace.select"
                } else {
                    "workspace.close"
                },
                params: json!({ "workspaceId": workspace_id }),
            })
        }
        "create" => {
            let title = required_argument(&mut arguments, "title")?;
            let mut cwd = String::new();
            let mut activate = true;

            while let Some(argument) = arguments.next() {
                match argument.as_str() {
                    "--cwd" => cwd = required_argument(&mut arguments, "path")?,
                    "--no-activate" => activate = false,
                    _ => return Err(format!("unsupported workspace create option: {argument}")),
                }
            }

            Ok(CliAction::Call {
                method: "workspace.create",
                params: json!({ "title": title, "cwd": cwd, "activate": activate }),
            })
        }
        _ => Err(format!("unsupported workspace command: {command}\n\n{HELP}")),
    }
}

fn parse_pane_command<I>(mut arguments: I) -> Result<CliAction, String>
where
    I: Iterator<Item = String>,
{
    let command = arguments
        .next()
        .ok_or_else(|| format!("pane subcommand is required\n\n{HELP}"))?;

    match command.as_str() {
        "terminal" => {
            let workspace_id = required_argument(&mut arguments, "workspace-id")?;
            ensure_finished(arguments)?;
            Ok(CliAction::Call {
                method: "pane.createTerminal",
                params: json!({ "workspaceId": workspace_id }),
            })
        }
        "browser" => {
            let workspace_id = required_argument(&mut arguments, "workspace-id")?;
            let url = arguments.next();
            ensure_finished(arguments)?;
            Ok(CliAction::Call {
                method: "pane.createBrowser",
                params: match url {
                    Some(url) => json!({ "workspaceId": workspace_id, "url": url }),
                    None => json!({ "workspaceId": workspace_id }),
                },
            })
        }
        "close" => {
            let workspace_id = required_argument(&mut arguments, "workspace-id")?;
            let pane_id = required_argument(&mut arguments, "pane-id")?;
            ensure_finished(arguments)?;
            Ok(CliAction::Call {
                method: "pane.close",
                params: json!({ "workspaceId": workspace_id, "paneId": pane_id }),
            })
        }
        _ => Err(format!("unsupported pane command: {command}\n\n{HELP}")),
    }
}

fn parse_terminal_command<I>(mut arguments: I) -> Result<CliAction, String>
where
    I: Iterator<Item = String>,
{
    let command = arguments
        .next()
        .ok_or_else(|| format!("terminal subcommand is required\n\n{HELP}"))?;

    match command.as_str() {
        "write" => {
            let session_id = required_argument(&mut arguments, "session-id")?;
            let mut data = required_argument(&mut arguments, "data")?;
            if let Some(option) = arguments.next() {
                if option != "--enter" {
                    return Err(format!("unsupported terminal write option: {option}"));
                }
                data.push('\r');
            }
            ensure_finished(arguments)?;
            Ok(CliAction::Call {
                method: "terminal.write",
                params: json!({ "sessionId": session_id, "data": data }),
            })
        }
        "read" => {
            let session_id = required_argument(&mut arguments, "session-id")?;
            let mut after_seq = 0_u64;
            let mut max_bytes = TERMINAL_READ_BYTES;
            let mut wait_ms = 0_u64;
            while let Some(option) = arguments.next() {
                match option.as_str() {
                    "--after" => {
                        after_seq = parse_u64(
                            &required_argument(&mut arguments, "seq")?,
                            "seq",
                            0,
                            u64::MAX,
                        )?
                    }
                    "--max-bytes" => {
                        max_bytes = parse_u64(
                            &required_argument(&mut arguments, "bytes")?,
                            "bytes",
                            1024,
                            TERMINAL_READ_BYTES,
                        )?
                    }
                    "--wait-ms" => {
                        wait_ms = parse_u64(
                            &required_argument(&mut arguments, "milliseconds")?,
                            "milliseconds",
                            0,
                            30_000,
                        )?
                    }
                    _ => return Err(format!("unsupported terminal read option: {option}")),
                }
            }
            Ok(CliAction::Call {
                method: "terminal.read",
                params: json!({
                    "sessionId": session_id,
                    "afterSeq": after_seq,
                    "maxBytes": max_bytes,
                    "waitMs": wait_ms,
                }),
            })
        }
        "run" => {
            let session_id = required_argument(&mut arguments, "session-id")?;
            let command = required_argument(&mut arguments, "command")?;
            let mut timeout_seconds = DEFAULT_RUN_TIMEOUT_SECONDS;
            while let Some(option) = arguments.next() {
                match option.as_str() {
                    "--timeout" => {
                        timeout_seconds = parse_u64(
                            &required_argument(&mut arguments, "seconds")?,
                            "seconds",
                            1,
                            MAX_RUN_TIMEOUT_SECONDS,
                        )?
                    }
                    _ => return Err(format!("unsupported terminal run option: {option}")),
                }
            }
            Ok(CliAction::RunTerminal {
                session_id,
                command,
                timeout: Duration::from_secs(timeout_seconds),
            })
        }
        _ => Err(format!("unsupported terminal command: {command}\n\n{HELP}")),
    }
}

fn parse_u64(value: &str, name: &str, min: u64, max: u64) -> Result<u64, String> {
    let parsed = value
        .parse::<u64>()
        .map_err(|_| format!("{name} must be an unsigned integer"))?;
    if !(min..=max).contains(&parsed) {
        return Err(format!("{name} must be between {min} and {max}"));
    }
    Ok(parsed)
}

fn required_argument<I>(arguments: &mut I, name: &str) -> Result<String, String>
where
    I: Iterator<Item = String>,
{
    arguments
        .next()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("missing required argument: {name}"))
}

fn ensure_finished<I>(mut arguments: I) -> Result<(), String>
where
    I: Iterator<Item = String>,
{
    match arguments.next() {
        Some(argument) => Err(format!("unexpected argument: {argument}")),
        None => Ok(()),
    }
}

async fn read_response_line<R>(reader: &mut R) -> io::Result<Vec<u8>>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();

    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "automation server closed without a complete response",
            ));
        }

        let newline = buffer.iter().position(|value| *value == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        if line.len() + take > MAX_REQUEST_BYTES {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "automation response exceeds protocol limit",
            ));
        }

        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_some() {
            while line
                .last()
                .is_some_and(|value| matches!(*value, b'\n' | b'\r'))
            {
                line.pop();
            }
            return Ok(line);
        }
    }
}

async fn connect(pipe_name: &str) -> io::Result<NamedPipeClient> {
    let mut last_error = None;

    for _ in 0..CONNECT_RETRIES {
        match ClientOptions::new().open(pipe_name) {
            Ok(client) => return Ok(client),
            Err(error) if error.raw_os_error() == Some(ERROR_PIPE_BUSY_CODE) => {
                last_error = Some(error);
                sleep(CONNECT_RETRY_DELAY).await;
            }
            Err(error) => return Err(error),
        }
    }

    Err(last_error.unwrap_or_else(|| {
        io::Error::new(io::ErrorKind::TimedOut, "automation pipe remained busy")
    }))
}

fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("cli-{}-{nanos}", process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> impl Iterator<Item = String> + '_ {
        values.iter().map(|value| (*value).to_owned())
    }

    #[test]
    fn request_ids_are_non_empty_and_process_scoped() {
        let id = request_id();
        assert!(id.starts_with(&format!("cli-{}-", process::id())));
    }

    #[test]
    fn parses_workspace_creation_options() {
        let action = parse_cli_args(args(&[
            "workspace",
            "create",
            "Agent",
            "--cwd",
            "C:\\code",
            "--no-activate",
        ]))
        .expect("command should parse");

        assert_eq!(
            action,
            CliAction::Call {
                method: "workspace.create",
                params: json!({
                    "title": "Agent",
                    "cwd": "C:\\code",
                    "activate": false
                }),
            }
        );
    }

    #[test]
    fn parses_terminal_read_write_and_run_commands() {
        assert_eq!(
            parse_cli_args(args(&["terminal", "write", "pane-1", "Get-Date", "--enter"]))
                .expect("write should parse"),
            CliAction::Call {
                method: "terminal.write",
                params: json!({ "sessionId": "pane-1", "data": "Get-Date\r" }),
            }
        );
        assert_eq!(
            parse_cli_args(args(&[
                "terminal",
                "read",
                "pane-1",
                "--after",
                "7",
                "--wait-ms",
                "1000",
            ]))
            .expect("read should parse"),
            CliAction::Call {
                method: "terminal.read",
                params: json!({
                    "sessionId": "pane-1",
                    "afterSeq": 7,
                    "maxBytes": TERMINAL_READ_BYTES,
                    "waitMs": 1000,
                }),
            }
        );
        assert_eq!(
            parse_cli_args(args(&[
                "terminal",
                "run",
                "pane-1",
                "Write-Output ok",
                "--timeout",
                "15",
            ]))
            .expect("run should parse"),
            CliAction::RunTerminal {
                session_id: "pane-1".to_owned(),
                command: "Write-Output ok".to_owned(),
                timeout: Duration::from_secs(15),
            }
        );
    }

    #[test]
    fn encoded_run_input_does_not_echo_plain_marker() {
        let marker = "__CMUX_RUN_TEST__";
        let input = build_powershell_run_input("Write-Output hello", marker)
            .expect("input should build");
        assert!(!input.contains(marker));
        assert!(input.starts_with("powershell.exe "));
        assert!(input.ends_with('\r'));
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
    fn rejects_unknown_options_and_extra_arguments() {
        assert!(parse_cli_args(args(&["workspace", "create", "Agent", "--unknown"]))
            .is_err());
        assert!(parse_cli_args(args(&["workspace", "list", "extra"]))
            .is_err());
        assert!(parse_cli_args(args(&[
            "terminal",
            "read",
            "pane-1",
            "--max-bytes",
            "999999",
        ]))
        .is_err());
    }
}
