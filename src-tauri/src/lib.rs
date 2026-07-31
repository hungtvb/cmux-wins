use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::{
    collections::HashMap,
    io::{Read, Write},
    sync::Mutex,
    thread,
};
use tauri::{
    webview::WebviewBuilder, AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, State,
    WebviewUrl,
};
use url::Url;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TerminalOutputEvent {
    session_id: String,
    data: String,
}

struct PtySession {
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
struct AppState {
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

fn browser_label(pane_id: &str) -> String {
    format!("browser-{pane_id}")
}

fn parse_browser_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| format!("invalid browser URL: {error}"))?;
    match url.scheme() {
        "http" | "https" => Ok(url),
        scheme => Err(format!("browser URL scheme is not allowed: {scheme}")),
    }
}

fn get_browser_webview(app: &AppHandle, pane_id: &str) -> Result<tauri::Webview, String> {
    app.get_webview(&browser_label(pane_id))
        .ok_or_else(|| format!("browser pane not found: {pane_id}"))
}

#[tauri::command]
fn create_browser_pane(
    app: AppHandle,
    pane_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let parsed_url = parse_browser_url(&url)?;
    let position = LogicalPosition::new(x.max(0.0), y.max(0.0));
    let size = LogicalSize::new(width.max(1.0), height.max(1.0));
    let label = browser_label(&pane_id);

    if let Some(webview) = app.get_webview(&label) {
        webview
            .set_position(position)
            .map_err(|error| format!("unable to position browser pane: {error}"))?;
        webview
            .set_size(size)
            .map_err(|error| format!("unable to resize browser pane: {error}"))?;
        webview
            .navigate(parsed_url)
            .map_err(|error| format!("unable to navigate browser pane: {error}"))?;
        webview
            .show()
            .map_err(|error| format!("unable to show browser pane: {error}"))?;
        return Ok(());
    }

    let window = app
        .get_window("main")
        .ok_or_else(|| "main application window not found".to_owned())?;
    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed_url)).on_navigation(
        |target| matches!(target.scheme(), "http" | "https"),
    );

    window
        .add_child(builder, position, size)
        .map_err(|error| format!("unable to create browser pane: {error}"))?;

    Ok(())
}

#[tauri::command]
fn set_browser_pane_bounds(
    app: AppHandle,
    pane_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let webview = get_browser_webview(&app, &pane_id)?;
    webview
        .set_position(LogicalPosition::new(x.max(0.0), y.max(0.0)))
        .map_err(|error| format!("unable to position browser pane: {error}"))?;
    webview
        .set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|error| format!("unable to resize browser pane: {error}"))
}

#[tauri::command]
fn navigate_browser_pane(app: AppHandle, pane_id: String, url: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .navigate(parse_browser_url(&url)?)
        .map_err(|error| format!("unable to navigate browser pane: {error}"))
}

#[tauri::command]
fn reload_browser_pane(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .reload()
        .map_err(|error| format!("unable to reload browser pane: {error}"))
}

#[tauri::command]
fn browser_go_back(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .eval("history.back()")
        .map_err(|error| format!("unable to navigate browser pane back: {error}"))
}

#[tauri::command]
fn browser_go_forward(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .eval("history.forward()")
        .map_err(|error| format!("unable to navigate browser pane forward: {error}"))
}

#[tauri::command]
fn show_browser_pane(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .show()
        .map_err(|error| format!("unable to show browser pane: {error}"))
}

#[tauri::command]
fn hide_browser_pane(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .hide()
        .map_err(|error| format!("unable to hide browser pane: {error}"))
}

#[tauri::command]
fn close_browser_pane(app: AppHandle, pane_id: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&browser_label(&pane_id)) {
        webview
            .close()
            .map_err(|error| format!("unable to close browser pane: {error}"))?;
    }
    Ok(())
}

#[tauri::command]
fn spawn_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
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
fn write_terminal(
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
fn resize_terminal(
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
fn close_terminal(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    state
        .sessions
        .lock()
        .map_err(|_| "terminal session lock is poisoned".to_owned())?
        .remove(&session_id);

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_terminal,
            write_terminal,
            resize_terminal,
            close_terminal,
            create_browser_pane,
            set_browser_pane_bounds,
            navigate_browser_pane,
            reload_browser_pane,
            browser_go_back,
            browser_go_forward,
            show_browser_pane,
            hide_browser_pane,
            close_browser_pane
        ])
        .run(tauri::generate_context!())
        .expect("error while running cmux Windows");
}
