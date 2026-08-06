// Browser eval gate: allowlist of user-trusted origins and loopback detection.
//
// `browser.eval` automation only runs when the browser pane's current committed
// origin is a loopback address or exactly matches an entry in this allowlist.
// The list is empty by default, so the feature is fail-closed until a user
// explicitly trusts a remote origin. Modeled on trusted_shells but simpler:
// origins carry no hash or size — they are just normalized origins.

use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    env,
    fs,
    path::PathBuf,
    sync::Mutex,
};
use tauri::State;
use url::Url;

const STORE_VERSION: u32 = 1;
const STORE_FILE_NAME: &str = "browser-origins-v1.json";
const MAX_TRUSTED_ORIGINS: usize = 64;
const MAX_ORIGIN_LENGTH: usize = 2_048;
const MAX_STORE_BYTES: u64 = 128 * 1024;

/// Hosts that are always evaluable without explicit trust.
const LOOPBACK_HOSTS: &[&str] = &["localhost", "127.0.0.1", "::1", "[::1]"];

/// True when the URL is an http/https origin on a loopback host. Used by the
/// eval gate: loopback is always evaluable and never needs explicit trust.
pub(crate) fn is_localhost(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let host = match url.host_str() {
        Some(host) => host,
        None => return false,
    };
    LOOPBACK_HOSTS.contains(&host)
        || (host.starts_with("127.") && host.split('.').count() == 4)
        || host.eq_ignore_ascii_case("[::1]")
}

/// Normalized origin string (scheme + lowercase host + explicit port) for an
/// http/https URL, or None for any other scheme.
pub(crate) fn normalize_origin(url: &Url) -> Option<String> {
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.to_lowercase();
    match url.port() {
        Some(port) => Some(format!("{}://{}:{port}", url.scheme(), host)),
        None => Some(format!("{}://{}", url.scheme(), host)),
    }
}

/// Validate + normalize an origin string a user pastes into Settings
/// (e.g. `https://example.com` or `https://example.com:8443`). Loopback
/// origins are rejected: they are always allowed and need no explicit trust.
fn normalize_origin_input(value: &str) -> Result<String, String> {
    let candidate = value.trim();
    if candidate.is_empty() || candidate.chars().count() > MAX_ORIGIN_LENGTH {
        return Err(format!(
            "browser origin must contain 1 to {MAX_ORIGIN_LENGTH} characters"
        ));
    }
    if candidate.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err("browser origin must not contain NUL or newline characters".to_owned());
    }
    let url = Url::parse(candidate).map_err(|e| format!("invalid browser origin: {e}"))?;
    validate_origin_url(&url)?;
    if is_localhost(&url) {
        return Err(
            "loopback origins are always allowed for browser.eval and need no explicit trust"
                .to_owned(),
        );
    }
    Ok(normalize_origin(&url).expect("validated http/https origin normalizes"))
}

