use crate::{
    automation::events::AutomationEventStore,
    terminal_automation::{
        TerminalAutomationStore, TerminalLifecycleStatus, TerminalReadResult,
    },
    workspace_metadata::{
        inspect_workspace_metadata_batch, WorkspaceMetadataEntry, WorkspaceMetadataRequest,
    },
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    env,
    io::{Read, Write},
    sync::{Arc, Mutex},
    thread,
};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_STARTUP_COMMAND_BYTES: usize = 4 * 1024;

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

fn shell_for_profile(profile_id: &str) -> Result<&'static str, String> {
    match profile_id {
        "windows-powershell" => Ok("powershell.exe"),
        "powershell-7" => Ok("pwsh.exe"),
        "command-prompt" => Ok("cmd.exe"),
        "wsl" => Ok("wsl.exe"),
        _ => Err(format!("unsupported shell profile: {profile_id}")),
    }
}

fn resolve_shell(profile_id: &str) -> Result<String, String> {
    let default_shell = shell_for_profile(profile_id)?;
    Ok(env::var("CMUX_SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| default_shell.to_owned()))
}

fn validate_startup_command(command: Option<String>) -> Result<Option<String>, String> {
    let Some(command) = command.map(|value| value.trim().to_owned()) else {
        return Ok(None);
    };
    if command.is_empty() {
        return Ok(None);
    }
    if command.len() > MAX_STARTUP_COMMAND_BYTES {
        return Err(format!(
            "startup command exceeds {MAX_STARTUP_COMMAND_BYTES} byte limit"
        ));
    }
    if command.bytes().any(|value| matches!(value, b'\0' | b'\r' | b'\n')) {
        return Err("startup command must be a single line without NUL bytes".to_owned());
    }
    Ok(Some(command))
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

fn publish_terminal_event(app: &AppHandle, kind: &str, payload: Value) {
    let store = app.state::<AutomationEventStore>();
    if let Err(error) = store.publish(kind, payload) {
        eprintln!("[TonyMux automation] unable to publish {kind}: {error}");
    }
}

#[tauri::command]
pub(crate) fn spawn_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    workspace_id: String,
    session_id: String,
    cwd: Option<String>,
    shell_profile_id: String,
    startup_command: Option<String>,
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

    let shell = resolve_shell(&shell_profile_id)?;
    let startup_command = validate_startup_command(startup_command)?;

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| format!("unable to open ConPTY: {error}"))?;

    let mut command = CommandBuilder::new(&shell);
    let shell_name = shell.to_ascii_lowercase();
    if shell_name.contains("powershell") || shell_name.contains("pwsh") {
        command.arg("-NoLogo");
    }

    if let Some(cwd) = cwd.filter(|value| !value.trim().is_empty()) {
        command.cwd(cwd);
    }

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| format!("unable to spawn shell '{shell}': {error}"))?;
    let process_id = child.process_id();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| format!("unable to open PTY reader: {error}"))?;
    let mut writer = pair
        .master
        .take_writer()
        .map_err(|error| format!("unable to open PTY writer: {error}"))?;

    if let Some(startup_command) = startup_command.as_deref() {
        if let Err(error) = writer
            .write_all(startup_command.as_bytes())
            .and_then(|_| writer.write_all(b"\r"))
            .and_then(|_| writer.flush())
        {
            let _ = child.kill();
            return Err(format!("unable to send startup command: {error}"));
        }
    }

    drop(pair.slave);

    let generation = match state
        .terminal_automation
        .begin_session(&session_id, &workspace_id)
    {
        Ok(generation) => generation,
        Err(error) => {
            let _ = child.kill();
            return Err(error);
        }
    };
    let started_workspace_id = workspace_id.clone();
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

    publish_terminal_event(
        &app,
        "terminal.started",
        json!({
            "sessionId": session_id.clone(),
            "workspaceId": started_workspace_id,
            "generation": generation,
            "processId": process_id,
            "shell": shell,
            "shellProfileId": shell_profile_id,
        }),
    );

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
                    let rendered = format!("\r\n[TonyMux] {message}\r\n");
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
        let removed = app_state.sessions.lock().ok().and_then(|mut sessions| {
            let is_current_generation = sessions
                .get(&session_id)
                .is_some_and(|session| session.generation == generation);
            if is_current_generation {
                sessions.remove(&session_id)
            } else {
                None
            }
        });

        let Some(session) = removed else {
            return;
        };

        if let Some(error) = read_error {
            app_state.terminal_automation.finish_session(
                &session_id,
                session.generation,
                TerminalLifecycleStatus::Error,
                None,
                Some(error.clone()),
            );
            publish_terminal_event(
                &app,
                "terminal.error",
                json!({
                    "sessionId": session_id.clone(),
                    "workspaceId": session.workspace_id.clone(),
                    "generation": session.generation,
                    "error": error,
                }),
            );
            return;
        }

        let wait_result = session
            .child
            .lock()
            .map_err(|_| "terminal child lock is poisoned".to_owned())
            .and_then(|mut child| child.wait().map_err(|error| error.to_string()));
        match wait_result {
            Ok(status) => {
                let exit_code = status.exit_code();
                app_state.terminal_automation.finish_session(
                    &session_id,
                    session.generation,
                    TerminalLifecycleStatus::Exited,
                    Some(exit_code),
                    None,
                );
                publish_terminal_event(
                    &app,
                    "terminal.exited",
                    json!({
                        "sessionId": session_id.clone(),
                        "workspaceId": session.workspace_id.clone(),
                        "generation": session.generation,
                        "exitCode": exit_code,
                    }),
                );
            }
            Err(error) => {
                let message = format!("unable to wait for terminal process: {error}");
                app_state.terminal_automation.finish_session(
                    &session_id,
                    session.generation,
                    TerminalLifecycleStatus::Error,
                    None,
                    Some(message.clone()),
                );
                publish_terminal_event(
                    &app,
                    "terminal.error",
                    json!({
                        "sessionId": session_id.clone(),
                        "workspaceId": session.workspace_id.clone(),
                        "generation": session.generation,
                        "error": message,
                    }),
                );
            }
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

    let resize_result = {
        let mut master = session
            .master
            .lock()
            .map_err(|_| "terminal master lock is poisoned".to_owned())?;
        master.resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
    };

    resize_result.map_err(|error| format!("unable to resize terminal: {error}"))
}

