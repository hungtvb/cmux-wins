#![cfg(windows)]

use std::{io, sync::Arc, time::Duration};
use tauri::AppHandle;
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    sync::Semaphore,
    time::timeout,
};

use super::{
    config::{load_or_create, pipe_name_for_sid},
    dispatch::dispatch,
    protocol::{AutomationResponse, MAX_REQUEST_BYTES},
    security::SecurityDescriptor,
};

const CLIENT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REQUESTS_PER_CONNECTION: usize = 128;
const MAX_CONCURRENT_CLIENTS: usize = 64;
const MAX_PIPE_INSTANCES: usize = MAX_CONCURRENT_CLIENTS + 1;

pub async fn run(app: AppHandle) -> io::Result<()> {
    let (sid, first_server) = create_current_user_server_instance(true, None)?;
    let pipe_name = pipe_name_for_sid(&sid);

    // Create the first pipe instance before publishing endpoint discovery so a
    // second process cannot win a config-file race and impersonate cmux.
    let config = load_or_create(&pipe_name)?;
    let client_limit = Arc::new(Semaphore::new(MAX_CONCURRENT_CLIENTS));
    let mut server = first_server;

    loop {
        server.connect().await?;
        let connected = server;

        // A connected client may wait here, but no more than 64 handlers run
        // concurrently. The extra named-pipe instance is reserved for listening.
        let permit = client_limit
            .clone()
            .acquire_owned()
            .await
            .map_err(io::Error::other)?;

        server = create_sid_server_instance(&pipe_name, false, &sid)?;

        let token = config.token.clone();
        let client_app = app.clone();
        tokio::spawn(async move {
            let _permit = permit;
            if let Err(error) = handle_client(connected, &token, Some(client_app)).await {
                eprintln!("[cmux automation] client connection failed: {error}");
            }
        });
    }
}

fn create_current_user_server_instance(
    first: bool,
    pipe_name: Option<&str>,
) -> io::Result<(String, NamedPipeServer)> {
    let (sid, mut descriptor) = SecurityDescriptor::for_current_user()?;
    let owned_pipe_name;
    let pipe_name = match pipe_name {
        Some(value) => value,
        None => {
            owned_pipe_name = pipe_name_for_sid(&sid);
            &owned_pipe_name
        }
    };
    let server = create_server_instance(pipe_name, first, descriptor.as_raw_attributes())?;
    Ok((sid, server))
}

fn create_sid_server_instance(
    pipe_name: &str,
    first: bool,
    sid: &str,
) -> io::Result<NamedPipeServer> {
    let mut descriptor = SecurityDescriptor::for_sid(sid)?;
    create_server_instance(pipe_name, first, descriptor.as_raw_attributes())
}

fn create_server_instance(
    pipe_name: &str,
    first: bool,
    security_attributes: *mut std::ffi::c_void,
) -> io::Result<NamedPipeServer> {
    let mut options = ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true)
        .access_inbound(true)
        .access_outbound(true)
        .max_instances(MAX_PIPE_INSTANCES);

    unsafe { options.create_with_security_attributes_raw(pipe_name, security_attributes) }
}

enum RequestLine {
    Eof,
    Line(Vec<u8>),
    TooLarge,
}

async fn read_request_line<R>(reader: &mut R) -> io::Result<RequestLine>
where
    R: AsyncBufRead + Unpin,
{
    let mut line = Vec::new();

    loop {
        let buffer = reader.fill_buf().await?;
        if buffer.is_empty() {
            return if line.is_empty() {
                Ok(RequestLine::Eof)
            } else {
                Ok(RequestLine::Line(line))
            };
        }

        let newline = buffer.iter().position(|value| *value == b'\n');
        let take = newline.map_or(buffer.len(), |index| index + 1);
        if line.len().saturating_add(take) > MAX_REQUEST_BYTES {
            reader.consume(take);
            return Ok(RequestLine::TooLarge);
        }

        line.extend_from_slice(&buffer[..take]);
        reader.consume(take);
        if newline.is_some() {
            return Ok(RequestLine::Line(line));
        }
    }
}

async fn handle_client(
    server: NamedPipeServer,
    expected_token: &str,
    app: Option<AppHandle>,
) -> io::Result<()> {
    let (reader, mut writer) = tokio::io::split(server);
    let mut reader = BufReader::new(reader);

    for _ in 0..MAX_REQUESTS_PER_CONNECTION {
        let request_line = match timeout(CLIENT_IDLE_TIMEOUT, read_request_line(&mut reader)).await {
            Ok(result) => result?,
            Err(_) => return Ok(()),
        };

        let mut line = match request_line {
            RequestLine::Eof => return Ok(()),
            RequestLine::Line(line) => line,
            RequestLine::TooLarge => {
                write_response(
                    &mut writer,
                    &AutomationResponse::failure(
                        "",
                        "REQUEST_TOO_LARGE",
                        format!("request exceeds {MAX_REQUEST_BYTES} bytes"),
                    ),
                )
                .await?;
                return Ok(());
            }
        };

        while line
            .last()
            .is_some_and(|value| matches!(*value, b'\n' | b'\r'))
        {
            line.pop();
        }

        let response = dispatch(&line, expected_token, app.as_ref()).await;
        write_response(&mut writer, &response).await?;
    }

    Ok(())
}

