#![cfg(windows)]

use serde_json::json;
use std::{io, process, time::Duration};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
    time::timeout,
};

use super::{
    bridge::{request as bridge_request, AutomationBridge},
    config::{load_or_create, pipe_name_for_sid},
    methods::prepare_frontend_method,
    protocol::{
        token_matches, validate_request, AutomationRequest, AutomationResponse,
        MAX_REQUEST_BYTES, PROTOCOL_VERSION,
    },
    security::SecurityDescriptor,
};

const CLIENT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REQUESTS_PER_CONNECTION: usize = 128;

pub async fn run(app: AppHandle) -> io::Result<()> {
    let (sid, mut first_descriptor) = SecurityDescriptor::for_current_user()?;
    let pipe_name = pipe_name_for_sid(&sid);
    let first_server = create_server_instance(
        &pipe_name,
        true,
        first_descriptor.as_raw_attributes(),
    )?;
    drop(first_descriptor);

    // The first pipe instance is created before publishing the token file so a
    // second process cannot win a config-file race and impersonate the endpoint.
    let config = load_or_create(&pipe_name)?;
    let mut server = first_server;

    loop {
        server.connect().await?;
        let connected = server;

        let mut descriptor = SecurityDescriptor::for_sid(&sid)?;
        server = create_server_instance(
            &pipe_name,
            false,
            descriptor.as_raw_attributes(),
        )?;
        drop(descriptor);

        let token = config.token.clone();
        let client_app = app.clone();
        tokio::spawn(async move {
            if let Err(error) = handle_client(connected, &token, Some(client_app)).await {
                eprintln!("[cmux automation] client connection failed: {error}");
            }
        });
    }
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
        .access_outbound(true);

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
        if line.len() + take > MAX_REQUEST_BYTES {
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

async fn dispatch(
    line: &[u8],
    expected_token: &str,
    app: Option<&AppHandle>,
) -> AutomationResponse {
    let request: AutomationRequest = match serde_json::from_slice(line) {
        Ok(request) => request,
        Err(error) => {
            return AutomationResponse::failure(
                "",
                "INVALID_JSON",
                format!("request is not valid JSON: {error}"),
            )
        }
    };

    if let Err(response) = validate_request(&request) {
        return response;
    }

    if !token_matches(expected_token, &request.token) {
        return AutomationResponse::failure(
            request.id,
            "UNAUTHORIZED",
            "automation token is not valid",
        );
    }

    let request_id = request.id;
    let method = request.method;
    let params = request.params;

    match method.as_str() {
        "ping" => AutomationResponse::success(request_id, json!({ "pong": true })),
        "app.info" => AutomationResponse::success(
            request_id,
            json!({
                "appVersion": env!("CARGO_PKG_VERSION"),
                "protocolVersion": PROTOCOL_VERSION,
                "processId": process::id(),
            }),
        ),
        _ => match prepare_frontend_method(&method, params) {
            Err(error) => AutomationResponse::failure(request_id, error.code, error.message),
            Ok(None) => AutomationResponse::failure(
                request_id,
                "METHOD_NOT_FOUND",
                "unsupported automation method",
            ),
            Ok(Some(params)) => {
                let Some(app) = app else {
                    return AutomationResponse::failure(
                        request_id,
                        "INTERNAL_ERROR",
                        "workspace bridge is not available",
                    );
                };
                let bridge = app.state::<AutomationBridge>();
                match bridge_request(app, bridge.inner(), &method, params).await {
                    Ok(result) => AutomationResponse::success(request_id, result),
                    Err(error) => {
                        AutomationResponse::failure(request_id, error.code, error.message)
                    }
                }
            }
        },
    }
}

fn encode_response(response: &AutomationResponse) -> io::Result<Vec<u8>> {
    let mut encoded = serde_json::to_vec(response).map_err(io::Error::other)?;
    if encoded.len() + 1 > MAX_REQUEST_BYTES {
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
    use serde_json::Value;
    use std::time::{SystemTime, UNIX_EPOCH};
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt},
        net::windows::named_pipe::ClientOptions,
    };

    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn request(method: &str, token: &str) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "version": 1,
            "id": "request-1",
            "token": token,
            "method": method,
            "params": {}
        }))
        .expect("request should serialize")
    }

    #[tokio::test]
    async fn ping_requires_valid_token() {
        let denied = dispatch(&request("ping", &"b".repeat(64)), TOKEN, None).await;
        assert!(!denied.ok);
        assert_eq!(denied.error.expect("missing error").code, "UNAUTHORIZED");

        let allowed = dispatch(&request("ping", TOKEN), TOKEN, None).await;
        assert!(allowed.ok);
        assert_eq!(
            allowed
                .result
                .and_then(|value| value.get("pong").cloned()),
            Some(Value::Bool(true))
        );
    }

    #[tokio::test]
    async fn unknown_methods_are_rejected() {
        let response = dispatch(&request("shell.exec", TOKEN), TOKEN, None).await;
        assert!(!response.ok);
        assert_eq!(
            response.error.expect("missing error").code,
            "METHOD_NOT_FOUND"
        );
    }

    #[tokio::test]
    async fn malformed_json_is_rejected_without_panicking() {
        let response = dispatch(b"{not-json", TOKEN, None).await;
        assert!(!response.ok);
        assert_eq!(response.error.expect("missing error").code, "INVALID_JSON");
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
    async fn current_user_named_pipe_round_trip_ping() {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        let pipe_name = format!(r"\\.\pipe\cmux-automation-test-{}-{nanos}", process::id());
        let (_, mut descriptor) =
            SecurityDescriptor::for_current_user().expect("descriptor should build");
        let server = create_server_instance(
            &pipe_name,
            true,
            descriptor.as_raw_attributes(),
        )
        .expect("server pipe should be created");
        drop(descriptor);

        let server_task = tokio::spawn(async move {
            server.connect().await.expect("server should connect");
            handle_client(server, TOKEN, None)
                .await
                .expect("server should handle client");
        });

        let mut client = ClientOptions::new()
            .open(&pipe_name)
            .expect("client should open current-user pipe");
        let mut encoded = request("ping", TOKEN);
        encoded.push(b'\n');
        client
            .write_all(&encoded)
            .await
            .expect("client should write request");
        client.flush().await.expect("client should flush request");

        let mut reader = BufReader::new(client);
        let mut line = Vec::new();
        timeout(Duration::from_secs(5), reader.read_until(b'\n', &mut line))
            .await
            .expect("response timed out")
            .expect("response read failed");
        let response: AutomationResponse =
            serde_json::from_slice(&line).expect("response should be valid JSON");
        assert!(response.ok);

        drop(reader);
        timeout(Duration::from_secs(5), server_task)
            .await
            .expect("server task did not stop")
            .expect("server task panicked");
    }
}
