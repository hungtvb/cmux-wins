pub mod automation;
mod agent_hooks;
mod browser;
mod resume;
mod terminal;
mod terminal_automation;
mod trusted_shells;
mod workspace_metadata;

use agent_hooks::setup_agent_hooks;
use automation::{
    bridge::{resolve_automation_request, set_automation_frontend_ready, AutomationBridge},
    events::AutomationEventStore,
    frontend_events::publish_main_frontend_automation_events,
};
use browser::{
    browser_go_back, browser_go_forward, close_browser_pane, create_browser_pane,
    hide_browser_pane, navigate_browser_pane, reload_browser_pane, set_browser_pane_bounds,
    show_browser_pane,
};
use resume::{
    clear_all_resume_records, clear_resume_record, get_resume_records,
};
use terminal::{
    close_terminal, get_workspace_metadata_batch, resize_terminal, spawn_terminal, write_terminal,
    AppState,
};
use trusted_shells::{
    clear_trusted_shell_executables, get_trusted_shell_store,
    is_shell_executable_trusted, revoke_shell_executable, trust_shell_executable,
    TrustedShellStore,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .manage(TrustedShellStore::default())
        .manage(AutomationBridge::default())
        .manage(AutomationEventStore::default())
        .setup(|app| {
            automation::start_server(app.handle().clone());
            Ok(())
        })
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
            get_workspace_metadata_batch,
            set_automation_frontend_ready,
            resolve_automation_request,
            publish_main_frontend_automation_events,
            trust_shell_executable,
            is_shell_executable_trusted,
            get_trusted_shell_store,
            revoke_shell_executable,
            clear_trusted_shell_executables,
            get_resume_records,
            clear_resume_record,
            clear_all_resume_records,
            setup_agent_hooks
        ])
        .run(tauri::generate_context!())
        .expect("error while running TonyMux");
}