fn encode_response(response: &AutomationResponse) -> io::Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(response).map_err(io::Error::other)?;
    if encoded.len().saturating_add(1) > MAX_REQUEST_BYTES {
        let fallback = AutomationResponse::failure(
            response.id.clone(),
            "RESPONSE_TOO_LARGE",
            format!("response exceeds {MAX_REQUEST_BYTES} bytes"),
        );
        encoded = serde_json::to_vec(&fallback).map_err(io::Error::other)?;
    }
    encoded.push(b'\n');
    Ok(encoded)
}

async fn write_response<W>(writer: &mut W, response: &AutomationResponse) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
{
    let encoded = encode_response(response)?;
    writer.write_all(&encoded).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{
        process,
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt},
        net::windows::named_pipe::ClientOptions,
    };

    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn request(method: &str, id: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "version": 1,
            "id": id,
            "token": TOKEN,
            "method": method,
            "params": {},
        }))
        .expect("request should serialize")
    }

    #[test]
    fn oversized_response_is_replaced_with_bounded_error() {
        let response = AutomationResponse::success(
            "request-1",
            json!({ "value": "x".repeat(MAX_REQUEST_BYTES) }),
        );
        let encoded = encode_response(&response).expect("response should encode");
        assert!(encoded.len() <= MAX_REQUEST_BYTES);

        let fallback: AutomationResponse = serde_json::from_slice(
            encoded
                .strip_suffix(b"\n")
                .expect("encoded response should end with newline"),
        )
        .expect("fallback should be valid JSON");
        assert!(!fallback.ok);
        assert_eq!(
            fallback.error.expect("missing error").code,
            "RESPONSE_TOO_LARGE"
        );
    }

    #[tokio::test]
    async fn client_limit_blocks_until_a_permit_is_released() {
        let limit = Arc::new(Semaphore::new(2));
        let first = limit.clone().acquire_owned().await.expect("first permit");
        let second = limit.clone().acquire_owned().await.expect("second permit");
        assert!(timeout(Duration::from_millis(20), limit.clone().acquire_owned())
            .await
            .is_err());
        drop(first);
        let third = timeout(Duration::from_secs(1), limit.clone().acquire_owned())
            .await
            .expect("third permit should wake")
            .expect("semaphore should remain open");
        drop(second);
        drop(third);
    }

    #[tokio::test]
    async fn current_user_named_pipe_supports_multiple_requests_and_reconnect() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        let pipe_name = format!(r"\\.\pipe\cmux-automation-test-{}-{nanos}", process::id());
        let (sid, first_server) = create_current_user_server_instance(true, Some(&pipe_name))
            .expect("first server pipe should be created");

        let server_pipe_name = pipe_name.clone();
        let server_task = tokio::spawn(async move {
            let mut server = first_server;
            for _ in 0..2 {
                server.connect().await.expect("server should connect");
                let connected = server;
                server = create_sid_server_instance(&server_pipe_name, false, &sid)
                    .expect("next server should be created");
                handle_client(connected, TOKEN, None)
                    .await
                    .expect("server should handle client");
            }
        });

        let mut first_client = ClientOptions::new()
            .open(&pipe_name)
            .expect("first client should open current-user pipe");
        for (index, id) in ["request-1", "request-2"].into_iter().enumerate() {
            let mut encoded = request("ping", id);
            encoded.push(b'\n');
            first_client
                .write_all(&encoded)
                .await
                .expect("client should write request");
            first_client.flush().await.expect("client should flush");

            let mut reader = BufReader::new(&mut first_client);
            let mut line = Vec::new();
            timeout(Duration::from_secs(5), reader.read_until(b'\n', &mut line))
                .await
                .expect("response timed out")
                .expect("response read failed");
            let response: AutomationResponse =
                serde_json::from_slice(&line).expect("response should be valid JSON");
            assert!(response.ok, "request {index} should succeed");
            assert_eq!(response.id, id);
            assert_eq!(
                response
                    .result
                    .and_then(|value| value.get("pong").cloned()),
                Some(Value::Bool(true))
            );
        }
        drop(first_client);

        let mut second_client = ClientOptions::new()
            .open(&pipe_name)
            .expect("second client should reconnect");
        let mut encoded = request("ping", "request-3");
        encoded.push(b'\n');
        second_client
            .write_all(&encoded)
            .await
            .expect("second client should write");
        second_client.flush().await.expect("second client should flush");
        let mut reader = BufReader::new(second_client);
        let mut line = Vec::new();
        timeout(Duration::from_secs(5), reader.read_until(b'\n', &mut line))
            .await
            .expect("response timed out")
            .expect("response read failed");
        let response: AutomationResponse =
            serde_json::from_slice(&line).expect("response should be valid JSON");
        assert!(response.ok);
        assert_eq!(response.id, "request-3");

        drop(reader);
        timeout(Duration::from_secs(5), server_task)
            .await
            .expect("server task did not stop")
            .expect("server task panicked");
    }
}
