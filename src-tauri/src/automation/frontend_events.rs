use super::events::{
    publish_frontend_automation_events, AutomationEventStore, FrontendAutomationEventInput,
};
use tauri::{State, WebviewWindow};

const MAIN_WEBVIEW_LABEL: &str = "main";

#[tauri::command]
pub(crate) fn publish_main_frontend_automation_events(
    webview: WebviewWindow,
    store: State<'_, AutomationEventStore>,
    events: Vec<FrontendAutomationEventInput>,
) -> Result<(), String> {
    authorize_frontend_event_publisher(webview.label())?;
    publish_frontend_automation_events(store, events)
}

fn authorize_frontend_event_publisher(label: &str) -> Result<(), String> {
    if label == MAIN_WEBVIEW_LABEL {
        Ok(())
    } else {
        Err("automation events may only be published by the main webview".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_main_webview_may_publish_events() {
        assert!(authorize_frontend_event_publisher("main").is_ok());
        assert!(authorize_frontend_event_publisher("browser-pane-1").is_err());
        assert!(authorize_frontend_event_publisher("settings").is_err());
    }
}