/// Reject credentials, non-http(s) schemes and path components so a trusted
/// origin entry is always a bare origin.
fn validate_origin_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("browser origin scheme must be http or https".to_owned());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("browser origin must not contain embedded credentials".to_owned());
    }
    let path = url.path();
    if !path.is_empty() && path != "/" {
        return Err("trusted browser origin must be a bare origin, not a path".to_owned());
    }
    if url.host_str().is_none() {
        return Err("browser origin has no host".to_owned());
    }
    Ok(())
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedOriginsEnvelope {
    version: u32,
    origins: Vec<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustedOriginsSnapshot {
    healthy: bool,
    error: Option<String>,
    origins: Vec<String>,
}

struct TrustedOriginsState {
    origins: BTreeSet<String>,
    load_error: Option<String>,
}

pub(crate) struct TrustedOriginsStore {
    path: Result<PathBuf, String>,
    state: Mutex<TrustedOriginsState>,
}

impl Default for TrustedOriginsStore {
    fn default() -> Self {
        match default_store_path() {
            Ok(path) => Self::from_resolved_path(path),
            Err(error) => Self {
                path: Err(error.clone()),
                state: Mutex::new(TrustedOriginsState {
                    origins: BTreeSet::new(),
                    load_error: Some(error),
                }),
            },
        }
    }
}

impl TrustedOriginsStore {
    fn from_resolved_path(path: PathBuf) -> Self {
        match load_origins(&path) {
            Ok(origins) => Self {
                path: Ok(path),
                state: Mutex::new(TrustedOriginsState {
                    origins,
                    load_error: None,
                }),
            },
            Err(error) => Self {
                path: Ok(path),
                state: Mutex::new(TrustedOriginsState {
                    origins: BTreeSet::new(),
                    load_error: Some(error),
                }),
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn from_path(path: PathBuf) -> Self {
        Self::from_resolved_path(path)
    }

    /// The eval gate: loopback always passes; remote origins must be in the
    /// allowlist, compared by normalized origin string.
    pub(crate) fn is_trusted_url(&self, url: &Url) -> Result<bool, String> {
        self.ensure_loaded()?;
        if is_localhost(url) {
            return Ok(true);
        }
        let Some(origin) = normalize_origin(url) else {
            return Ok(false);
        };
        let state = self
            .state
            .lock()
            .map_err(|_| "trusted browser-origin store lock is poisoned".to_owned())?;
        Ok(state.origins.contains(&origin))
    }

    pub(crate) fn trust(&self, origin_input: &str) -> Result<(), String> {
        self.ensure_loaded()?;
        let origin = normalize_origin_input(origin_input)?;
        let path = self.path.as_ref().map_err(|e| e.clone())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "trusted browser-origin store lock is poisoned".to_owned())?;
        if !state.origins.contains(&origin) && state.origins.len() >= MAX_TRUSTED_ORIGINS {
            return Err(format!(
                "trusted browser-origin store already contains the maximum of {MAX_TRUSTED_ORIGINS} origins"
            ));
        }
        let was_present = state.origins.contains(&origin);
        state.origins.insert(origin.clone());
        if let Err(error) = write_origins(path, &state.origins) {
            if !was_present {
                state.origins.remove(&origin);
            }
            return Err(error);
        }
        Ok(())
    }

    pub(crate) fn revoke(&self, origin_input: &str) -> Result<bool, String> {
        self.ensure_loaded()?;
        // Accept a bare host like "example.com" for convenience, defaulting to
        // https so the comparison is stable against stored entries.
        let candidate = if origin_input.contains("://") {
            origin_input.to_owned()
        } else {
            format!("https://{origin_input}")
        };
        let url = Url::parse(&candidate)
            .map_err(|e| format!("invalid browser origin: {e}"))?;
        validate_origin_url(&url)?;
        let origin = normalize_origin(&url).expect("validated origin normalizes");
        let path = self.path.as_ref().map_err(|e| e.clone())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "trusted browser-origin store lock is poisoned".to_owned())?;
        let removed = state.origins.remove(&origin);
        if let Err(error) = write_origins(path, &state.origins) {
            if removed {
                state.origins.insert(origin);
            }
            return Err(error);
        }
        Ok(removed)
    }

    pub(crate) fn clear(&self) -> Result<usize, String> {
        let path = self.path.as_ref().map_err(|e| e.clone())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "trusted browser-origin store lock is poisoned".to_owned())?;
        let previous = state.origins.clone();
        let previous_error = state.load_error.clone();
        let removed = previous.len();
        state.origins.clear();
        state.load_error = None;
        if let Err(error) = write_origins(path, &state.origins) {
            state.origins = previous;
            state.load_error = previous_error;
            return Err(error);
        }
        Ok(removed)
    }

    pub(crate) fn snapshot(&self) -> Result<TrustedOriginsSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "trusted browser-origin store lock is poisoned".to_owned())?;
        if let Some(error) = &state.load_error {
            return Ok(TrustedOriginsSnapshot {
                healthy: false,
                error: Some(error.clone()),
                origins: Vec::new(),
            });
        }
        self.path.as_ref().map_err(|e| e.clone())?;
        Ok(TrustedOriginsSnapshot {
            healthy: true,
            error: None,
            origins: state.origins.iter().cloned().collect(),
        })
    }

    fn ensure_loaded(&self) -> Result<(), String> {
        self.path.as_ref().map_err(|e| e.clone())?;
        let state = self
            .state
            .lock()
            .map_err(|_| "trusted browser-origin store lock is poisoned".to_owned())?;
        match &state.load_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }
}

fn default_store_path() -> Result<PathBuf, String> {
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local).join("tonymux").join(STORE_FILE_NAME));
    }
    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".tonymux").join(STORE_FILE_NAME));
    }
    Err("neither LOCALAPPDATA nor HOME is available".to_owned())
}

fn load_origins(path: &PathBuf) -> Result<BTreeSet<String>, String> {
    if !path.exists() {
        return Ok(BTreeSet::new());
    }
    let metadata =
        fs::metadata(path).map_err(|e| format!("unable to inspect browser-origin store: {e}"))?;
    if metadata.len() > MAX_STORE_BYTES {
        return Err("browser-origin store exceeds the size limit".to_owned());
    }
    let content = fs::read_to_string(path)
        .map_err(|e| format!("unable to read browser-origin store: {e}"))?;
    let envelope: TrustedOriginsEnvelope =
        serde_json::from_str(&content).map_err(|e| format!("invalid browser-origin store: {e}"))?;
    if envelope.version != STORE_VERSION {
        return Err("browser-origin store version is not supported".to_owned());
    }
    if envelope.origins.len() > MAX_TRUSTED_ORIGINS {
        return Err("browser-origin store exceeds the origin limit".to_owned());
    }
    for origin in &envelope.origins {
        let url = Url::parse(origin)
            .map_err(|_| "browser-origin store contains an invalid origin".to_owned())?;
        validate_origin_url(&url)
            .map_err(|_| "browser-origin store contains an invalid origin".to_owned())?;
    }
    Ok(envelope.origins.into_iter().collect())
}

