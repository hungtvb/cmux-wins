use crate::{
    terminal_automation::{
        TerminalAutomationStore, TerminalLifecycleStatus, TerminalReadResult,
    },
    workspace_metadata::{
        inspect_workspace_metadata_batch, WorkspaceMetadataEntry, WorkspaceMetadataRequest,
    },
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: String,
    data: String,
}

struct PtySession {
    workspace_id: String,
    process_id: Option<u32>,
    generation: u64,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

#[derive(Default)]
pub(crate) struct AppState {
    sessions: Mutex<HashMap<String, Arc<PtySession>>>,
    terminal_automation: TerminalAutomationStore,
}

impl AppState {
    pub(crate) fn automation_write_terminal(
        &self,
        session_id: &str,
        data: &str,
    ) -> Result<usize, String> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| "terminal session lock is poisoned".to_owned())?
            .get(session_id)
            .cloned()
            .ok_or_else(|| format!("terminal session not found: {session_id}"))?;

        let mut writer = session
            .writer
            .lock()
            .map_err(|_| "terminal writer lock is poisoned".to_owned())?;
        writer
            .write_all(data.as_bytes())
            .and_then(|_| writer.flush())
            .map_err(|error| format!("unable to write to terminal: {error}"))?;
        Ok(data.len())
    }

    pub(crate) async fn automation_read_terminal(
        &self,
        session_id: &str,
        after_seq: u64,
        max_bytes: usize,
        wait_ms: u64,
    ) -> Result<TerminalReadResult, String> {
        self.terminal_automation
            .read(session_id, after_seq, max_bytes, wait_ms)
            .await
    }
}

fn emit_output(app: &AppHandle, session_id: &str, data: impl Into<String>) {
    let _ = app.emit(
        "terminal-output",
        TerminalOutputEvent {
            session_id: session_id.to_owned(),
            data: data.into(),
        },
    );
}

#[tauri::command]
pub(crate) fn spawn_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: String,
    session_id: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal session lock is poisoned".to_owned())?;
        if sessions.contains_key(&session_id) {
            return Ok(());
        }
    }

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("unable to open ConPTY: {error}"))?;

    let shell = std::env::var("CMUX_SHELL").unwrap_or_else(|_| "powershell.exe".to_owned());
    let mut command = CommandBuilder::new(&shell);
    let shell_name = shell.to_ascii_lowercase();
    if shell_name.contains("powershell") || shell_name.contains("pwsh") {
        command.arg("-NoLogo");
    }

    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        command.cwd(cwd);
    }

    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("unable to spawn shell '{shell}': {error}"))?;
    let process_id = child.process_id();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("unable to open PTY reader: {error}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("unable to open PTY writer: {error}"))?;

    drop(pair.slave);

    let generation = state
        .terminal_automation
        .begin_session(&session_id, &workspace_id);
    let session = Arc::new(PtySession {
        workspace_id,
        process_id,
        generation,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });

    state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?
        .insert(session_id.clone(), session);

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        let mut read_error = None;

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let data = String::from_utf8_lossy(&buffer[..count]).into_owned();
                    let app_state = app.state::<AppState>();
                    app_state
                        .terminal_automation
                        .record_output(&session_id, generation, data.clone());
                    emit_output(&app, &session_id, data);
                }
                Err(error) => {
                    let message = format!("terminal read error: {error}");
                    let rendered = format!("\r\n[cmux] {message}\r\n");
                    let app_state = app.state::<AppState>();
                    app_state.terminal_automation.record_output(
                        &session_id,
                        generation,
                        rendered.clone(),
                    );
                    emit_output(&app, &session_id, rendered);
                    read_error = Some(message);
                    break;
                }
            }
        }

        let app_state = app.state::<AppState>();
        let removed = app_state
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(&session_id));

        let Some(session) = removed else {
            return;
        };

        if let Some(error) = read_error {
            app_state.terminal_automation.finish_session(
                &session_id,
                session.generation,
                TerminalLifecycleStatus::Error,
                None,
                Some(error),
            );
            return;
        }

        let wait_result = session
            .child
            .lock()
            .map_err(|_| "terminal child lock is poisoned".to_owned())
            .and_then(|mut child| child.wait().map_err(|error| error.to_string()));
        match wait_result {
            Ok(status) => app_state.terminal_automation.finish_session(
                &session_id,
                session.generation,
                TerminalLifecycleStatus::Exited,
                Some(status.exit_code()),
                None,
            ),
            Err(error) => app_state.terminal_automation.finish_session(
                &session_id,
                session.generation,
                TerminalLifecycleStatus::Error,
                None,
                Some(format!("unable to wait for terminal process: {error}")),
            ),
        }
    });

    Ok(())
}

#[tauri::command]
pub(crate) fn write_terminal(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    state
        .automation_write_terminal(&session_id, &data)
        .map(|_| ())
}

#[tauri::command]
pub(crate) fn resize_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("terminal session not found: {session_id}"))?;

    session
        .master
        .lock()
        .map_err(|_| "terminal master lock is poisoned".to_owned())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("unable to resize terminal: {error}"))
}

#[tauri::command]
pub(crate) fn close_terminal(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let removed = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?
        .remove(&session_id);

    if let Some(session) = removed {
        state.terminal_automation.finish_session(
            &session_id,
            session.generation,
            TerminalLifecycleStatus::Closed,
            None,
            None,
        );
    }

    Ok(())
}

#[tauri::command]
pub(crate) async fn get_workspace_metadata_batch(
    state: State<'_, AppState>,
    requests: Vec<WorkspaceMetadataRequest>,
) -> Result<Vec<WorkspaceMetadataEntry>, String> {
    let roots_by_workspace = {
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal session lock is poisoned".to_owned())?;
        let mut roots: HashMap<String, Vec<u32>> = HashMap::new();

        for session in sessions.values() {
            if let Some(process_id) = session.process_id {
                roots
                    .entry(session.workspace_id.clone())
                    .or_default()
                    .push(process_id);
            }
        }

        roots
    };

    inspect_workspace_metadata_batch(requests, roots_by_workspace).await
}
