#![cfg(windows)]

use serde_json::json;
use std::{io, process};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::windows::named_pipe::{NamedPipeServer, ServerOptions},
};

use super::{
    config::{load_or_create, pipe_name_for_sid},
    protocol::{
        token_matches, validate_request, AutomationRequest, AutomationResponse,
        MAX_REQUEST_BYTES, PROTOCOL_VERSION,
    },
    security::SecurityDescriptor,
};

pub async fn run() -> io::Result<()> {
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
        tokio::spawn(async move {
            if let Err(error) = handle_client(connected, &token).await {
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

async fn handle_client(server: NamedPipeServer, expected_token: &str) -> io::Result<()> {
    let (reader, mut writer) = tokio::io::split(server);
    let mut reader = BufReader::new(reader);

    loop {
        let mut line = Vec::new();
        let read = reader.read_until(b'\n', &mut line).await?;
        if read == 0 {
            return Ok(());
        }

        if line.len() > MAX_REQUEST_BYTES {
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

        while matches!(line.last(), Some(b'\n' | b'\r')) {
            line.pop();
        }

        let response = dispatch(&line, expected_token);
        write_response(&mut writer, &response).await?;
    }
}

fn dispatch(line: &[u8], expected_token: &str) -> AutomationResponse {
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

    match request.method.as_str() {
        "ping" => AutomationResponse::success(request.id, json!({ "pong": true })),
        "app.info" => AutomationResponse::success(
            request.id,
            json!({
                "appVersion": env!("CARGO_PKG_VERSION"),
                "protocolVersion": PROTOCOL_VERSION,
                "processId": process::id(),
            }),
        ),
        _ => AutomationResponse::failure(
            request.id,
            "METHOD_NOT_FOUND",
            "unsupported automation method",
        ),
    }
}

async fn write_response<W>(writer: &mut W, response: &AutomationResponse) -> io::Result<()>
where
    W: AsyncWriteExt + Unpin,
{
    let mut encoded = serde_json::to_vec(response).map_err(io::Error::other)?;
    encoded.push(b'\n');
    writer.write_all(&encoded).await?;
    writer.flush().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

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

    #[test]
    fn ping_requires_valid_token() {
        let denied = dispatch(&request("ping", &"b".repeat(64)), TOKEN);
        assert!(!denied.ok);
        assert_eq!(denied.error.expect("missing error").code, "UNAUTHORIZED");

        let allowed = dispatch(&request("ping", TOKEN), TOKEN);
        assert!(allowed.ok);
        assert_eq!(
            allowed
                .result
                .and_then(|value| value.get("pong").cloned()),
            Some(Value::Bool(true))
        );
    }

    #[test]
    fn unknown_methods_are_rejected() {
        let response = dispatch(&request("shell.exec", TOKEN), TOKEN);
        assert!(!response.ok);
        assert_eq!(
            response.error.expect("missing error").code,
            "METHOD_NOT_FOUND"
        );
    }

    #[test]
    fn malformed_json_is_rejected_without_panicking() {
        let response = dispatch(b"{not-json", TOKEN);
        assert!(!response.ok);
        assert_eq!(response.error.expect("missing error").code, "INVALID_JSON");
    }
}