fn write_origins(path: &PathBuf, origins: &BTreeSet<String>) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("unable to create browser-origin store directory: {e}"))?;
    }
    let envelope = TrustedOriginsEnvelope {
        version: STORE_VERSION,
        origins: origins.iter().cloned().collect(),
    };
    let mut text = serde_json::to_string_pretty(&envelope)
        .map_err(|e| format!("unable to encode browser-origin store: {e}"))?;
    text.push('\n');
    fs::write(path, text).map_err(|e| format!("unable to write browser-origin store: {e}"))
}

#[tauri::command]
pub(crate) fn get_trusted_browser_origins(
    store: State<'_, TrustedOriginsStore>,
) -> Result<TrustedOriginsSnapshot, String> {
    store.snapshot()
}

#[tauri::command]
pub(crate) fn trust_browser_origin(
    store: State<'_, TrustedOriginsStore>,
    origin: String,
) -> Result<(), String> {
    store.trust(&origin)
}

#[tauri::command]
pub(crate) fn revoke_browser_origin(
    store: State<'_, TrustedOriginsStore>,
    origin: String,
) -> Result<bool, String> {
    store.revoke(&origin)
}

#[tauri::command]
pub(crate) fn clear_trusted_browser_origins(
    store: State<'_, TrustedOriginsStore>,
) -> Result<usize, String> {
    store.clear()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_store() -> PathBuf {
        env::temp_dir().join(format!("browser-origins-test-{}", std::process::id()))
    }

    #[test]
    fn loopback_hosts_are_recognized() {
        for url in [
            "http://localhost:5173/",
            "http://127.0.0.1:3000/path",
            "https://127.0.0.1",
            "http://[::1]:3000/",
        ] {
            let parsed = Url::parse(url).expect("url parses");
            assert!(is_localhost(&parsed), "should detect loopback: {url}");
        }
    }

    #[test]
    fn remote_and_non_http_urls_are_not_localhost() {
        assert!(!is_localhost(&Url::parse("https://example.com/").unwrap()));
        assert!(!is_localhost(&Url::parse("file:///C:/x").unwrap()));
        assert!(!is_localhost(&Url::parse("javascript:alert(1)").unwrap()));
    }

    #[test]
    fn normalize_keeps_scheme_host_and_explicit_port() {
        let url = Url::parse("HTTPS://EXAMPLE.com:8443/path").unwrap();
        assert_eq!(normalize_origin(&url).as_deref(), Some("https://example.com:8443"));
        let bare = Url::parse("http://example.com").unwrap();
        assert_eq!(normalize_origin(&bare).as_deref(), Some("http://example.com"));
    }

    #[test]
    fn input_rejects_paths_credentials_and_loopback() {
        assert!(normalize_origin_input("https://example.com/path").is_err());
        assert!(normalize_origin_input("https://user:pass@example.com").is_err());
        assert!(normalize_origin_input("javascript:alert(1)").is_err());
        assert!(
            normalize_origin_input("http://localhost:5173").is_err(),
            "loopback needs no trust"
        );
    }

    #[test]
    fn trust_is_persisted_and_checked() {
        let path = temp_store();
        let store = TrustedOriginsStore::from_path(path.clone());
        store.trust("https://example.com:8443").unwrap();
        assert!(
            store
                .is_trusted_url(&Url::parse("https://example.com:8443/x").unwrap())
                .unwrap()
        );
        assert!(
            !store
                .is_trusted_url(&Url::parse("https://other.com").unwrap())
                .unwrap()
        );
        let _ = fs::remove_dir_all(&path);
    }

    #[test]
    fn loopback_never_requires_trust() {
        let path = temp_store();
        let store = TrustedOriginsStore::from_path(path);
        assert!(
            store
                .is_trusted_url(&Url::parse("http://127.0.0.1:5173/app").unwrap())
                .unwrap()
        );
        let _ = fs::remove_dir_all(&path);
    }

    #[test]
    fn revoke_removes_trust() {
        let path = temp_store();
        let store = TrustedOriginsStore::from_path(path.clone());
        store.trust("https://example.com").unwrap();
        assert!(store.revoke("example.com").unwrap());
        assert!(
            !store
                .is_trusted_url(&Url::parse("https://example.com/").unwrap())
                .unwrap()
        );
        assert!(!store.revoke("example.com").unwrap());
        let _ = fs::remove_dir_all(&path);
    }

    #[test]
    fn defaults_are_fail_closed() {
        let path = temp_store();
        let store = TrustedOriginsStore::from_path(path);
        let snapshot = store.snapshot().unwrap();
        assert!(snapshot.healthy);
        assert!(snapshot.origins.is_empty());
        let _ = fs::remove_dir_all(&path);
    }
}
