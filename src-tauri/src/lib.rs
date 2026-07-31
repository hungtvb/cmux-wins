mod browser;
mod terminal;
mod workspace_metadata;

use browser::{
    browser_go_back, browser_go_forward, close_browser_pane, create_browser_pane,
    hide_browser_pane, navigate_browser_pane, reload_browser_pane, set_browser_pane_bounds,
    show_browser_pane,
};
use terminal::{
    close_terminal, get_workspace_metadata_batch, resize_terminal, spawn_terminal, write_terminal,
    AppState,
};

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
            close_browser_pane,
            get_workspace_metadata_batch
        ])
        .run(tauri::generate_context!())
        .expect("error while running cmux Windows");
}
