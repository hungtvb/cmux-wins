use crate::{
    automation::events::AutomationEventStore,
    terminal_automation::{
        TerminalAutomationStore, TerminalLifecycleStatus, TerminalReadResult,
    },
    trusted_shells::{TrustedExecutableGuard, TrustedShellStore},
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
const MAX_TERMINAL_CLIENT_ID_LENGTH: usize = 128;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalLifecycleEvent {
    session_id: String,
    kind: String,
    message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SpawnTerminalResult {
    generation: u64,
    process_id: Option<u32>,
    reused: bool,
}

struct PtySession {
    workspace_id: String,
    process_id: Option<u32>,
    generation: u64,
    client_id: Mutex<String>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn Child + Send + Sync>>,
}

impl PtySession {
    fn adopt_client(&self, client_id: &str) -> Result<(), String> {
        *self
            .client_id
            .lock()
            .map_err(|_| "terminal client lock is poisoned".to_owned())? = client_id.to_owned();
        Ok(())
    }

    fn belongs_to_client(&self, client_id: Option<&str>) -> Result<bool, String> {
        let Some(client_id) = client_id else {
            return Ok(true);
        };
        Ok(*self
            .client_id
            .lock()
            .map_err(|_| "terminal client lock is poisoned".to_owned())?
            == client_id)
    }
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

fn is_custom_profile_id(profile_id: &str) -> bool {
    let Some(suffix) = profile_id.strip_prefix("custom:") else {
        return false;
    };
    (8..=80).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-'))
}

/// A validated SSH connection target for remote terminal panes.
///
/// `ssh.exe` ships with Windows 10+ (OpenSSH client) and is spawned through
/// the same ConPTY path as local shells, so password prompts, host-key
/// confirmation and interactive remote shells all work in the pane.
#[derive(Clone, Debug, serde::Deserialize)]
pub(crate) struct SshConnection {
    /// Profile id of the SSH profile this connection was resolved from.
    /// Required so the backend can reject ssh spawns that did not go through
    /// the profile resolver (defense in depth against renderer bugs).
    pub profile_id: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    #[serde(default)]
    pub identity_file: Option<String>,
}

/// SSH profile ids look like `ssh:<uuid>` (see `isSshProfileId` in the
/// frontend). The backend only needs to confirm the shape so a raw spawn
/// without a resolver-produced id is rejected.
fn is_valid_ssh_profile_id(value: &str) -> bool {
    value.starts_with("ssh:") && value.len() > 4 && value[4..].chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn validate_ssh_connection(connection: SshConnection) -> Result<SshConnection, String> {
    // The profile id is required: ssh spawns must come from the profile
    // resolver, never from raw renderer-provided connection details.
    let profile_id = connection.profile_id.trim().to_owned();
    if profile_id.is_empty() || profile_id.len() > 128 || !is_valid_ssh_profile_id(&profile_id) {
        return Err("ssh profile id is required and must match the expected format".to_owned());
    }
    let host = connection.host.trim().to_owned();
    if host.is_empty() || host.len() > 253 {
        return Err("ssh host must be 1 to 253 characters".to_owned());
    }
    if !host.bytes().all(|value| {
        value.is_ascii_alphanumeric() || matches!(value, b'.' | b'-' | b'_' | b':')
    }) {
        return Err("ssh host contains unsupported characters".to_owned());
    }
    if connection.port == 0 {
        return Err("ssh port must be between 1 and 65535".to_owned());
    }
    let user = connection.user.trim().to_owned();
    if user.is_empty() || user.len() > 128 {
        return Err("ssh user must be 1 to 128 characters".to_owned());
    }
    if !user
        .bytes()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'.' | b'-' | b'_'))
    {
        return Err("ssh user contains unsupported characters".to_owned());
    }
    let identity_file = match connection.identity_file {
        Some(value) => {
            let value = value.trim().to_owned();
            if value.is_empty() {
                None
            } else if value.len() > 1024 {
                return Err("ssh identity file path exceeds 1024 characters".to_owned());
            } else {
                Some(value)
            }
        }
        None => None,
    };
    Ok(SshConnection {
        host,
        port: connection.port,
        user,
        identity_file,
    })
}

fn build_ssh_command(connection: &SshConnection) -> CommandBuilder {
    let mut command = CommandBuilder::new("ssh.exe");
    command.arg("-p");
    command.arg(connection.port.to_string());
    if let Some(identity_file) = connection.identity_file.as_deref() {
        command.arg("-i");
        command.arg(identity_file);
    }
    command.arg(format!("{}@{}", connection.user, connection.host));
    command
}

struct ResolvedShell {
    executable: String,
    _trust_guard: Option<TrustedExecutableGuard>,
}

fn resolve_shell(
    profile_id: &str,
    custom_shell_executable: Option<String>,
    trusted_shells: &TrustedShellStore,
) -> Result<ResolvedShell, String> {
    if let Ok(default_shell) = shell_for_profile(profile_id) {
        if custom_shell_executable.is_some() {
            return Err("built-in shell profiles cannot include a custom executable".to_owned());
        }
        return Ok(ResolvedShell {
            executable: env::var("CMUX_SHELL")
                .ok()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| default_shell.to_owned()),
            _trust_guard: None,
        });
    }

    if !is_custom_profile_id(profile_id) {
        return Err(format!("unsupported shell profile: {profile_id}"));
    }
    let executable = custom_shell_executable
        .ok_or_else(|| "custom shell profile is missing its executable path".to_owned())?;
    let guard = trusted_shells.resolve_trusted(&executable)?;
    Ok(ResolvedShell {
        executable: guard.executable().to_owned(),
        _trust_guard: Some(guard),
    })
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

fn validate_terminal_client_id(client_id: String) -> Result<String, String> {
    let client_id = client_id.trim().to_owned();
    if client_id.is_empty() || client_id.len() > MAX_TERMINAL_CLIENT_ID_LENGTH {
        return Err(format!(
            "terminal client id must contain 1 to {MAX_TERMINAL_CLIENT_ID_LENGTH} characters"
        ));
    }
    if !client_id.bytes().all(|value| {
        value.is_ascii_alphanumeric() || matches!(value, b'-' | b'_' | b':' | b'.')
    }) {
        return Err("terminal client id contains unsupported characters".to_owned());
    }
    Ok(client_id)
}

fn session_for_client(
    state: &AppState,
    session_id: &str,
    client_id: Option<&str>,
) -> Result<Arc<PtySession>, String> {
    let session = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("terminal session not found: {session_id}"))?;
    if !session.belongs_to_client(client_id)? {
        return Err(format!(
            "terminal client no longer owns session: {session_id}"
        ));
    }
    Ok(session)
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

/// Surface a terminal lifecycle change (exit / error) to the UI so SSH panes
/// (and any remote shell) can show a disconnected state and offer to reconnect.
fn emit_terminal_lifecycle(app: &AppHandle, session_id: &str, kind: &str, payload: Value) {
    let _ = app.emit("terminal-lifecycle", TerminalLifecycleEvent {
        session_id: session_id.to_owned(),
        kind: kind.to_owned(),
        message: payload.get("error").and_then(Value::as_str).unwrap_or("").to_owned(),
    });
    // Mirror into the automation event store so agent hooks observe terminal
    // disconnects/errors, not just interactive output.
    if let Err(error) = app
        .state::<AutomationEventStore>()
        .publish(&format!("terminal.{kind}"), payload.clone())
    {
        eprintln!("[TonyMux automation] unable to publish terminal.{kind}: {error}");
    }
}

fn publish_terminal_event(app: &AppHandle, kind: &str, payload: Value) {
    let store = app.state::<AutomationEventStore>();
    if let Err(error) = store.publish(kind, payload) {
        eprintln!("[TonyMux automation] unable to publish {kind}: {error}");
    }
}

/// Map a terminal exit code to a user-facing lifecycle hint. ssh.exe uses
/// 255 for connection/host-key/auth failures and 1 for remote command errors;
/// everything else is a generic message.
fn terminal_exit_message(exit_code: u32) -> &'static str {
    match exit_code {
        255 => "SSH connection failed (host key, authentication or network). Reconnect to retry.",
        1 => "Remote command exited with an error.",
        _ => "Terminal session ended.",
    }
}

#[tauri::command]
pub(crate) fn spawn_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    trusted_shells: State<'_, TrustedShellStore>,
    workspace_id: String,
    session_id: String,
    cwd: Option<String>,
    shell_profile_id: String,
    custom_shell_executable: Option<String>,
    startup_command: Option<String>,
    client_id: String,
    ssh: Option<SshConnection>,
    cols: u16,
    rows: u16,
) -> Result<SpawnTerminalResult, String> {
    let client_id = validate_terminal_client_id(client_id)?;
    // Keep the session map locked until the child has been inserted. The old
    // check-then-spawn sequence allowed two concurrent frontend effects to
    // create duplicate shells for the same pane before either one registered.
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?;
    if let Some(session) = sessions.get(&session_id) {
        session.adopt_client(&client_id)?;
        return Ok(SpawnTerminalResult {
            generation: session.generation,
            process_id: session.process_id,
            reused: true,
        });
    }

    // SSH panes bypass the local shell trust path entirely: ssh.exe is a
    // Windows system binary and the connection target is validated below.
    let ssh = ssh.map(validate_ssh_connection).transpose()?;
    let mut resolved_shell = None;
    let shell = match &ssh {
        Some(_) => "ssh.exe".to_owned(),
        None => {
            let resolved = resolve_shell(
                &shell_profile_id,
                custom_shell_executable,
                trusted_shells.inner(),
            )?;
            let executable = resolved.executable.clone();
            resolved_shell = Some(resolved);
            executable
        }
    };
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

    let mut command = if let Some(connection) = &ssh {
        build_ssh_command(connection)
    } else {
        CommandBuilder::new(&shell)
    };
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
    if let Some(guard) = resolved_shell
        .as_mut()
        .and_then(|resolved| resolved._trust_guard.as_mut())
    {
        if let Err(error) = guard.verify_unchanged() {
            let _ = child.kill();
            return Err(error);
        }
    }
    drop(resolved_shell);
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
        client_id: Mutex::new(client_id),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        child: Mutex::new(child),
    });

    sessions.insert(session_id.clone(), session);
    drop(sessions);

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
                // ssh.exe exit codes: 255 = connection/host-key/auth failure,
                // 1 = remote command error. Surface a hint for the SSH case.
                let exit_message = terminal_exit_message(exit_code);
                emit_terminal_lifecycle(&app, &session_id, "exited", json!({ "error": exit_message }));
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
                emit_terminal_lifecycle(&app, &session_id, "error", json!({ "error": message }));
            }
        }
    });

    Ok(SpawnTerminalResult {
        generation,
        process_id,
        reused: false,
    })
}

