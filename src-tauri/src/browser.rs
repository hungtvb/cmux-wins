use serde::Serialize;
use tauri::{
    webview::{DownloadEvent, NewWindowResponse, PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};
use url::Url;

const BROWSER_EVENT_NAME: &str = "browser-pane-event";
const MAIN_WEBVIEW_LABEL: &str = "main";
const MAX_BROWSER_PANE_ID_LENGTH: usize = 128;
const MAX_BROWSER_URL_LENGTH: usize = 2_048;
const MAX_BROWSER_TITLE_CHARS: usize = 128;
const MAX_BROWSER_MESSAGE_CHARS: usize = 512;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserPaneEvent {
    pane_id: String,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
}

fn bounded_event_text(value: &str, max_chars: usize) -> Option<String> {
    let normalized = value
        .chars()
        .map(|character| {
            if character.is_control()
                || matches!(character, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
            {
                ' '
            } else {
                character
            }
        })
        .collect::<String>();
    let bounded = normalized.trim().chars().take(max_chars).collect::<String>();
    (!bounded.is_empty()).then_some(bounded)
}

fn is_allowed_browser_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.username().is_empty()
        && url.password().is_none()
        && url.as_str().len() <= MAX_BROWSER_URL_LENGTH
}

fn parse_browser_url(value: &str) -> Result<Url, String> {
    if value.len() > MAX_BROWSER_URL_LENGTH {
        return Err(format!(
            "browser URL exceeds the {MAX_BROWSER_URL_LENGTH}-byte limit"
        ));
    }

    let url = Url::parse(value).map_err(|error| format!("invalid browser URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(format!(
            "browser URL scheme is not allowed: {}",
            url.scheme()
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("browser URLs cannot contain embedded credentials".to_owned());
    }

    Ok(url)
}

fn emit_browser_event(
    app: &AppHandle,
    pane_id: &str,
    kind: &'static str,
    url: Option<&Url>,
    title: Option<&str>,
    message: Option<&str>,
) {
    let payload = BrowserPaneEvent {
        pane_id: pane_id.to_owned(),
        kind,
        url: url
            .filter(|value| is_allowed_browser_url(value))
            .map(ToString::to_string),
        title: title.and_then(|value| bounded_event_text(value, MAX_BROWSER_TITLE_CHARS)),
        message: message.and_then(|value| bounded_event_text(value, MAX_BROWSER_MESSAGE_CHARS)),
    };

    // Browser lifecycle feedback is advisory UI state. A missing or reloading
    // main webview must never change navigation policy or keep a child view alive.
    let _ = app.emit_to(MAIN_WEBVIEW_LABEL, BROWSER_EVENT_NAME, payload);
}

fn validate_browser_pane_id(pane_id: &str) -> Result<(), String> {
    if pane_id.is_empty() || pane_id.len() > MAX_BROWSER_PANE_ID_LENGTH {
        return Err("browser pane ID is empty or exceeds the supported limit".to_owned());
    }
    if !pane_id
        .bytes()
        .all(|value| value.is_ascii_alphanumeric() || matches!(value, b'_' | b'-'))
    {
        return Err("browser pane ID contains unsupported characters".to_owned());
    }
    Ok(())
}

fn browser_label(pane_id: &str) -> Result<String, String> {
    validate_browser_pane_id(pane_id)?;
    Ok(format!("browser-{pane_id}"))
}

fn get_browser_webview(app: &AppHandle, pane_id: &str) -> Result<tauri::Webview, String> {
    let label = browser_label(pane_id)?;
    app.get_webview(&label)
        .ok_or_else(|| format!("browser pane not found: {pane_id}"))
}

#[tauri::command]
pub(crate) async fn create_browser_pane(
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
    let label = browser_label(&pane_id)?;

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

    let navigation_app = app.clone();
    let navigation_pane_id = pane_id.clone();
    let new_window_app = app.clone();
    let new_window_pane_id = pane_id.clone();
    let download_app = app.clone();
    let download_pane_id = pane_id.clone();
    let load_app = app.clone();
    let load_pane_id = pane_id.clone();
    let title_app = app.clone();
    let title_pane_id = pane_id.clone();

    let builder = WebviewBuilder::new(label, WebviewUrl::External(parsed_url))
        .on_navigation(move |target| {
            let allowed = is_allowed_browser_url(target);
            if !allowed {
                emit_browser_event(
                    &navigation_app,
                    &navigation_pane_id,
                    "navigation-blocked",
                    Some(target),
                    None,
                    Some("TonyMux blocked a non-HTTP(S), credential-bearing or oversized URL."),
                );
            }
            allowed
        })
        .on_new_window(move |target, _features| {
            emit_browser_event(
                &new_window_app,
                &new_window_pane_id,
                "new-window-blocked",
                Some(&target),
                None,
                Some("TonyMux blocks popups and new-window requests inside browser panes."),
            );
            NewWindowResponse::Deny
        })
        .on_download(move |_webview, event| match event {
            DownloadEvent::Requested { url, .. } => {
                emit_browser_event(
                    &download_app,
                    &download_pane_id,
                    "download-blocked",
                    Some(&url),
                    None,
                    Some("TonyMux blocks downloads from embedded browser panes."),
                );
                false
            }
            DownloadEvent::Finished { .. } => true,
            _ => false,
        })
        .on_page_load(move |_webview, payload| {
            let kind = match payload.event() {
                PageLoadEvent::Started => "load-started",
                PageLoadEvent::Finished => "load-finished",
            };
            emit_browser_event(
                &load_app,
                &load_pane_id,
                kind,
                Some(payload.url()),
                None,
                None,
            );
        })
        .on_document_title_changed(move |_webview, title| {
            emit_browser_event(
                &title_app,
                &title_pane_id,
                "title-changed",
                None,
                Some(&title),
                None,
            );
        });

    window
        .add_child(builder, position, size)
        .map_err(|error| format!("unable to create browser pane: {error}"))?;

    Ok(())
}

#[tauri::command]
pub(crate) fn set_browser_pane_bounds(
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
pub(crate) fn navigate_browser_pane(
    app: AppHandle,
    pane_id: String,
    url: String,
) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .navigate(parse_browser_url(&url)?)
        .map_err(|error| format!("unable to navigate browser pane: {error}"))
}

#[tauri::command]
pub(crate) fn reload_browser_pane(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .reload()
        .map_err(|error| format!("unable to reload browser pane: {error}"))
}

#[tauri::command]
pub(crate) fn browser_go_back(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .eval("history.back()")
        .map_err(|error| format!("unable to navigate browser pane back: {error}"))
}

#[tauri::command]
pub(crate) fn browser_go_forward(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .eval("history.forward()")
        .map_err(|error| format!("unable to navigate browser pane forward: {error}"))
}

#[tauri::command]
pub(crate) fn show_browser_pane(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .show()
        .map_err(|error| format!("unable to show browser pane: {error}"))
}

#[tauri::command]
pub(crate) fn hide_browser_pane(app: AppHandle, pane_id: String) -> Result<(), String> {
    get_browser_webview(&app, &pane_id)?
        .hide()
        .map_err(|error| format!("unable to hide browser pane: {error}"))
}

#[tauri::command]
pub(crate) fn close_browser_pane(app: AppHandle, pane_id: String) -> Result<(), String> {
    let label = browser_label(&pane_id)?;
    if let Some(webview) = app.get_webview(&label) {
        webview
            .close()
            .map_err(|error| format!("unable to close browser pane: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_urls_are_bounded_http_or_https_without_credentials() {
        assert!(parse_browser_url("https://example.com/docs").is_ok());
        assert!(parse_browser_url("http://localhost:5173").is_ok());
        assert!(parse_browser_url("file:///C:/Windows/System32").is_err());
        assert!(parse_browser_url("javascript:alert(1)").is_err());
        assert!(parse_browser_url("https://user:secret@example.com").is_err());
        assert!(parse_browser_url(&format!("https://example.com/{}", "a".repeat(2_100))).is_err());
    }

    #[test]
    fn browser_pane_ids_are_bounded_and_label_safe() {
        assert_eq!(browser_label("pane-123").as_deref(), Ok("browser-pane-123"));
        assert!(browser_label("").is_err());
        assert!(browser_label("pane/123").is_err());
        assert!(browser_label(&"a".repeat(MAX_BROWSER_PANE_ID_LENGTH + 1)).is_err());
    }

    #[test]
    fn browser_event_text_is_control_free_and_character_bounded() {
        assert_eq!(
            bounded_event_text("  hello\r\nworld\0  ", 32),
            Some("hello  world".to_owned())
        );
        assert_eq!(bounded_event_text("", 10), None);
        assert_eq!(bounded_event_text("éééé", 3), Some("ééé".to_owned()));
    }

    #[test]
    fn browser_event_payload_uses_frontend_camel_case_fields() {
        let payload = BrowserPaneEvent {
            pane_id: "pane-1".to_owned(),
            kind: "load-started",
            url: Some("https://example.com/".to_owned()),
            title: None,
            message: None,
        };
        let serialized = serde_json::to_value(payload).expect("serialize browser event");

        assert_eq!(serialized["paneId"], "pane-1");
        assert_eq!(serialized["kind"], "load-started");
        assert!(serialized.get("pane_id").is_none());
        assert!(serialized.get("title").is_none());

        let unsafe_url = Url::parse("data:text/plain,secret").expect("parse unsafe URL");
        let safe_url = Url::parse("https://example.com/path").expect("parse safe URL");
        assert!(!is_allowed_browser_url(&unsafe_url));
        assert!(is_allowed_browser_url(&safe_url));
    }
}
