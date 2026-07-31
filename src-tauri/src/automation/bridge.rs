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
use tauri::{AppHandle, Emitter, State};
use tokio::{sync::oneshot, time::timeout};

const BRIDGE_TIMEOUT: Duration = Duration::from_secs(5);
const AUTOMATION_REQUEST_EVENT: &str = "automation-request";

#[derive(Default)]
pub struct AutomationBridge {
    next_command_id: AtomicU64,
    pending: Mutex<HashMap<u64, oneshot::Sender<FrontendAutomationResolution>>>,
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

    bridge
        .pending
        .lock()
        .map_err(|_| BridgeError::internal("automation bridge lock is poisoned"))?
        .insert(command_id, sender);

    let payload = FrontendAutomationRequest {
        command_id,
        method: method.to_owned(),
        params,
    };

    if let Err(error) = app.emit(AUTOMATION_REQUEST_EVENT, payload) {
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
            code: leak_error_code(resolution.error_code.as_deref().unwrap_or("UI_ERROR")),
            message: resolution
                .error_message
                .unwrap_or_else(|| "workspace UI rejected the automation command".to_owned()),
        })
    }
}

#[tauri::command]
pub fn resolve_automation_request(
    bridge: State<'_, AutomationBridge>,
    resolution: FrontendAutomationResolution,
) -> Result<(), String> {
    let sender = bridge
        .pending
        .lock()
        .map_err(|_| "automation bridge lock is poisoned".to_owned())?
        .remove(&resolution.command_id);

    // A late response after timeout or frontend reload is intentionally ignored.
    if let Some(sender) = sender {
        let _ = sender.send(resolution);
    }

    Ok(())
}

fn remove_pending(bridge: &AutomationBridge, command_id: u64) {
    if let Ok(mut pending) = bridge.pending.lock() {
        pending.remove(&command_id);
    }
}

fn leak_error_code(code: &str) -> &'static str {
    match code {
        "INVALID_REQUEST" => "INVALID_REQUEST",
        "WORKSPACE_NOT_FOUND" => "WORKSPACE_NOT_FOUND",
        "PANE_NOT_FOUND" => "PANE_NOT_FOUND",
        "LAST_WORKSPACE_PROTECTED" => "LAST_WORKSPACE_PROTECTED",
        _ => "UI_ERROR",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frontend_error_codes_are_allowlisted() {
        assert_eq!(leak_error_code("WORKSPACE_NOT_FOUND"), "WORKSPACE_NOT_FOUND");
        assert_eq!(leak_error_code("UNTRUSTED_DYNAMIC_CODE"), "UI_ERROR");
    }
}
