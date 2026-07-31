use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::State;
use tokio::{
    sync::Notify,
    time::{timeout, Instant},
};

pub(crate) const MAX_EVENT_RECORDS: usize = 1024;
pub(crate) const MAX_EVENT_PAYLOAD_BYTES: usize = 8 * 1024;
pub(crate) const MAX_EVENT_READ_COUNT: usize = 100;
pub(crate) const MAX_EVENT_WAIT_MS: u64 = 30_000;
const MAX_EVENT_READ_BYTES: usize = 32 * 1024;
const MAX_FRONTEND_EVENT_BATCH: usize = 64;
const MAX_IDENTIFIER_CHARS: usize = 128;
const MAX_EVENT_TEXT_CHARS: usize = 1024;
const MAX_EVENT_KIND_BYTES: usize = 64;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationEvent {
    pub(crate) seq: u64,
    pub(crate) timestamp_ms: u64,
    pub(crate) kind: String,
    pub(crate) payload: Value,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AutomationEventReadResult {
    pub(crate) events: Vec<AutomationEvent>,
    pub(crate) next_seq: u64,
    pub(crate) earliest_seq: u64,
    pub(crate) latest_seq: u64,
    pub(crate) dropped: bool,
    pub(crate) has_more: bool,
}

#[derive(Default)]
struct EventState {
    records: VecDeque<AutomationEvent>,
    next_seq: u64,
}

#[derive(Default)]
pub(crate) struct AutomationEventStore {
    state: Mutex<EventState>,
    changed: Notify,
}

impl AutomationEventStore {
    pub(crate) fn publish(
        &self,
        kind: impl Into<String>,
        payload: Value,
    ) -> Result<u64, String> {
        let kind = validate_event_kind(kind.into())?;
        let payload_bytes = serde_json::to_vec(&payload)
            .map_err(|error| format!("unable to serialize automation event payload: {error}"))?;
        if payload_bytes.len() > MAX_EVENT_PAYLOAD_BYTES {
            return Err(format!(
                "automation event payload exceeds {MAX_EVENT_PAYLOAD_BYTES} bytes"
            ));
        }

        let mut state = self
            .state
            .lock()
            .map_err(|_| "automation event store is poisoned".to_owned())?;
        state.next_seq = state.next_seq.saturating_add(1).max(1);
        let seq = state.next_seq;
        state.records.push_back(AutomationEvent {
            seq,
            timestamp_ms: unix_timestamp_ms(),
            kind,
            payload,
        });
        while state.records.len() > MAX_EVENT_RECORDS {
            state.records.pop_front();
        }
        drop(state);
        self.changed.notify_waiters();
        Ok(seq)
    }

    pub(crate) fn snapshot(
        &self,
        after_seq: u64,
        max_events: usize,
    ) -> Result<AutomationEventReadResult, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "automation event store is poisoned".to_owned())?;
        let earliest_seq = state
            .records
            .front()
            .map(|event| event.seq)
            .unwrap_or_else(|| state.next_seq.saturating_add(1));
        let latest_seq = state.next_seq;
        let dropped = after_seq.saturating_add(1) < earliest_seq;
        let mut events = Vec::new();
        let mut used_bytes = 0_usize;

        for event in state.records.iter().filter(|event| event.seq > after_seq) {
            if events.len() >= max_events {
                break;
            }
            let event_bytes = serde_json::to_vec(event)
                .map_err(|error| format!("unable to serialize automation event: {error}"))?
                .len();
            if !events.is_empty()
                && used_bytes.saturating_add(event_bytes) > MAX_EVENT_READ_BYTES
            {
                break;
            }
            if events.is_empty() && event_bytes > MAX_EVENT_READ_BYTES {
                return Err(format!(
                    "automation event exceeds read limit ({event_bytes} > {MAX_EVENT_READ_BYTES})"
                ));
            }
            used_bytes = used_bytes.saturating_add(event_bytes);
            events.push(event.clone());
        }

        let next_seq = events
            .last()
            .map(|event| event.seq)
            .unwrap_or_else(|| after_seq.min(latest_seq).max(earliest_seq.saturating_sub(1)));
        let has_more = state.records.iter().any(|event| event.seq > next_seq);

        Ok(AutomationEventReadResult {
            events,
            next_seq,
            earliest_seq,
            latest_seq,
            dropped,
            has_more,
        })
    }

    pub(crate) async fn read(
        &self,
        after_seq: u64,
        max_events: usize,
        wait_ms: u64,
    ) -> Result<AutomationEventReadResult, String> {
        if wait_ms == 0 {
            return self.snapshot(after_seq, max_events);
        }

        let deadline = Instant::now() + Duration::from_millis(wait_ms);
        loop {
            let notified = self.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();

            let current = self.snapshot(after_seq, max_events)?;
            if !current.events.is_empty() {
                return Ok(current);
            }

            let now = Instant::now();
            if now >= deadline {
                return Ok(current);
            }
            if timeout(deadline - now, notified.as_mut()).await.is_err() {
                return self.snapshot(after_seq, max_events);
            }
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum FrontendAutomationEventInput {
    #[serde(rename_all = "camelCase")]
    WorkspaceCreated {
        workspace_id: String,
        title: String,
        cwd: String,
    },
    #[serde(rename_all = "camelCase")]
    WorkspaceClosed { workspace_id: String },
    #[serde(rename_all = "camelCase")]
    WorkspaceSelected { workspace_id: String },
    #[serde(rename_all = "camelCase")]
    PaneCreated {
        workspace_id: String,
        pane_id: String,
        pane_kind: String,
        title: String,
        #[serde(default)]
        url: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PaneUpdated {
        workspace_id: String,
        pane_id: String,
        pane_kind: String,
        title: String,
        #[serde(default)]
        url: Option<String>,
    },
    #[serde(rename_all = "camelCase")]
    PaneClosed {
        workspace_id: String,
        pane_id: String,
        pane_kind: String,
    },
    #[serde(rename_all = "camelCase")]
    AttentionRequested {
        workspace_id: String,
        pane_id: String,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    AttentionCleared {
        workspace_id: String,
        pane_id: String,
    },
}

impl FrontendAutomationEventInput {
    fn into_event(self) -> Result<(&'static str, Value), String> {
        match self {
            Self::WorkspaceCreated {
                workspace_id,
                title,
                cwd,
            } => Ok((
                "workspace.created",
                json!({
                    "workspaceId": validate_identifier("workspaceId", workspace_id)?,
                    "title": validate_text("title", title)?,
                    "cwd": validate_text("cwd", cwd)?,
                }),
            )),
            Self::WorkspaceClosed { workspace_id } => Ok((
                "workspace.closed",
                json!({
                    "workspaceId": validate_identifier("workspaceId", workspace_id)?,
                }),
            )),
            Self::WorkspaceSelected { workspace_id } => Ok((
                "workspace.selected",
                json!({
                    "workspaceId": validate_identifier("workspaceId", workspace_id)?,
                }),
            )),
            Self::PaneCreated {
                workspace_id,
                pane_id,
                pane_kind,
                title,
                url,
            } => pane_event(
                "pane.created",
                workspace_id,
                pane_id,
                pane_kind,
                title,
                url,
            ),
            Self::PaneUpdated {
                workspace_id,
                pane_id,
                pane_kind,
                title,
                url,
            } => pane_event(
                "pane.updated",
                workspace_id,
                pane_id,
                pane_kind,
                title,
                url,
            ),
            Self::PaneClosed {
                workspace_id,
                pane_id,
                pane_kind,
            } => Ok((
                "pane.closed",
                json!({
                    "workspaceId": validate_identifier("workspaceId", workspace_id)?,
                    "paneId": validate_identifier("paneId", pane_id)?,
                    "paneKind": validate_pane_kind(pane_kind)?,
                }),
            )),
            Self::AttentionRequested {
                workspace_id,
                pane_id,
                message,
            } => Ok((
                "attention.requested",
                json!({
                    "workspaceId": validate_identifier("workspaceId", workspace_id)?,
                    "paneId": validate_identifier("paneId", pane_id)?,
                    "message": validate_text("message", message)?,
                }),
            )),
            Self::AttentionCleared {
                workspace_id,
                pane_id,
            } => Ok((
                "attention.cleared",
                json!({
                    "workspaceId": validate_identifier("workspaceId", workspace_id)?,
                    "paneId": validate_identifier("paneId", pane_id)?,
                }),
            )),
        }
    }
}

fn pane_event(
    kind: &'static str,
    workspace_id: String,
    pane_id: String,
    pane_kind: String,
    title: String,
    url: Option<String>,
) -> Result<(&'static str, Value), String> {
    Ok((
        kind,
        json!({
            "workspaceId": validate_identifier("workspaceId", workspace_id)?,
            "paneId": validate_identifier("paneId", pane_id)?,
            "paneKind": validate_pane_kind(pane_kind)?,
            "title": validate_text("title", title)?,
            "url": validate_optional_text("url", url)?,
        }),
    ))
}

#[tauri::command]
pub(crate) fn publish_frontend_automation_events(
    store: State<'_, AutomationEventStore>,
    events: Vec<FrontendAutomationEventInput>,
) -> Result<(), String> {
    if events.len() > MAX_FRONTEND_EVENT_BATCH {
        return Err(format!(
            "frontend automation event batch exceeds {MAX_FRONTEND_EVENT_BATCH} records"
        ));
    }

    let prepared: Result<Vec<_>, _> = events
        .into_iter()
        .map(FrontendAutomationEventInput::into_event)
        .collect();
    for (kind, payload) in prepared? {
        store.publish(kind, payload)?;
    }
    Ok(())
}

fn validate_event_kind(value: String) -> Result<String, String> {
    if value.is_empty()
        || value.len() > MAX_EVENT_KIND_BYTES
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'.')
    {
        return Err(format!(
            "event kind must contain 1 to {MAX_EVENT_KIND_BYTES} lowercase ASCII letters, digits or dots"
        ));
    }
    Ok(value)
}

fn validate_identifier(name: &str, value: String) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_IDENTIFIER_CHARS
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!(
            "{name} must contain 1 to {MAX_IDENTIFIER_CHARS} safe ASCII characters"
        ));
    }
    Ok(value.to_owned())
}

