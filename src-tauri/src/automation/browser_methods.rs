use serde::Deserialize;
use serde_json::Value;
use url::Url;

const MAX_IDENTIFIER_CHARS: usize = 128;
const MAX_BROWSER_URL_CHARS: usize = 4_096;
const MAX_EXPRESSION_BYTES: usize = 4 * 1024;
const DEFAULT_BROWSER_URL: &str = "https://github.com/";

#[derive(Debug, PartialEq)]
pub(crate) enum PreparedBrowserMethod {
    Navigate { pane_id: String, url: String },
    Reload { pane_id: String },
    GoBack { pane_id: String },
    GoForward { pane_id: String },
    Close { pane_id: String },
    Eval { pane_id: String, expression: String },
}

#[derive(Debug)]
pub(crate) struct BrowserMethodError {
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl BrowserMethodError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "INVALID_REQUEST",
            message: message.into(),
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PaneIdParams {
    pane_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct NavigateParams {
    pane_id: String,
    #[serde(default = "default_browser_url")]
    url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvalParams {
    pane_id: String,
    expression: String,
}

pub(crate) fn prepare_browser_method(
    method: &str,
    params: Value,
) -> Result<Option<PreparedBrowserMethod>, BrowserMethodError> {
    match method {
        "browser.navigate" => {
            let input: NavigateParams = parse(params)?;
            let pane_id = validate_identifier("paneId", &input.pane_id)?;
            let url = validate_browser_url(&input.url)?;
            Ok(Some(PreparedBrowserMethod::Navigate { pane_id, url }))
        }
        "browser.reload" => {
            let input: PaneIdParams = parse(params)?;
            Ok(Some(PreparedBrowserMethod::Reload {
                pane_id: validate_identifier("paneId", &input.pane_id)?,
            }))
        }
        "browser.goBack" => {
            let input: PaneIdParams = parse(params)?;
            Ok(Some(PreparedBrowserMethod::GoBack {
                pane_id: validate_identifier("paneId", &input.pane_id)?,
            }))
        }
        "browser.goForward" => {
            let input: PaneIdParams = parse(params)?;
            Ok(Some(PreparedBrowserMethod::GoForward {
                pane_id: validate_identifier("paneId", &input.pane_id)?,
            }))
        }
        "browser.close" => {
            let input: PaneIdParams = parse(params)?;
            Ok(Some(PreparedBrowserMethod::Close {
                pane_id: validate_identifier("paneId", &input.pane_id)?,
            }))
        }
        "browser.eval" => {
            let input: EvalParams = parse(params)?;
            let pane_id = validate_identifier("paneId", &input.pane_id)?;
            validate_expression(&input.expression)?;
            Ok(Some(PreparedBrowserMethod::Eval {
                pane_id,
                expression: input.expression,
            }))
        }
        _ => Ok(None),
    }
}

fn parse<T>(params: Value) -> Result<T, BrowserMethodError>
where
    T: for<'de> Deserialize<'de>,
{
    serde_json::from_value(params)
        .map_err(|error| BrowserMethodError::invalid(format!("invalid browser method params: {error}")))
}

fn validate_identifier(name: &str, value: &str) -> Result<String, BrowserMethodError> {
    let value = value.trim();
    let count = value.chars().count();
    if count == 0
        || count > MAX_IDENTIFIER_CHARS
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(BrowserMethodError::invalid(format!(
            "{name} must contain 1 to {MAX_IDENTIFIER_CHARS} safe ASCII characters"
        )));
    }
    Ok(value.to_owned())
}

fn validate_browser_url(value: &str) -> Result<String, BrowserMethodError> {
    let candidate = if value.trim().is_empty() {
        DEFAULT_BROWSER_URL
    } else {
        value.trim()
    };
    if candidate.chars().count() > MAX_BROWSER_URL_CHARS
        || candidate.chars().any(char::is_control)
    {
        return Err(BrowserMethodError::invalid(format!(
            "browser URL must contain at most {MAX_BROWSER_URL_CHARS} characters and no control characters"
        )));
    }

    let url = Url::parse(candidate)
        .map_err(|error| BrowserMethodError::invalid(format!("invalid browser URL: {error}")))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(BrowserMethodError::invalid(
            "browser URL scheme must be http or https",
        ));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(BrowserMethodError::invalid(
            "browser URL must not contain embedded credentials",
        ));
    }
    Ok(url.to_string())
}

fn validate_expression(expression: &str) -> Result<(), BrowserMethodError> {
    if expression.is_empty() || expression.len() > MAX_EXPRESSION_BYTES {
        return Err(BrowserMethodError::invalid(format!(
            "expression must contain 1 to {MAX_EXPRESSION_BYTES} UTF-8 bytes"
        )));
    }
    if expression.as_bytes().contains(&0) {
        return Err(BrowserMethodError::invalid(
            "expression must not contain NUL bytes",
        ));
    }
    Ok(())
}

fn default_browser_url() -> String {
    DEFAULT_BROWSER_URL.to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_browser_navigate() {
        assert_eq!(
            prepare_browser_method(
                "browser.navigate",
                json!({ "paneId": "pane-1", "url": "https://example.com/" })
            )
            .expect("params should parse"),
            Some(PreparedBrowserMethod::Navigate {
                pane_id: "pane-1".to_owned(),
                url: "https://example.com/".to_owned(),
            })
        );
    }

    #[test]
    fn navigate_defaults_url_and_rejects_unsafe_urls() {
        assert_eq!(
            prepare_browser_method("browser.navigate", json!({ "paneId": "pane-1" }))
                .expect("default url should apply"),
            Some(PreparedBrowserMethod::Navigate {
                pane_id: "pane-1".to_owned(),
                url: DEFAULT_BROWSER_URL.to_owned(),
            })
        );
        assert!(prepare_browser_method(
            "browser.navigate",
            json!({ "paneId": "pane-1", "url": "javascript:alert(1)" })
        )
        .is_err());
        assert!(prepare_browser_method(
            "browser.navigate",
            json!({ "paneId": "pane-1", "url": "https://user:secret@example.com" })
        )
        .is_err());
    }

    #[test]
    fn parses_simple_pane_methods() {
        for (method, expected) in [
            ("browser.reload", PreparedBrowserMethod::Reload { pane_id: "pane-1".to_owned() }),
            ("browser.goBack", PreparedBrowserMethod::GoBack { pane_id: "pane-1".to_owned() }),
            ("browser.goForward", PreparedBrowserMethod::GoForward { pane_id: "pane-1".to_owned() }),
            ("browser.close", PreparedBrowserMethod::Close { pane_id: "pane-1".to_owned() }),
        ] {
            assert_eq!(
                prepare_browser_method(method, json!({ "paneId": "pane-1" }))
                    .expect("params should parse"),
                Some(expected)
            );
        }
    }

    #[test]
    fn eval_requires_bounded_expression() {
        assert_eq!(
            prepare_browser_method(
                "browser.eval",
                json!({ "paneId": "pane-1", "expression": "document.title" })
            )
            .expect("params should parse"),
            Some(PreparedBrowserMethod::Eval {
                pane_id: "pane-1".to_owned(),
                expression: "document.title".to_owned(),
            })
        );
        assert!(prepare_browser_method(
            "browser.eval",
            json!({ "paneId": "pane-1", "expression": "" })
        )
        .is_err());
        assert!(prepare_browser_method(
            "browser.eval",
            json!({ "paneId": "pane-1", "expression": "a\0b" })
        )
        .is_err());
        assert!(prepare_browser_method(
            "browser.eval",
            json!({ "paneId": "pane-1", "expression": "x".repeat(MAX_EXPRESSION_BYTES + 1) })
        )
        .is_err());
    }

    #[test]
    fn rejects_unknown_fields_and_unsafe_identifiers() {
        assert!(prepare_browser_method(
            "browser.reload",
            json!({ "paneId": "pane-1", "unexpected": true })
        )
        .is_err());
        assert!(prepare_browser_method("browser.reload", json!({ "paneId": "../escape" })).is_err());
        assert!(prepare_browser_method("browser.reload", json!({ "paneId": "" })).is_err());
    }

    #[test]
    fn unknown_methods_return_none() {
        assert!(prepare_browser_method("browser.dance", json!({})).expect("unknown returns none").is_none());
    }
}
