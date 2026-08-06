use serde::Deserialize;
use serde_json::{json, Value};
use url::Url;

const MAX_TITLE_CHARS: usize = 120;
const MAX_CWD_CHARS: usize = 2_048;
const MAX_IDENTIFIER_CHARS: usize = 128;
const MAX_BROWSER_URL_CHARS: usize = 4_096;
const DEFAULT_BROWSER_URL: &str = "https://github.com/";

#[derive(Debug)]
pub struct MethodError {
    pub code: &'static str,
    pub message: String,
}

impl MethodError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_REQUEST",
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateWorkspaceParams {
    title: String,
    #[serde(default)]
    cwd: String,
    #[serde(default = "default_true")]
    activate: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceIdParams {
    workspace_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateBrowserPaneParams {
    workspace_id: String,
    #[serde(default = "default_browser_url")]
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ClosePaneParams {
    workspace_id: String,
    pane_id: String,
}

pub fn prepare_frontend_method(method: &str, params: Value) -> Result<Option<Value>, MethodError> {
    match method {
        "workspace.list" => {
            ensure_empty_object(&params)?;
            Ok(Some(json!({})))
        }
        "workspace.create" => {
            let input: CreateWorkspaceParams = parse(params)?;
            let title = validate_title(&input.title)?;
            let cwd = validate_cwd(&input.cwd)?;
            Ok(Some(json!({
                "title": title,
                "cwd": cwd,
                "activate": input.activate
            })))
        }
        "workspace.select" | "workspace.close" | "pane.createTerminal" => {
            let input: WorkspaceIdParams = parse(params)?;
            Ok(Some(json!({
                "workspaceId": validate_identifier("workspaceId", &input.workspace_id)?
            })))
        }
        "pane.createBrowser" => {
            let input: CreateBrowserPaneParams = parse(params)?;
            Ok(Some(json!({
                "workspaceId": validate_identifier("workspaceId", &input.workspace_id)?,
                "url": validate_browser_url(&input.url)?
            })))
        }
        "pane.close" => {
            let input: ClosePaneParams = parse(params)?;
            Ok(Some(json!({
                "workspaceId": validate_identifier("workspaceId", &input.workspace_id)?,
                "paneId": validate_identifier("paneId", &input.pane_id)?
            })))
        }
        _ => Ok(None),
    }
}

fn parse<T>(params: Value) -> Result<T, MethodError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(params)
        .map_err(|error| MethodError::invalid(format!("invalid method params: {error}")))
}

fn ensure_empty_object(params: &Value) -> Result<(), MethodError> {
    match params.as_object() {
        Some(object) if object.is_empty() => Ok(()),
        Some(_) => Err(MethodError::invalid("this method does not accept params")),
        None => Err(MethodError::invalid("params must be a JSON object")),
    }
}

fn validate_title(value: &str) -> Result<String, MethodError> {
    let title = value.trim();
    let count = title.chars().count();
    if count == 0 || count > MAX_TITLE_CHARS || title.chars().any(char::is_control) {
        return Err(MethodError::invalid(format!(
            "title must contain 1 to {MAX_TITLE_CHARS} printable characters"
        )));
    }
    Ok(title.to_owned())
}

fn validate_cwd(value: &str) -> Result<String, MethodError> {
    let cwd = value.trim();
    if cwd.chars().count() > MAX_CWD_CHARS || cwd.chars().any(char::is_control) {
        return Err(MethodError::invalid(format!(
            "cwd must contain at most {MAX_CWD_CHARS} characters and no control characters"
        )));
    }
    Ok(cwd.to_owned())
}

fn validate_identifier(name: &str, value: &str) -> Result<String, MethodError> {
    let value = value.trim();
    let count = value.chars().count();
    if count == 0
        || count > MAX_IDENTIFIER_CHARS
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(MethodError::invalid(format!(
            "{name} must contain 1 to {MAX_IDENTIFIER_CHARS} safe ASCII characters"
        )));
    }
    Ok(value.to_owned())
}

fn validate_browser_url(value: &str) -> Result<String, MethodError> {
    let candidate = if value.trim().is_empty() {
        DEFAULT_BROWSER_URL
    } else {
        value.trim()
    };
    if candidate.chars().count() > MAX_BROWSER_URL_CHARS
        || candidate.chars().any(char::is_control)
    {
        return Err(MethodError::invalid(format!(
            "browser URL must contain at most {MAX_BROWSER_URL_CHARS} characters and no control characters"
        )));
    }

    let url = Url::parse(candidate)
        .map_err(|error| MethodError::invalid(format!("invalid browser URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(MethodError::invalid(
            "browser URL scheme must be http or https",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(MethodError::invalid(
            "browser URL must not contain embedded credentials",
        ));
    }
    Ok(url.to_string())
}

fn default_true() -> bool {
    true
}

fn default_browser_url() -> String {
    DEFAULT_BROWSER_URL.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_workspace_creation_params() {
        let params = prepare_frontend_method(
            "workspace.create",
            json!({ "title": "  Agent work  ", "cwd": " C:\\code " }),
        )
        .expect("params should be valid")
        .expect("method should be recognized");

        assert_eq!(params["title"], "Agent work");
        assert_eq!(params["cwd"], "C:\\code");
        assert_eq!(params["activate"], true);
    }

    #[test]
    fn rejects_unknown_fields_and_unsafe_identifiers() {
        assert!(prepare_frontend_method(
            "workspace.select",
            json!({ "workspaceId": "abc", "unexpected": true })
        )
        .is_err());
        assert!(prepare_frontend_method(
            "workspace.select",
            json!({ "workspaceId": "../escape" })
        )
        .is_err());
    }

    #[test]
    fn rejects_control_characters_in_working_directory() {
        assert!(prepare_frontend_method(
            "workspace.create",
            json!({ "title": "Agent", "cwd": "C:\\code\nnext" })
        )
        .is_err());
    }

    #[test]
    fn browser_method_only_accepts_safe_http_or_https() {
        assert!(prepare_frontend_method(
            "pane.createBrowser",
            json!({ "workspaceId": "workspace-1", "url": "javascript:alert(1)" })
        )
        .is_err());
        assert!(prepare_frontend_method(
            "pane.createBrowser",
            json!({ "workspaceId": "workspace-1", "url": "https://user:secret@example.com" })
        )
        .is_err());
        assert!(prepare_frontend_method(
            "pane.createBrowser",
            json!({ "workspaceId": "workspace-1", "url": "https://example.com" })
        )
        .expect("https should be accepted")
        .is_some());
    }
}