#[tauri::command]
pub(crate) fn write_terminal(
    state: State<'_, AppState>,
    session_id: String,
    client_id: Option<String>,
    data: String,
) -> Result<(), String> {
    let session = session_for_client(state.inner(), &session_id, client_id.as_deref())?;
    let mut writer = session
        .writer
        .lock()
        .map_err(|_| "terminal writer lock is poisoned".to_owned())?;
    writer
        .write_all(data.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|error| format!("unable to write to terminal: {error}"))
}

#[tauri::command]
pub(crate) fn resize_terminal(
    state: State<'_, AppState>,
    session_id: String,
    client_id: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = session_for_client(state.inner(), &session_id, client_id.as_deref())?;

    let resize_result = {
        let master = session
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
    client_id: Option<String>,
) -> Result<(), String> {
    let removed = {
        let mut sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal session lock is poisoned".to_owned())?;
        let is_current_client = sessions
            .get(&session_id)
            .map(|session| session.belongs_to_client(client_id.as_deref()))
            .transpose()?
            .unwrap_or(false);
        if is_current_client {
            sessions.remove(&session_id)
        } else {
            None
        }
    };

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
    use std::{
        fs,
        time::{SystemTime, UNIX_EPOCH},
    };

    #[test]
    fn shell_profiles_are_allowlisted() {
        assert_eq!(shell_for_profile("windows-powershell").unwrap(), "powershell.exe");
        assert_eq!(shell_for_profile("powershell-7").unwrap(), "pwsh.exe");
        assert_eq!(shell_for_profile("command-prompt").unwrap(), "cmd.exe");
        assert_eq!(shell_for_profile("wsl").unwrap(), "wsl.exe");
        assert!(shell_for_profile("custom.exe").is_err());
    }

    #[test]
    fn custom_shells_require_a_stable_profile_id_and_matching_file_identity() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        let path = env::temp_dir().join(format!(
            "tonymux-terminal-trust-{}-{nonce}.json",
            std::process::id()
        ));
        let executable_path = env::temp_dir().join(format!(
            "tonymux-terminal-shell-{}-{nonce}.exe",
            std::process::id()
        ));
        fs::write(&executable_path, b"trusted terminal shell")
            .expect("temporary executable should be written");
        let executable = executable_path.to_string_lossy().to_string();
        let store = TrustedShellStore::from_path(path.clone());

        assert!(resolve_shell(
            "custom:trusted_shell",
            Some(executable.clone()),
            &store,
        )
        .is_err());
        store.trust(&executable).expect("trust should persist");
        let resolved = resolve_shell(
            "custom:trusted_shell",
            Some(executable.clone()),
            &store,
        )
        .expect("trusted shell should resolve");
        let canonical = fs::canonicalize(&executable_path)
            .expect("temporary executable should canonicalize");
        let expected = crate::trusted_shells::normalize_canonical_executable(&canonical)
            .expect("canonical executable should normalize");
        assert!(resolved.executable.eq_ignore_ascii_case(&expected));
        drop(resolved);
        assert!(resolve_shell(
            "custom:bad/id",
            Some(executable.clone()),
            &store,
        )
        .is_err());

        fs::write(&executable_path, b"changed terminal shell")
            .expect("temporary executable should be replaced");
        assert!(resolve_shell(
            "custom:trusted_shell",
            Some(executable),
            &store,
        )
        .is_err());
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(executable_path);
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

    #[test]
    fn terminal_client_ids_are_bounded_and_label_safe() {
        assert_eq!(
            validate_terminal_client_id("terminal-1:mount.2".to_owned()).as_deref(),
            Ok("terminal-1:mount.2")
        );
        assert!(validate_terminal_client_id("".to_owned()).is_err());
        assert!(validate_terminal_client_id("terminal/client".to_owned()).is_err());
        assert!(validate_terminal_client_id("x".repeat(MAX_TERMINAL_CLIENT_ID_LENGTH + 1)).is_err());
    }

    #[test]
    fn ssh_connections_are_validated_and_normalized() {
        let valid = validate_ssh_connection(SshConnection {
            profile_id: "ssh:dev-server".to_owned(),
            host: "  example.com  ".to_owned(),
            port: 2222,
            user: "tony".to_owned(),
            identity_file: Some(" C:\\Users\\tony\\.ssh\\id_ed25519 ".to_owned()),
        })
        .expect("valid ssh connection should resolve");
        assert_eq!(valid.host, "example.com");
        assert_eq!(valid.port, 2222);
        assert_eq!(valid.user, "tony");
        assert_eq!(
            valid.identity_file.as_deref(),
            Some("C:\\Users\\tony\\.ssh\\id_ed25519")
        );

        let bare = validate_ssh_connection(SshConnection {
            profile_id: "ssh:dev-server".to_owned(),
            host: "10.0.0.7".to_owned(),
            port: 22,
            user: "root".to_owned(),
            identity_file: None,
        })
        .expect("bare connection should resolve");
        assert_eq!(bare.identity_file, None);

        assert!(validate_ssh_connection(SshConnection {
            profile_id: "ssh:dev-server".to_owned(),
            host: "bad host".to_owned(),
            port: 22,
            user: "tony".to_owned(),
            identity_file: None,
        })
        .is_err());
        assert!(validate_ssh_connection(SshConnection {
            profile_id: "ssh:dev-server".to_owned(),
            host: "example.com".to_owned(),
            port: 0,
            user: "tony".to_owned(),
            identity_file: None,
        })
        .is_err());
        assert!(validate_ssh_connection(SshConnection {
            profile_id: "ssh:dev-server".to_owned(),
            host: "example.com".to_owned(),
            port: 22,
            user: "bad@user".to_owned(),
            identity_file: None,
        })
        .is_err());
        assert!(validate_ssh_connection(SshConnection {
            profile_id: "ssh:dev-server".to_owned(),
            host: "".to_owned(),
            port: 22,
            user: "tony".to_owned(),
            identity_file: None,
        })
        .is_err());
        // A raw spawn without a resolver-produced profile id must be rejected.
        assert!(validate_ssh_connection(SshConnection {
            profile_id: "".to_owned(),
            host: "example.com".to_owned(),
            port: 22,
            user: "tony".to_owned(),
            identity_file: None,
        })
        .is_err());
        assert!(validate_ssh_connection(SshConnection {
            profile_id: "not-an-ssh-id".to_owned(),
            host: "example.com".to_owned(),
            port: 22,
            user: "tony".to_owned(),
            identity_file: None,
        })
        .is_err());
    }

    #[test]
    fn terminal_exit_messages_cover_ssh_failure_codes() {
        assert!(terminal_exit_message(255).contains("SSH connection failed"));
        assert!(terminal_exit_message(1).contains("Remote command exited"));
        assert_eq!(terminal_exit_message(0), "Terminal session ended.");
        assert_eq!(terminal_exit_message(127), "Terminal session ended.");
    }
}
