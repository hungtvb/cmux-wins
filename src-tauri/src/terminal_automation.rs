use serde::Serialize;
use std::{
    collections::{HashMap, VecDeque},
    sync::Mutex,
    time::Duration,
};
use tokio::{sync::Notify, time::timeout};

pub(crate) const MAX_TRANSCRIPT_BYTES: usize = 256 * 1024;
pub(crate) const MAX_TERMINAL_RECORDS: usize = 128;
pub(crate) const MIN_READ_BYTES: usize = 1024;
pub(crate) const MAX_READ_BYTES: usize = 8 * 1024;
pub(crate) const MAX_WAIT_MS: u64 = 30_000;
const MAX_STORED_CHUNK_BYTES: usize = MIN_READ_BYTES;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalOutputChunk {
    pub(crate) seq: u64,
    pub(crate) data: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TerminalLifecycleStatus {
    Running,
    Exited,
    Closed,
    Error,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TerminalReadResult {
    pub(crate) session_id: String,
    pub(crate) workspace_id: String,
    pub(crate) chunks: Vec<TerminalOutputChunk>,
    pub(crate) next_seq: u64,
    pub(crate) earliest_seq: u64,
    pub(crate) latest_seq: u64,
    pub(crate) dropped: bool,
    pub(crate) has_more: bool,
    pub(crate) status: TerminalLifecycleStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) exit_code: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<String>,
}

#[derive(Debug)]
struct TerminalRecord {
    workspace_id: String,
    generation: u64,
    chunks: VecDeque<TerminalOutputChunk>,
    total_bytes: usize,
    next_seq: u64,
    status: TerminalLifecycleStatus,
    exit_code: Option<u32>,
    error: Option<String>,
}

#[derive(Default)]
struct StoreState {
    records: HashMap<String, TerminalRecord>,
    order: VecDeque<(String, u64)>,
    next_generation: u64,
}

#[derive(Default)]
pub(crate) struct TerminalAutomationStore {
    state: Mutex<StoreState>,
    changed: Notify,
}

impl TerminalAutomationStore {
    pub(crate) fn begin_session(
        &self,
        session_id: &str,
        workspace_id: &str,
    ) -> Result<u64, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "terminal automation store is poisoned".to_owned())?;
        prune_records(&mut state);
        if !state.records.contains_key(session_id)
            && state.records.len() >= MAX_TERMINAL_RECORDS
        {
            return Err(format!(
                "terminal automation record limit reached: {MAX_TERMINAL_RECORDS}"
            ));
        }

        state.next_generation = state.next_generation.wrapping_add(1).max(1);
        let generation = state.next_generation;
        state.records.insert(
            session_id.to_owned(),
            TerminalRecord {
                workspace_id: workspace_id.to_owned(),
                generation,
                chunks: VecDeque::new(),
                total_bytes: 0,
                next_seq: 1,
                status: TerminalLifecycleStatus::Running,
                exit_code: None,
                error: None,
            },
        );
        state.order.push_back((session_id.to_owned(), generation));
        drop(state);
        self.changed.notify_waiters();
        Ok(generation)
    }

    pub(crate) fn record_output(&self, session_id: &str, generation: u64, data: String) {
        if data.is_empty() {
            return;
        }

        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        let Some(record) = state.records.get_mut(session_id) else {
            return;
        };
        if record.generation != generation || record.status != TerminalLifecycleStatus::Running {
            return;
        }

        for segment in split_utf8_chunks(&data, MAX_STORED_CHUNK_BYTES) {
            let bytes = segment.len();
            let seq = record.next_seq;
            record.next_seq = record.next_seq.saturating_add(1);
            record.total_bytes = record.total_bytes.saturating_add(bytes);
            record.chunks.push_back(TerminalOutputChunk {
                seq,
                data: segment.to_owned(),
            });
        }

        while record.total_bytes > MAX_TRANSCRIPT_BYTES && record.chunks.len() > 1 {
            if let Some(chunk) = record.chunks.pop_front() {
                record.total_bytes = record.total_bytes.saturating_sub(chunk.data.len());
            }
        }
        drop(state);
        self.changed.notify_waiters();
    }

    pub(crate) fn finish_session(
        &self,
        session_id: &str,
        generation: u64,
        status: TerminalLifecycleStatus,
        exit_code: Option<u32>,
        error: Option<String>,
    ) {
        let mut state = match self.state.lock() {
            Ok(state) => state,
            Err(_) => return,
        };
        let Some(record) = state.records.get_mut(session_id) else {
            return;
        };
        if record.generation != generation || record.status != TerminalLifecycleStatus::Running {
            return;
        }

        record.status = status;
        record.exit_code = exit_code;
        record.error = error;
        prune_records(&mut state);
        drop(state);
        self.changed.notify_waiters();
    }

    pub(crate) fn snapshot(
        &self,
        session_id: &str,
        after_seq: u64,
        max_bytes: usize,
    ) -> Result<TerminalReadResult, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "terminal automation store is poisoned".to_owned())?;
        let record = state
            .records
            .get(session_id)
            .ok_or_else(|| format!("terminal session not found: {session_id}"))?;

        let earliest_seq = record
            .chunks
            .front()
            .map(|chunk| chunk.seq)
            .unwrap_or(record.next_seq);
        let latest_seq = record.next_seq.saturating_sub(1);
        let dropped = after_seq.saturating_add(1) < earliest_seq;
        let mut chunks = Vec::new();
        let mut used = 0_usize;

        for chunk in record.chunks.iter().filter(|chunk| chunk.seq > after_seq) {
            let bytes = chunk.data.len();
            if !chunks.is_empty() && used.saturating_add(bytes) > max_bytes {
                break;
            }
            if chunks.is_empty() && bytes > max_bytes {
                return Err(format!(
                    "terminal output chunk exceeds requested maxBytes ({bytes} > {max_bytes})"
                ));
            }
            used = used.saturating_add(bytes);
            chunks.push(chunk.clone());
        }

        let next_seq = chunks
            .last()
            .map(|chunk| chunk.seq)
            .unwrap_or_else(|| after_seq.min(latest_seq).max(earliest_seq.saturating_sub(1)));
        let has_more = record.chunks.iter().any(|chunk| chunk.seq > next_seq);

        Ok(TerminalReadResult {
            session_id: session_id.to_owned(),
            workspace_id: record.workspace_id.clone(),
            chunks,
            next_seq,
            earliest_seq,
            latest_seq,
            dropped,
            has_more,
            status: record.status,
            exit_code: record.exit_code,
            error: record.error.clone(),
        })
    }

    pub(crate) async fn read(
        &self,
        session_id: &str,
        after_seq: u64,
        max_bytes: usize,
        wait_ms: u64,
    ) -> Result<TerminalReadResult, String> {
        let notified = self.changed.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();

        let initial = self.snapshot(session_id, after_seq, max_bytes)?;
        if wait_ms == 0
            || !initial.chunks.is_empty()
            || initial.status != TerminalLifecycleStatus::Running
        {
            return Ok(initial);
        }

        let _ = timeout(Duration::from_millis(wait_ms), notified.as_mut()).await;
        self.snapshot(session_id, after_seq, max_bytes)
    }
}

