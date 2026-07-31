#[cfg(windows)]
pub mod client;
mod config;
mod protocol;
#[cfg(windows)]
mod security;
#[cfg(windows)]
mod server;

#[cfg(windows)]
pub fn start_server() {
    tauri::async_runtime::spawn(async {
        if let Err(error) = server::run().await {
            eprintln!("[cmux automation] server stopped: {error}");
        }
    });
}

#[cfg(not(windows))]
pub fn start_server() {}
