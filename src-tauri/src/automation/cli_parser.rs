#![cfg(windows)]

use serde_json::{json, Value};
use std::time::Duration;

pub(crate) const DEFAULT_RUN_TIMEOUT_SECONDS: u64 = 60;
pub(crate) const MAX_RUN_TIMEOUT_SECONDS: u64 = 600;
pub(crate) const TERMINAL_READ_BYTES: u64 = 8 * 1024;
const MAX_EVENT_READ_COUNT: u64 = 100;
const MAX_EVENT_WAIT_MS: u64 = 30_000;

pub(crate) const HELP: &str = "cmux-cli <ping|info|workspace|pane|terminal|event>\n\n\
  cmux-cli workspace list\n\
  cmux-cli workspace create <title> [--cwd <path>] [--no-activate]\n\
  cmux-cli workspace select <workspace-id>\n\
  cmux-cli workspace close <workspace-id>\n\
  cmux-cli pane terminal <workspace-id>\n\
  cmux-cli pane browser <workspace-id> [url]\n\
  cmux-cli pane close <workspace-id> <pane-id>\n\
  cmux-cli terminal write <session-id> <data> [--enter]\n\
  cmux-cli terminal read <session-id> [--after <seq>] [--max-bytes <n>] [--wait-ms <n>]\n\
  cmux-cli terminal run <session-id> <command> [--timeout <seconds>]\n\
  cmux-cli event read [--after <seq>] [--max-events <n>] [--wait-ms <n>]";

#[derive(Debug, PartialEq)]
pub(crate) enum CliAction {
    Help,
    Call {
        method: &'static str,
        params: Value,
    },
    RunTerminal {
        session_id: String,
        command: String,
        timeout: Duration,
    },
}

pub(crate) fn parse_cli_args<I>(arguments: I) -> Result<CliAction, String>
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
        "event" => parse_event_command(arguments),
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
                        )?;
                    }
                    "--max-bytes" => {
                        max_bytes = parse_u64(
                            &required_argument(&mut arguments, "bytes")?,
                            "bytes",
                            1024,
                            TERMINAL_READ_BYTES,
                        )?;
                    }
                    "--wait-ms" => {
                        wait_ms = parse_u64(
                            &required_argument(&mut arguments, "milliseconds")?,
                            "milliseconds",
                            0,
                            30_000,
                        )?;
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
                        )?;
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

fn parse_event_command<I>(mut arguments: I) -> Result<CliAction, String>
where
    I: Iterator<Item = String>,
{
    let command = arguments
        .next()
        .ok_or_else(|| format!("event subcommand is required\n\n{HELP}"))?;
    if command != "read" {
        return Err(format!("unsupported event command: {command}\n\n{HELP}"));
    }

    let mut after_seq = 0_u64;
    let mut max_events = 100_u64;
    let mut wait_ms = 0_u64;

    while let Some(option) = arguments.next() {
        match option.as_str() {
            "--after" => {
                after_seq = parse_u64(
                    &required_argument(&mut arguments, "seq")?,
                    "seq",
                    0,
                    u64::MAX,
                )?;
            }
            "--max-events" => {
                max_events = parse_u64(
                    &required_argument(&mut arguments, "count")?,
                    "count",
                    1,
                    MAX_EVENT_READ_COUNT,
                )?;
            }
            "--wait-ms" => {
                wait_ms = parse_u64(
                    &required_argument(&mut arguments, "milliseconds")?,
                    "milliseconds",
                    0,
                    MAX_EVENT_WAIT_MS,
                )?;
            }
            _ => return Err(format!("unsupported event read option: {option}")),
        }
    }

    Ok(CliAction::Call {
        method: "event.read",
        params: json!({
            "afterSeq": after_seq,
            "maxEvents": max_events,
            "waitMs": wait_ms,
        }),
    })
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

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> std::vec::IntoIter<String> {
        values
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>()
            .into_iter()
    }

    #[test]
    fn parses_workspace_and_pane_commands() {
        assert_eq!(
            parse_cli_args(args(&[
                "workspace",
                "create",
                "Agent",
                "--cwd",
                "C:\\code",
                "--no-activate",
            ]))
            .expect("workspace create should parse"),
            CliAction::Call {
                method: "workspace.create",
                params: json!({
                    "title": "Agent",
                    "cwd": "C:\\code",
                    "activate": false,
                }),
            }
        );
        assert_eq!(
            parse_cli_args(args(&["pane", "close", "workspace-1", "pane-1"]))
                .expect("pane close should parse"),
            CliAction::Call {
                method: "pane.close",
                params: json!({
                    "workspaceId": "workspace-1",
                    "paneId": "pane-1",
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
    fn parses_event_read_command() {
        assert_eq!(
            parse_cli_args(args(&[
                "event",
                "read",
                "--after",
                "42",
                "--max-events",
                "25",
                "--wait-ms",
                "30000",
            ]))
            .expect("event read should parse"),
            CliAction::Call {
                method: "event.read",
                params: json!({
                    "afterSeq": 42,
                    "maxEvents": 25,
                    "waitMs": 30_000,
                }),
            }
        );
    }

    #[test]
    fn rejects_unknown_options_and_out_of_range_values() {
        assert!(parse_cli_args(args(&["workspace", "create", "Agent", "--unknown"]))
            .is_err());
        assert!(parse_cli_args(args(&[
            "terminal",
            "read",
            "pane-1",
            "--max-bytes",
            "999999",
        ]))
        .is_err());
        assert!(parse_cli_args(args(&[
            "terminal",
            "run",
            "pane-1",
            "echo ok",
            "--timeout",
            "0",
        ]))
        .is_err());
        assert!(parse_cli_args(args(&[
            "event",
            "read",
            "--max-events",
            "101",
        ]))
        .is_err());
    }
}
