pub mod bridge;
#[cfg(windows)]
mod cli_parser;
#[cfg(windows)]
pub mod client;
mod config;
#[cfg(windows)]
mod dispatch;
mod event_methods;
pub(crate) mod events;
mod methods;
mod protocol;
#[cfg(windows)]
mod security;
#[cfg(windows)]
mod server;
mod terminal_methods;
#[cfg(windows)]
mod terminal_runner;

#[cfg(windows)]
pub fn start_server(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = server::run(app).await {
            eprintln!("[cmux automation] server stopped: {error}");
        }
    });
}

#[cfg(not(windows))]
pub fn start_server(_app: tauri::AppHandle) {}
