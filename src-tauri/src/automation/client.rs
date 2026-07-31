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
    cli_parser::{parse_cli_args, CliAction, HELP},
    config::load,
    protocol::{AutomationRequest, AutomationResponse, MAX_REQUEST_BYTES, PROTOCOL_VERSION},
    terminal_runner::run_terminal_command,
};

const CONNECT_RETRIES: usize = 40;
const CONNECT_RETRY_DELAY: Duration = Duration::from_millis(50);
const ERROR_PIPE_BUSY_CODE: i32 = 231;

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
        .map_or(true, |exit_code| exit_code == 0);
    Ok(response.ok && command_succeeded)
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

pub(crate) fn request_id() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("cli-{}-{nanos}", process::id())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_ids_are_non_empty_and_process_scoped() {
        let id = request_id();
        assert!(id.starts_with(&format!("cli-{}-", process::id())));
    }

    #[test]
    fn command_exit_code_controls_cli_success() {
        let success = json!({ "exitCode": 0 });
        let failure = json!({ "exitCode": 7 });
        assert!(success
            .get("exitCode")
            .and_then(Value::as_i64)
            .map_or(true, |code| code == 0));
        assert!(!failure
            .get("exitCode")
            .and_then(Value::as_i64)
            .map_or(true, |code| code == 0));
    }
}
