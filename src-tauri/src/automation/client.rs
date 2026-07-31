#![cfg(windows)]

use serde_json::{json, Value};
use std::{
    io, process,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{ClientOptions, NamedPipeClient},
    time::sleep,
};

use super::{
    config::load,
    protocol::{AutomationRequest, AutomationResponse, MAX_REQUEST_BYTES, PROTOCOL_VERSION},
};

const CONNECT_RETRIES: usize = 40;
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(50);
const ERROR_PIPE_BUSY_CODE: i32 = 231;
const HELP: &str = "cmux-cli <ping|info|workspace|pane>\n\n\
  cmux-cli workspace list\n\
  cmux-cli workspace create <title> [--cwd <path>] [--no-activate]\n\
  cmux-cli workspace select <workspace-id>\n\
  cmux-cli workspace close <workspace-id>\n\
  cmux-cli pane terminal <workspace-id>\n\
  cmux-cli pane browser <workspace-id> [url]\n\
  cmux-cli pane close <workspace-id> <pane-id>";

#[derive(Debug, PartialEq)]
enum CliAction {
    Help,
    Call { method: &'static str, params: Value },
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
    let CliAction::Call { method, params } = action else {
        println!("{HELP}");
        return Ok(true);
    };

    let response = call(method, params)
        .await
        .map_err(|error| format!("unable to call cmux automation endpoint: {error}"))?;
    println!(
        "{}",
        serde_json::to_string_pretty(&response)
            .map_err(|error| format!("unable to serialize response: {error}"))?
    );
    Ok(response.ok)
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
    fn parses_browser_and_close_commands() {
        assert_eq!(
            parse_cli_args(args(&["pane", "browser", "workspace-1", "https://example.com"]))
                .expect("browser command should parse"),
            CliAction::Call {
                method: "pane.createBrowser",
                params: json!({
                    "workspaceId": "workspace-1",
                    "url": "https://example.com"
                }),
            }
        );
        assert_eq!(
            parse_cli_args(args(&["pane", "close", "workspace-1", "pane-1"]))
                .expect("close command should parse"),
            CliAction::Call {
                method: "pane.close",
                params: json!({
                    "workspaceId": "workspace-1",
                    "paneId": "pane-1"
                }),
            }
        );
    }

    #[test]
    fn rejects_unknown_options_and_extra_arguments() {
        assert!(parse_cli_args(args(&["workspace", "create", "Agent", "--unknown"]))
            .is_err());
        assert!(parse_cli_args(args(&["workspace", "list", "extra"]))
            .is_err());
    }
}
