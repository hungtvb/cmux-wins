use tauri::{
    webview::WebviewBuilder, AppHandle, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};
use url::Url;

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
pub(crate) fn create_browser_pane(
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
    if let Some(webview) = app.get_webview(&browser_label(&pane_id)) {
        webview
            .close()
            .map_err(|error| format!("unable to close browser pane: {error}"))?;
    }
    Ok(())
}
