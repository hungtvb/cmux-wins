use crate::terminal_automation::{MAX_READ_BYTES, MAX_WAIT_MS, MIN_READ_BYTES};
use serde::Deserialize;
use serde_json::Value;

const MAX_IDENTIFIER_CHARS: usize = 128;
const MAX_TERMINAL_INPUT_BYTES: usize = 16 * 1024;
const DEFAULT_READ_BYTES: usize = MAX_READ_BYTES;

#[derive(Debug, PartialEq)]
pub(crate) enum PreparedTerminalMethod {
    Write {
        session_id: String,
        data: String,
    },
    Read {
        session_id: String,
        after_seq: u64,
        max_bytes: usize,
        wait_ms: u64,
    },
}

#[derive(Debug)]
pub(crate) struct TerminalMethodError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl TerminalMethodError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_REQUEST",
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WriteParams {
    session_id: String,
    data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadParams {
    session_id: String,
    #[serde(default)]
    after_seq: u64,
    #[serde(default = "default_read_bytes")]
    max_bytes: usize,
    #[serde(default)]
    wait_ms: u64,
}

pub(crate) fn prepare_terminal_method(
    method: &str,
    params: Value,
) -> Result<Option<PreparedTerminalMethod>, TerminalMethodError> {
    match method {
        "terminal.write" => {
            let input: WriteParams = parse(params)?;
            let session_id = validate_identifier("sessionId", &input.session_id)?;
            if input.data.is_empty() || input.data.len() > MAX_TERMINAL_INPUT_BYTES {
                return Err(TerminalMethodError::invalid(format!(
                    "data must contain 1 to {MAX_TERMINAL_INPUT_BYTES} UTF-8 bytes"
                )));
            }
            if input.data.as_bytes().contains(&0) {
                return Err(TerminalMethodError::invalid(
                    "data must not contain NUL bytes",
                ));
            }
            Ok(Some(PreparedTerminalMethod::Write {
                session_id,
                data: input.data,
            }))
        }
        "terminal.read" => {
            let input: ReadParams = parse(params)?;
            let session_id = validate_identifier("sessionId", &input.session_id)?;
            if !(MIN_READ_BYTES..=MAX_READ_BYTES).contains(&input.max_bytes) {
                return Err(TerminalMethodError::invalid(format!(
                    "maxBytes must be between {MIN_READ_BYTES} and {MAX_READ_BYTES}"
                )));
            }
            if input.wait_ms > MAX_WAIT_MS {
                return Err(TerminalMethodError::invalid(format!(
                    "waitMs must be between 0 and {MAX_WAIT_MS}"
                )));
            }
            Ok(Some(PreparedTerminalMethod::Read {
                session_id,
                after_seq: input.after_seq,
                max_bytes: input.max_bytes,
                wait_ms: input.wait_ms,
            }))
        }
        _ => Ok(None),
    }
}

fn parse<T>(params: Value) -> Result<T, TerminalMethodError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(params).map_err(|error| {
        TerminalMethodError::invalid(format!("invalid terminal method params: {error}"))
    })
}

fn validate_identifier(name: &str, value: &str) -> Result<String, TerminalMethodError> {
    let value = value.trim();
    let count = value.chars().count();
    if count == 0
        || count > MAX_IDENTIFIER_CHARS
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(TerminalMethodError::invalid(format!(
            "{name} must contain 1 to {MAX_IDENTIFIER_CHARS} safe ASCII characters"
        )));
    }
    Ok(value.to_owned())
}

fn default_read_bytes() -> usize {
    DEFAULT_READ_BYTES
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn accepts_control_input_but_rejects_nul_and_oversized_data() {
        assert_eq!(
            prepare_terminal_method(
                "terminal.write",
                json!({ "sessionId": "pane-1", "data": "\u{3}" })
            )
            .expect("control input should parse"),
            Some(PreparedTerminalMethod::Write {
                session_id: "pane-1".to_owned(),
                data: "\u{3}".to_owned(),
            })
        );
        assert!(prepare_terminal_method(
            "terminal.write",
            json!({ "sessionId": "pane-1", "data": "\0" })
        )
        .is_err());
        assert!(prepare_terminal_method(
            "terminal.write",
            json!({ "sessionId": "pane-1", "data": "x".repeat(MAX_TERMINAL_INPUT_BYTES + 1) })
        )
        .is_err());
    }

    #[test]
    fn applies_bounded_read_defaults() {
        assert_eq!(
            prepare_terminal_method(
                "terminal.read",
                json!({ "sessionId": "pane-1", "afterSeq": 8, "waitMs": 30_000 })
            )
            .expect("read should parse"),
            Some(PreparedTerminalMethod::Read {
                session_id: "pane-1".to_owned(),
                after_seq: 8,
                max_bytes: DEFAULT_READ_BYTES,
                wait_ms: 30_000,
            })
        );
    }

    #[test]
    fn rejects_unknown_fields_and_out_of_range_read_limits() {
        assert!(prepare_terminal_method(
            "terminal.read",
            json!({ "sessionId": "pane-1", "unknown": true })
        )
        .is_err());
        assert!(prepare_terminal_method(
            "terminal.read",
            json!({ "sessionId": "pane-1", "maxBytes": 512 })
        )
        .is_err());
        assert!(prepare_terminal_method(
            "terminal.read",
            json!({ "sessionId": "pane-1", "waitMs": MAX_WAIT_MS + 1 })
        )
        .is_err());
    }
}