#[tauri::command]
pub(crate) fn close_terminal(
    app: AppHandle,
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
        publish_terminal_event(
            &app,
            "terminal.closed",
            json!({
                "sessionId": session_id,
                "workspaceId": session.workspace_id.clone(),
                "generation": session.generation,
            }),
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_profiles_are_allowlisted() {
        assert_eq!(shell_for_profile("windows-powershell").unwrap(), "powershell.exe");
        assert_eq!(shell_for_profile("powershell-7").unwrap(), "pwsh.exe");
        assert_eq!(shell_for_profile("command-prompt").unwrap(), "cmd.exe");
        assert_eq!(shell_for_profile("wsl").unwrap(), "wsl.exe");
        assert!(shell_for_profile("custom.exe").is_err());
    }

    #[test]
    fn startup_command_is_bounded_and_single_line() {
        assert_eq!(
            validate_startup_command(Some("  npm run dev  ".to_owned())).unwrap(),
            Some("npm run dev".to_owned())
        );
        assert_eq!(validate_startup_command(Some("  ".to_owned())).unwrap(), None);
        assert!(validate_startup_command(Some("echo one\necho two".to_owned())).is_err());
        assert!(
            validate_startup_command(Some("x".repeat(MAX_STARTUP_COMMAND_BYTES + 1))).is_err()
        );
    }
}