fn validate_text(name: &str, value: String) -> Result<String, String> {
    let value = value.trim();
    if value.chars().count() > MAX_EVENT_TEXT_CHARS
        || value.chars().any(|character| character == '\0')
    {
        return Err(format!(
            "{name} must contain at most {MAX_EVENT_TEXT_CHARS} characters and no NUL bytes"
        ));
    }
    Ok(value.to_owned())
}

fn validate_optional_text(name: &str, value: Option<String>) -> Result<Option<String>, String> {
    value.map(|value| validate_text(name, value)).transpose()
}

fn validate_pane_kind(value: String) -> Result<String, String> {
    match value.as_str() {
        "terminal" | "browser" => Ok(value),
        _ => Err("paneKind must be terminal or browser".to_owned()),
    }
}

fn unix_timestamp_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn journal_is_cursor_based_and_bounded() {
        let store = AutomationEventStore::default();
        for index in 0..(MAX_EVENT_RECORDS + 20) {
            store
                .publish("test.event", json!({ "index": index }))
                .expect("event should publish");
        }

        let first = store.snapshot(0, 10).expect("snapshot should work");
        assert!(first.dropped);
        assert!(first.earliest_seq > 1);
        assert_eq!(first.events.len(), 10);
        assert!(first.has_more);

        let next = store
            .snapshot(first.next_seq, 10)
            .expect("next snapshot should work");
        assert!(next.events.iter().all(|event| event.seq > first.next_seq));
    }

    #[test]
    fn serialized_read_batch_is_bounded() {
        let store = AutomationEventStore::default();
        for index in 0..100 {
            store
                .publish(
                    "test.event",
                    json!({ "index": index, "value": "\u{1b}".repeat(1024) }),
                )
                .expect("event should publish");
        }
        let snapshot = store.snapshot(0, 100).expect("snapshot should work");
        let encoded = serde_json::to_vec(&snapshot).expect("snapshot should serialize");
        assert!(encoded.len() < 64 * 1024);
        assert!(snapshot.has_more);
    }

    #[test]
    fn frontend_event_kinds_and_payloads_are_allowlisted() {
        let (kind, payload) = FrontendAutomationEventInput::AttentionRequested {
            workspace_id: "workspace-1".to_owned(),
            pane_id: "pane-1".to_owned(),
            message: "approval needed".to_owned(),
        }
        .into_event()
        .expect("event should validate");
        assert_eq!(kind, "attention.requested");
        assert_eq!(payload["paneId"], "pane-1");

        let (updated_kind, updated_payload) = FrontendAutomationEventInput::PaneUpdated {
            workspace_id: "workspace-1".to_owned(),
            pane_id: "pane-1".to_owned(),
            pane_kind: "browser".to_owned(),
            title: "Browser".to_owned(),
            url: Some("https://example.com/".to_owned()),
        }
        .into_event()
        .expect("pane update should validate");
        assert_eq!(updated_kind, "pane.updated");
        assert_eq!(updated_payload["url"], "https://example.com/");

        assert!(FrontendAutomationEventInput::PaneCreated {
            workspace_id: "workspace-1".to_owned(),
            pane_id: "pane-1".to_owned(),
            pane_kind: "script".to_owned(),
            title: "Bad".to_owned(),
            url: None,
        }
        .into_event()
        .is_err());
        assert!(validate_event_kind("Terminal.Started".to_owned()).is_err());
    }

    #[test]
    fn oversized_payload_is_rejected() {
        let store = AutomationEventStore::default();
        assert!(store
            .publish("test.event", json!({ "value": "x".repeat(MAX_EVENT_PAYLOAD_BYTES) }))
            .is_err());
    }

    #[tokio::test]
    async fn long_poll_wakes_on_event() {
        let store = std::sync::Arc::new(AutomationEventStore::default());
        let reader_store = store.clone();
        let reader = tokio::spawn(async move {
            reader_store
                .read(0, 10, 5_000)
                .await
                .expect("read should work")
        });

        tokio::task::yield_now().await;
        store
            .publish("test.event", json!({ "ok": true }))
            .expect("event should publish");
        let result = reader.await.expect("reader should finish");
        assert_eq!(result.events.len(), 1);
        assert_eq!(result.events[0].kind, "test.event");
    }
}
