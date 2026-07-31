use crate::workspace_metadata::{
    inspect_workspace_metadata_batch, WorkspaceMetadataEntry, WorkspaceMetadataRequest,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
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
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

#[derive(Default)]
pub(crate) struct AppState {
    sessions: Mutex<HashMap<String, PtySession>>,
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

    state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?
        .insert(
            session_id.clone(),
            PtySession {
                workspace_id,
                process_id,
                master: pair.master,
                writer,
                child,
            },
        );

    thread::spawn(move || {
        let mut buffer = [0_u8; 8192];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    let data = String::from_utf8_lossy(&buffer[..count]).into_owned();
                    emit_output(&app, &session_id, data);
                }
                Err(error) => {
                    emit_output(
                        &app,
                        &session_id,
                        format!("\r\n[cmux] terminal read error: {error}\r\n"),
                    );
                    break;
                }
            }
        }

        if let Ok(mut sessions) = app.state::<AppState>().sessions.lock() {
            sessions.remove(&session_id);
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
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?;
    let session = sessions
        .get_mut(&session_id)
        .ok_or_else(|| format!("terminal session not found: {session_id}"))?;

    session
        .writer
        .write_all(data.as_bytes())
        .and_then(|_| session.writer.flush())
        .map_err(|error| format!("unable to write to terminal: {error}"))
}

#[tauri::command]
pub(crate) fn resize_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?;
    let session = sessions
        .get(&session_id)
        .ok_or_else(|| format!("terminal session not found: {session_id}"))?;

    session
        .master
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
    state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?
        .remove(&session_id);

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