fn split_utf8_chunks(value: &str, max_bytes: usize) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut start = 0;

    while start < value.len() {
        let mut end = (start + max_bytes).min(value.len());
        while end > start && !value.is_char_boundary(end) {
            end -= 1;
        }
        if end == start {
            end = value[start..]
                .char_indices()
                .nth(1)
                .map(|(offset, _)| start + offset)
                .unwrap_or(value.len());
        }
        chunks.push(&value[start..end]);
        start = end;
    }

    chunks
}

fn prune_records(state: &mut StoreState) {
    if state.records.len() < MAX_TERMINAL_RECORDS {
        return;
    }

    let mut attempts = state.order.len();
    while state.records.len() >= MAX_TERMINAL_RECORDS && attempts > 0 {
        attempts -= 1;
        let Some((session_id, generation)) = state.order.pop_front() else {
            break;
        };

        match state.records.get(&session_id) {
            None => {}
            Some(record) if record.generation != generation => {}
            Some(record) if record.status == TerminalLifecycleStatus::Running => {
                state.order.push_back((session_id, generation));
            }
            Some(_) => {
                state.records.remove(&session_id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn transcript_is_cursor_based_and_bounded() {
        let store = TerminalAutomationStore::default();
        let generation = store
            .begin_session("pane-1", "workspace-1")
            .expect("session should begin");
        for index in 0..320 {
            store.record_output("pane-1", generation, format!("{index}:{}", "x".repeat(1024)));
        }

        let first = store
            .snapshot("pane-1", 0, MAX_READ_BYTES)
            .expect("snapshot should work");
        assert!(first.dropped);
        assert!(first.earliest_seq > 1);
        assert!(first.latest_seq >= first.next_seq);
        assert!(!first.chunks.is_empty());
        assert!(first.chunks.iter().map(|chunk| chunk.data.len()).sum::<usize>() <= MAX_READ_BYTES);

        let next = store
            .snapshot("pane-1", first.next_seq, MAX_READ_BYTES)
            .expect("next snapshot should work");
        assert!(next.chunks.iter().all(|chunk| chunk.seq > first.next_seq));
    }

    #[test]
    fn minimum_read_window_accepts_every_stored_chunk() {
        let store = TerminalAutomationStore::default();
        let generation = store
            .begin_session("pane-1", "workspace-1")
            .expect("session should begin");
        store.record_output("pane-1", generation, "x".repeat(4096));
        let snapshot = store
            .snapshot("pane-1", 0, MIN_READ_BYTES)
            .expect("minimum read should work");
        assert!(!snapshot.chunks.is_empty());
        assert!(snapshot.chunks.iter().all(|chunk| chunk.data.len() <= MIN_READ_BYTES));
    }

    #[test]
    fn refuses_unbounded_running_record_growth() {
        let store = TerminalAutomationStore::default();
        for index in 0..MAX_TERMINAL_RECORDS {
            store
                .begin_session(&format!("pane-{index}"), "workspace-1")
                .expect("record should fit");
        }
        let error = store
            .begin_session("pane-overflow", "workspace-1")
            .expect_err("record cap should be enforced");
        assert!(error.contains("record limit reached"));
    }

    #[test]
    fn completed_record_is_pruned_to_make_room() {
        let store = TerminalAutomationStore::default();
        let first_generation = store
            .begin_session("pane-0", "workspace-1")
            .expect("first record should fit");
        for index in 1..MAX_TERMINAL_RECORDS {
            store
                .begin_session(&format!("pane-{index}"), "workspace-1")
                .expect("record should fit");
        }
        store.finish_session(
            "pane-0",
            first_generation,
            TerminalLifecycleStatus::Exited,
            Some(0),
            None,
        );
        store
            .begin_session("pane-replacement", "workspace-1")
            .expect("completed record should be pruned");
        assert!(store.snapshot("pane-0", 0, MAX_READ_BYTES).is_err());
    }

    #[test]
    fn chunks_preserve_utf8_boundaries() {
        let chunks = split_utf8_chunks(&"ế".repeat(5000), MAX_STORED_CHUNK_BYTES);
        assert!(chunks.len() > 1);
        assert_eq!(chunks.concat(), "ế".repeat(5000));
        assert!(chunks.iter().all(|chunk| chunk.len() <= MAX_STORED_CHUNK_BYTES));
    }

    #[test]
    fn escaped_read_response_stays_under_protocol_limit() {
        let store = TerminalAutomationStore::default();
        let generation = store
            .begin_session("pane-1", "workspace-1")
            .expect("session should begin");
        store.record_output("pane-1", generation, "\u{1b}".repeat(MAX_READ_BYTES));
        let snapshot = store
            .snapshot("pane-1", 0, MAX_READ_BYTES)
            .expect("snapshot should work");
        let encoded = serde_json::to_vec(&snapshot).expect("snapshot should serialize");
        assert!(encoded.len() < 64 * 1024);
    }

    #[test]
    fn stale_reader_generation_cannot_mutate_new_session() {
        let store = TerminalAutomationStore::default();
        let old_generation = store
            .begin_session("pane-1", "workspace-1")
            .expect("session should begin");
        let new_generation = store
            .begin_session("pane-1", "workspace-2")
            .expect("session should restart");

        store.record_output("pane-1", old_generation, "stale".to_owned());
        store.finish_session(
            "pane-1",
            old_generation,
            TerminalLifecycleStatus::Exited,
            Some(1),
            None,
        );
        store.record_output("pane-1", new_generation, "fresh".to_owned());

        let snapshot = store
            .snapshot("pane-1", 0, MAX_READ_BYTES)
            .expect("snapshot should work");
        assert_eq!(snapshot.workspace_id, "workspace-2");
        assert_eq!(snapshot.status, TerminalLifecycleStatus::Running);
        assert_eq!(snapshot.chunks.len(), 1);
        assert_eq!(snapshot.chunks[0].data, "fresh");
    }

    #[tokio::test]
    async fn long_poll_wakes_on_output() {
        let store = std::sync::Arc::new(TerminalAutomationStore::default());
        let generation = store
            .begin_session("pane-1", "workspace-1")
            .expect("session should begin");
        let reader_store = store.clone();
        let reader = tokio::spawn(async move {
            reader_store
                .read("pane-1", 0, MAX_READ_BYTES, 5_000)
                .await
                .expect("read should work")
        });

        tokio::task::yield_now().await;
        store.record_output("pane-1", generation, "hello".to_owned());
        let result = reader.await.expect("reader should finish");
        assert_eq!(result.chunks[0].data, "hello");
    }
}
