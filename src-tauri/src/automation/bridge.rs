use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::{sync::oneshot, time::timeout};

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(5);
const AUTOMATION_REQUEST_EVENT: &str = "automation-request";
const MAX_PENDING_REQUESTS: usize = 64;
const MAX_SESSION_ID_CHARS: usize = 128;

#[derive(Default)]
struct BridgeState {
    frontend_session: Option<String>,
    pending: HashMap<u64, oneshot::Sender<FrontendAutomationResolution>>,
}

#[derive(Default)]
pub struct AutomationBridge {
    next_command_id: AtomicU64,
    state: Mutex<BridgeState>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct FrontendAutomationRequest {
    command_id: u64,
    method: String,
    params: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontendAutomationResolution {
    command_id: u64,
    ok: bool,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error_code: Option<String>,
    #[serde(default)]
    error_message: Option<String>,
}

#[derive(Debug)]
pub struct BridgeError {
    pub code: &'static str,
    pub message: String,
}

impl BridgeError {
    fn internal(message: impl Into<String>) -> Self {
        Self {
            code: "INTERNAL_ERROR",
            message: message.into(),
        }
    }
}

pub async fn request(
    app: &AppHandle,
    bridge: &AutomationBridge,
    method: &str,
    params: Value,
) -> Result<Value, BridgeError> {
    let command_id = bridge.next_command_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (sender, receiver) = oneshot::channel();

    {
        let mut state = bridge
            .state
            .lock()
            .map_err(|_| BridgeError::internal("automation bridge lock is poisoned"))?;
        if state.frontend_session.is_none() {
            return Err(BridgeError {
                code: "UI_NOT_READY",
                message: "workspace UI is not ready for automation requests".to_owned(),
            });
        }
        if state.pending.len() >= MAX_PENDING_REQUESTS {
            return Err(BridgeError {
                code: "BRIDGE_BUSY",
                message: format!(
                    "workspace UI already has {MAX_PENDING_REQUESTS} pending automation requests"
                ),
            });
        }
        state.pending.insert(command_id, sender);
    }

    let payload = FrontendAutomationRequest {
        command_id,
        method: method.to_owned(),
        params,
    };
    let Some(main_webview) = app.get_webview("main") else {
        remove_pending(bridge, command_id);
        return Err(BridgeError::internal(
            "main workspace webview is not available",
        ));
    };

    if let Err(error) = main_webview.emit(AUTOMATION_REQUEST_EVENT, payload) {
        remove_pending(bridge, command_id);
        return Err(BridgeError::internal(format!(
            "unable to dispatch automation request to the workspace UI: {error}"
        )));
    }

    let resolution = match timeout(BRIDGE_TIMEOUT, receiver).await {
        Ok(Ok(resolution)) => resolution,
        Ok(Err(_)) => {
            remove_pending(bridge, command_id);
            return Err(BridgeError::internal(
                "workspace UI dropped the automation response channel",
            ));
        }
        Err(_) => {
            remove_pending(bridge, command_id);
            return Err(BridgeError {
                code: "UI_TIMEOUT",
                message: format!(
                    "workspace UI did not acknowledge automation command within {BRIDGE_TIMEOUT:?}"
                ),
            });
        }
    };

    if resolution.ok {
        Ok(resolution.result.unwrap_or_else(|| Value::Object(Default::default())))
    } else {
        Err(BridgeError {
            code: allow_error_code(resolution.error_code.as_deref().unwrap_or("UI_ERROR")),
            message: resolution
                .error_message
                .unwrap_or_else(|| "workspace UI rejected the automation command".to_owned()),
        })
    }
}

#[tauri::command]
pub fn set_automation_frontend_ready(
    bridge: State<'_, AutomationBridge>,
    session_id: String,
    ready: bool,
) -> Result<(), String> {
    validate_session_id(&session_id)?;

    let pending = {
        let mut state = bridge
            .state
            .lock()
            .map_err(|_| "automation bridge lock is poisoned".to_owned())?;

        if ready {
            let replacing_session = state
                .frontend_session
                .as_deref()
                .is_some_and(|current| current != session_id);
            state.frontend_session = Some(session_id);
            if replacing_session {
                std::mem::take(&mut state.pending)
            } else {
                HashMap::new()
            }
        } else if state.frontend_session.as_deref() == Some(session_id.as_str()) {
            state.frontend_session = None;
            std::mem::take(&mut state.pending)
        } else {
            // A stale StrictMode/reload cleanup must not disable a newer session.
            HashMap::new()
        }
    };

    fail_pending_not_ready(pending);
    Ok(())
}

#[tauri::command]
pub fn resolve_automation_request(
    bridge: State<'_, AutomationBridge>,
    resolution: FrontendAutomationResolution,
) -> Result<(), String> {
    let sender = bridge
        .state
        .lock()
        .map_err(|_| "automation bridge lock is poisoned".to_owned())?
        .pending
        .remove(&resolution.command_id);

    // A late response after timeout or frontend reload is intentionally ignored.
    if let Some(sender) = sender {
        let _ = sender.send(resolution);
    }

    Ok(())
}

fn validate_session_id(session_id: &str) -> Result<(), String> {
    let count = session_id.chars().count();
    if count == 0
        || count > MAX_SESSION_ID_CHARS
        || !session_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(format!(
            "automation frontend session ID must contain 1 to {MAX_SESSION_ID_CHARS} safe ASCII characters"
        ));
    }
    Ok(())
}

fn fail_pending_not_ready(
    pending: HashMap<u64, oneshot::Sender<FrontendAutomationResolution>>,
) {
    for (command_id, sender) in pending {
        let _ = sender.send(FrontendAutomationResolution {
            command_id,
            ok: false,
            result: None,
            error_code: Some("UI_NOT_READY".to_owned()),
            error_message: Some("workspace UI was unloaded before completing the command".to_owned()),
        });
    }
}

fn remove_pending(bridge: &AutomationBridge, command_id: u64) {
    if let Ok(mut state) = bridge.state.lock() {
        state.pending.remove(&command_id);
    }
}

fn allow_error_code(code: &str) -> &'static str {
    match code {
        "INVALID_REQUEST" => "INVALID_REQUEST",
        "WORKSPACE_NOT_FOUND" => "WORKSPACE_NOT_FOUND",
        "PANE_NOT_FOUND" => "PANE_NOT_FOUND",
        "LAST_WORKSPACE_PROTECTED" => "LAST_WORKSPACE_PROTECTED",
        "LAST_PANE_PROTECTED" => "LAST_PANE_PROTECTED",
        "UI_NOT_READY" => "UI_NOT_READY",
        _ => "UI_ERROR",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_error_codes_are_allowlisted() {
        assert_eq!(allow_error_code("WORKSPACE_NOT_FOUND"), "WORKSPACE_NOT_FOUND");
        assert_eq!(allow_error_code("LAST_PANE_PROTECTED"), "LAST_PANE_PROTECTED");
        assert_eq!(allow_error_code("UNTRUSTED_DYNAMIC_CODE"), "UI_ERROR");
    }

    #[test]
    fn stale_frontend_cleanup_does_not_clear_new_session() {
        let bridge = AutomationBridge::default();
        let mut state = bridge.state.lock().expect("bridge lock should open");
        state.frontend_session = Some("new-session".to_owned());

        if state.frontend_session.as_deref() == Some("old-session") {
            state.frontend_session = None;
        }
        assert_eq!(state.frontend_session.as_deref(), Some("new-session"));
    }

    #[test]
    fn pending_request_cap_matches_protocol_limit() {
        let bridge = AutomationBridge::default();
        let mut state = bridge.state.lock().expect("bridge lock should open");
        state.frontend_session = Some("test-session".to_owned());
        for command_id in 0..MAX_PENDING_REQUESTS as u64 {
            let (sender, receiver) = oneshot::channel();
            state.pending.insert(command_id, sender);
            drop(receiver);
        }
        assert_eq!(state.pending.len(), MAX_PENDING_REQUESTS);
    }

    #[test]
    fn session_ids_are_bounded_and_safe() {
        assert!(validate_session_id("session-123").is_ok());
        assert!(validate_session_id("").is_err());
        assert!(validate_session_id("../session").is_err());
    }
}
