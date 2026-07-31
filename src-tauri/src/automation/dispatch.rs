#![cfg(windows)]

use crate::terminal::AppState;
use serde_json::{json, to_value};
use std::process;
use tauri::{AppHandle, Manager};

use super::{
    bridge::{request as bridge_request, AutomationBridge},
    event_methods::prepare_event_method,
    events::AutomationEventStore,
    methods::prepare_frontend_method,
    protocol::{
        token_matches, validate_request, AutomationRequest, AutomationResponse,
        PROTOCOL_VERSION,
    },
    terminal_methods::{prepare_terminal_method, PreparedTerminalMethod},
};

pub(crate) async fn dispatch(
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
        _ => match prepare_terminal_method(&method, params.clone()) {
            Err(error) => AutomationResponse::failure(request_id, error.code, error.message),
            Ok(Some(prepared)) => dispatch_terminal_method(request_id, app, prepared).await,
            Ok(None) => match prepare_event_method(&method, params.clone()) {
                Err(error) => AutomationResponse::failure(request_id, error.code, error.message),
                Ok(Some(prepared)) => dispatch_event_read(request_id, app, prepared).await,
                Ok(None) => dispatch_frontend_method(request_id, app, &method, params).await,
            },
        },
    }
}

async fn dispatch_terminal_method(
    request_id: String,
    app: Option<&AppHandle>,
    prepared: PreparedTerminalMethod,
) -> AutomationResponse {
    let Some(app) = app else {
        return AutomationResponse::failure(
            request_id,
            "INTERNAL_ERROR",
            "terminal automation state is not available",
        );
    };
    let state = app.state::<AppState>();

    match prepared {
        PreparedTerminalMethod::Write { session_id, data } => {
            match state.automation_write_terminal(&session_id, &data) {
                Ok(bytes_written) => AutomationResponse::success(
                    request_id,
                    json!({
                        "sessionId": session_id,
                        "bytesWritten": bytes_written,
                    }),
                ),
                Err(error) => AutomationResponse::failure(
                    request_id,
                    terminal_error_code(&error),
                    error,
                ),
            }
        }
        PreparedTerminalMethod::Read {
            session_id,
            after_seq,
            max_bytes,
            wait_ms,
        } => match state
            .automation_read_terminal(&session_id, after_seq, max_bytes, wait_ms)
            .await
        {
            Ok(result) => serialize_success(request_id, result, "terminal output"),
            Err(error) => AutomationResponse::failure(
                request_id,
                terminal_error_code(&error),
                error,
            ),
        },
    }
}

async fn dispatch_event_read(
    request_id: String,
    app: Option<&AppHandle>,
    prepared: super::event_methods::PreparedEventRead,
) -> AutomationResponse {
    let Some(app) = app else {
        return AutomationResponse::failure(
            request_id,
            "INTERNAL_ERROR",
            "automation event state is not available",
        );
    };
    let store = app.state::<AutomationEventStore>();
    match store
        .read(prepared.after_seq, prepared.max_events, prepared.wait_ms)
        .await
    {
        Ok(result) => serialize_success(request_id, result, "automation events"),
        Err(error) => AutomationResponse::failure(request_id, "INTERNAL_ERROR", error),
    }
}

async fn dispatch_frontend_method(
    request_id: String,
    app: Option<&AppHandle>,
    method: &str,
    params: serde_json::Value,
) -> AutomationResponse {
    match prepare_frontend_method(method, params) {
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
            match bridge_request(app, bridge.inner(), method, params).await {
                Ok(result) => AutomationResponse::success(request_id, result),
                Err(error) => AutomationResponse::failure(request_id, error.code, error.message),
            }
        }
    }
}

fn serialize_success<T>(request_id: String, value: T, label: &str) -> AutomationResponse
where
    T: serde::Serialize,
{
    match to_value(value) {
        Ok(value) => AutomationResponse::success(request_id, value),
        Err(error) => AutomationResponse::failure(
            request_id,
            "INTERNAL_ERROR",
            format!("unable to serialize {label}: {error}"),
        ),
    }
}

fn terminal_error_code(error: &str) -> &'static str {
    if error.starts_with("terminal session not found:") {
        "TERMINAL_NOT_FOUND"
    } else if error.contains("poisoned") {
        "INTERNAL_ERROR"
    } else {
        "TERMINAL_IO_ERROR"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const TOKEN: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    fn request(method: &str, token: &str, params: Value) -> Vec<u8> {
        serde_json::to_vec(&json!({
            "version": 1,
            "id": "request-1",
            "token": token,
            "method": method,
            "params": params,
        }))
        .expect("request should serialize")
    }

    #[tokio::test]
    async fn ping_requires_valid_token() {
        let denied = dispatch(&request("ping", &"b".repeat(64), json!({})), TOKEN, None).await;
        assert!(!denied.ok);
        assert_eq!(denied.error.expect("missing error").code, "UNAUTHORIZED");

        let allowed = dispatch(&request("ping", TOKEN, json!({})), TOKEN, None).await;
        assert!(allowed.ok);
        assert_eq!(
            allowed
                .result
                .and_then(|value| value.get("pong").cloned()),
            Some(Value::Bool(true))
        );
    }

    #[tokio::test]
    async fn stateful_methods_require_runtime_state() {
        for (method, params) in [
            ("terminal.read", json!({ "sessionId": "pane-1" })),
            ("event.read", json!({})),
        ] {
            let response = dispatch(&request(method, TOKEN, params), TOKEN, None).await;
            assert!(!response.ok);
            assert_eq!(response.error.expect("missing error").code, "INTERNAL_ERROR");
        }
    }

    #[tokio::test]
    async fn unknown_and_malformed_methods_are_rejected() {
        let unknown = dispatch(
            &request("shell.exec", TOKEN, json!({})),
            TOKEN,
            None,
        )
        .await;
        assert_eq!(unknown.error.expect("missing error").code, "METHOD_NOT_FOUND");

        let malformed = dispatch(b"{not-json", TOKEN, None).await;
        assert_eq!(malformed.error.expect("missing error").code, "INVALID_JSON");
    }

    #[test]
    fn classifies_terminal_errors_without_leaking_internal_codes() {
        assert_eq!(
            terminal_error_code("terminal session not found: pane-1"),
            "TERMINAL_NOT_FOUND"
        );
        assert_eq!(
            terminal_error_code("terminal writer lock is poisoned"),
            "INTERNAL_ERROR"
        );
        assert_eq!(
            terminal_error_code("unable to write to terminal: broken pipe"),
            "TERMINAL_IO_ERROR"
        );
    }
}
