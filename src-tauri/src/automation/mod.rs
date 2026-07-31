pub mod bridge;
#[cfg(windows)]
pub mod client;
mod config;
mod methods;
mod protocol;
#[cfg(windows)]
mod security;
#[cfg(windows)]
mod server;

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
