use super::events::{MAX_EVENT_READ_COUNT, MAX_EVENT_WAIT_MS};
use serde::Deserialize;
use serde_json::Value;

const DEFAULT_EVENT_READ_COUNT: usize = 50;

#[derive(Debug, PartialEq)]
pub(crate) struct PreparedEventRead {
    pub(crate) after_seq: u64,
    pub(crate) max_events: usize,
    pub(crate) wait_ms: u64,
}

#[derive(Debug)]
pub(crate) struct EventMethodError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl EventMethodError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_REQUEST",
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReadEventParams {
    #[serde(default)]
    after_seq: u64,
    #[serde(default = "default_event_read_count")]
    max_events: usize,
    #[serde(default)]
    wait_ms: u64,
}

pub(crate) fn prepare_event_method(
    method: &str,
    params: Value,
) -> Result<Option<PreparedEventRead>, EventMethodError> {
    if method != "event.read" {
        return Ok(None);
    }

    let input: ReadEventParams = serde_json::from_value(params).map_err(|error| {
        EventMethodError::invalid(format!("invalid event.read params: {error}"))
    })?;
    if !(1..=MAX_EVENT_READ_COUNT).contains(&input.max_events) {
        return Err(EventMethodError::invalid(format!(
            "maxEvents must be between 1 and {MAX_EVENT_READ_COUNT}"
        )));
    }
    if input.wait_ms > MAX_EVENT_WAIT_MS {
        return Err(EventMethodError::invalid(format!(
            "waitMs must be between 0 and {MAX_EVENT_WAIT_MS}"
        )));
    }

    Ok(Some(PreparedEventRead {
        after_seq: input.after_seq,
        max_events: input.max_events,
        wait_ms: input.wait_ms,
    }))
}

fn default_event_read_count() -> usize {
    DEFAULT_EVENT_READ_COUNT
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn applies_bounded_defaults() {
        assert_eq!(
            prepare_event_method("event.read", json!({ "afterSeq": 7, "waitMs": 30_000 }))
                .expect("params should parse"),
            Some(PreparedEventRead {
                after_seq: 7,
                max_events: DEFAULT_EVENT_READ_COUNT,
                wait_ms: 30_000,
            })
        );
    }

    #[test]
    fn rejects_unknown_fields_and_out_of_range_values() {
        assert!(prepare_event_method("event.read", json!({ "unknown": true })).is_err());
        assert!(prepare_event_method("event.read", json!({ "maxEvents": 0 })).is_err());
        assert!(prepare_event_method(
            "event.read",
            json!({ "maxEvents": MAX_EVENT_READ_COUNT + 1 })
        )
        .is_err());
        assert!(prepare_event_method(
            "event.read",
            json!({ "waitMs": MAX_EVENT_WAIT_MS + 1 })
        )
        .is_err());
    }
}
