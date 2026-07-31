use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_REQUEST_BYTES: usize = 64 * 1024;
pub const MAX_REQUEST_ID_CHARS: usize = 128;

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRequest {
    pub version: u32,
    pub id: String,
    pub token: String,
    pub method: String,
    #[serde(default = "default_params")]
    pub params: Value,
}

fn default_params() -> Value {
    json!({})
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationResponse {
    pub version: u32,
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<AutomationError>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutomationError {
    pub code: String,
    pub message: String,
}

impl AutomationResponse {
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            ok: true,
            result: Some(result),
            error: None,
        }
    }

    pub fn failure(
        id: impl Into<String>,
        code: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            version: PROTOCOL_VERSION,
            id: id.into(),
            ok: false,
            result: None,
            error: Some(AutomationError {
                code: code.into(),
                message: message.into(),
            }),
        }
    }
}

pub fn validate_request(request: &AutomationRequest) -> Result<(), AutomationResponse> {
    if request.version != PROTOCOL_VERSION {
        return Err(AutomationResponse::failure(
            request.id.clone(),
            "UNSUPPORTED_VERSION",
            format!(
                "unsupported protocol version {}; expected {}",
                request.version, PROTOCOL_VERSION
            ),
        ));
    }

    let id_chars = request.id.chars().count();
    if id_chars == 0 || id_chars > MAX_REQUEST_ID_CHARS {
        return Err(AutomationResponse::failure(
            request.id.clone(),
            "INVALID_REQUEST",
            format!(
                "request id must contain 1 to {MAX_REQUEST_ID_CHARS} characters"
            ),
        ));
    }

    if request.method.trim().is_empty() || request.method.len() > 128 {
        return Err(AutomationResponse::failure(
            request.id.clone(),
            "INVALID_REQUEST",
            "method must contain 1 to 128 bytes",
        ));
    }

    if !request.params.is_object() {
        return Err(AutomationResponse::failure(
            request.id.clone(),
            "INVALID_REQUEST",
            "params must be a JSON object",
        ));
    }

    Ok(())
}

pub fn token_matches(expected: &str, provided: &str) -> bool {
    if expected.len() != provided.len() {
        return false;
    }

    expected
        .as_bytes()
        .iter()
        .zip(provided.as_bytes())
        .fold(0_u8, |difference, (left, right)| difference | (left ^ right))
        == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request() -> AutomationRequest {
        AutomationRequest {
            version: PROTOCOL_VERSION,
            id: "request-1".to_owned(),
            token: "a".repeat(64),
            method: "ping".to_owned(),
            params: json!({}),
        }
    }

    #[test]
    fn rejects_unsupported_protocol_versions() {
        let mut value = request();
        value.version = 2;

        let response = validate_request(&value).expect_err("version should be rejected");
        assert_eq!(response.error.expect("missing error").code, "UNSUPPORTED_VERSION");
    }

    #[test]
    fn rejects_non_object_params() {
        let mut value = request();
        value.params = json!(["unexpected"]);

        let response = validate_request(&value).expect_err("params should be rejected");
        assert_eq!(response.error.expect("missing error").code, "INVALID_REQUEST");
    }

    #[test]
    fn compares_tokens_without_early_character_exit() {
        assert!(token_matches("abcdef", "abcdef"));
        assert!(!token_matches("abcdef", "abcdeg"));
        assert!(!token_matches("abcdef", "short"));
    }

    #[test]
    fn response_omits_unused_payload_fields() {
        let success = serde_json::to_value(AutomationResponse::success("1", json!({"ok": true})))
            .expect("success response should serialize");
        assert!(success.get("result").is_some());
        assert!(success.get("error").is_none());

        let failure = serde_json::to_value(AutomationResponse::failure(
            "1",
            "INVALID_REQUEST",
            "bad request",
        ))
        .expect("failure response should serialize");
        assert!(failure.get("result").is_none());
        assert!(failure.get("error").is_some());
    }
}
