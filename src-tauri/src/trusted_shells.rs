use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    env, fs,
    io::ErrorKind,
    path::{Path, PathBuf},
    process,
    sync::Mutex,
};
use tauri::State;

const STORE_VERSION: u32 = 1;
const STORE_FILE_NAME: &str = "trusted-shells-v1.json";
const MAX_TRUSTED_EXECUTABLES: usize = 32;
const MAX_EXECUTABLE_LENGTH: usize = 1_024;
const MAX_STORE_BYTES: u64 = 32 * 1024;

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedShellEnvelope {
    version: u32,
    executables: Vec<String>,
}

pub(crate) struct TrustedShellStore {
    path: Result<PathBuf, String>,
    executables: Mutex<BTreeSet<String>>,
    load_error: Option<String>,
}

impl Default for TrustedShellStore {
    fn default() -> Self {
        match default_store_path() {
            Ok(path) => match load_trusted_keys(&path) {
                Ok(executables) => Self {
                    path: Ok(path),
                    executables: Mutex::new(executables),
                    load_error: None,
                },
                Err(error) => Self {
                    path: Ok(path),
                    executables: Mutex::new(BTreeSet::new()),
                    load_error: Some(error),
                },
            },
            Err(error) => Self {
                path: Err(error.clone()),
                executables: Mutex::new(BTreeSet::new()),
                load_error: Some(error),
            },
        }
    }
}

impl TrustedShellStore {
    #[cfg(test)]
    pub(crate) fn from_path(path: PathBuf) -> Result<Self, String> {
        let executables = load_trusted_keys(&path)?;
        Ok(Self {
            path: Ok(path),
            executables: Mutex::new(executables),
            load_error: None,
        })
    }

    pub(crate) fn is_trusted(&self, executable: &str) -> Result<bool, String> {
        self.ensure_loaded()?;
        let key = trust_key(executable)?;
        let executables = self
            .executables
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;
        Ok(executables.contains(&key))
    }

    pub(crate) fn trust(&self, executable: &str) -> Result<bool, String> {
        self.ensure_loaded()?;
        let normalized = normalize_custom_executable(executable)?;
        validate_executable_file(&normalized)?;
        let key = normalized.to_ascii_lowercase();
        let path = self.path.as_ref().map_err(|error| error.clone())?;
        let mut executables = self
            .executables
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;

        if executables.contains(&key) {
            return Ok(true);
        }
        if executables.len() >= MAX_TRUSTED_EXECUTABLES {
            return Err(format!(
                "trusted shell store already contains the maximum of {MAX_TRUSTED_EXECUTABLES} executables"
            ));
        }

        executables.insert(key.clone());
        if let Err(error) = write_trusted_keys(path, &executables) {
            executables.remove(&key);
            return Err(error);
        }
        Ok(true)
    }

    fn ensure_loaded(&self) -> Result<(), String> {
        if let Some(error) = &self.load_error {
            return Err(error.clone());
        }
        self.path
            .as_ref()
            .map(|_| ())
            .map_err(|error| error.clone())
    }
}

#[tauri::command]
pub(crate) fn trust_shell_executable(
    store: State<'_, TrustedShellStore>,
    executable: String,
) -> Result<bool, String> {
    store.trust(&executable)
}

#[tauri::command]
pub(crate) fn is_shell_executable_trusted(
    store: State<'_, TrustedShellStore>,
    executable: String,
) -> Result<bool, String> {
    store.is_trusted(&executable)
}

pub(crate) fn normalize_custom_executable(value: &str) -> Result<String, String> {
    if value.bytes().any(|value| value < 0x20) {
        return Err("custom shell executable cannot contain control characters".to_owned());
    }
    let executable = value.trim().replace('/', "\\");
    if executable.is_empty() {
        return Err("custom shell executable path is required".to_owned());
    }
    if executable.len() > MAX_EXECUTABLE_LENGTH {
        return Err(format!(
            "custom shell executable exceeds {MAX_EXECUTABLE_LENGTH} characters"
        ));
    }
    if executable
        .bytes()
        .any(|value| matches!(value, b'%' | b'"' | b'<' | b'>' | b'|' | b'?' | b'*'))
    {
        return Err(
            "custom shell executable cannot contain environment variables, quotes, wildcards or control characters"
                .to_owned(),
        );
    }

    let bytes = executable.as_bytes();
    if bytes.len() < 4
        || !bytes[0].is_ascii_alphabetic()
        || bytes[1] != b':'
        || bytes[2] != b'\\'
    {
        return Err(
            "custom shell executable must be an absolute local Windows path".to_owned(),
        );
    }
    if executable[2..].contains(':') {
        return Err("custom shell executable contains an additional stream separator".to_owned());
    }

    let segments: Vec<&str> = executable[3..].split('\\').collect();
    if segments.is_empty()
        || segments.iter().any(|segment| {
            segment.is_empty()
                || *segment == "."
                || *segment == ".."
                || segment.ends_with('.')
                || segment.ends_with(' ')
        })
    {
        return Err(
            "custom shell executable contains an empty, relative or unsupported path segment"
                .to_owned(),
        );
    }
    if !segments
        .last()
        .is_some_and(|segment| segment.to_ascii_lowercase().ends_with(".exe"))
    {
        return Err(
            "custom shell executable must end in .exe and cannot include arguments".to_owned(),
        );
    }

    let mut normalized = executable;
    let drive = normalized[0..1].to_ascii_uppercase();
    normalized.replace_range(0..1, &drive);
    Ok(normalized)
}

fn trust_key(executable: &str) -> Result<String, String> {
    Ok(normalize_custom_executable(executable)?.to_ascii_lowercase())
}

fn validate_executable_file(executable: &str) -> Result<(), String> {
    let metadata = fs::metadata(executable)
        .map_err(|error| format!("unable to inspect custom shell executable: {error}"))?;
    if !metadata.is_file() {
        return Err("custom shell executable must reference an existing file".to_owned());
    }
    Ok(())
}

fn default_store_path() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA").ok_or_else(|| {
        "LOCALAPPDATA is not available for the current Windows user".to_owned()
    })?;
    Ok(PathBuf::from(local_app_data)
        .join("cmux-windows")
        .join(STORE_FILE_NAME))
}

fn load_trusted_keys(path: &Path) -> Result<BTreeSet<String>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(BTreeSet::new()),
        Err(error) => return Err(format!("unable to inspect trusted shell store: {error}")),
    };
    if metadata.len() > MAX_STORE_BYTES {
        return Err(format!(
            "trusted shell store exceeds the {MAX_STORE_BYTES} byte limit"
        ));
    }

    let content = fs::read(path)
        .map_err(|error| format!("unable to read trusted shell store: {error}"))?;
    let envelope: TrustedShellEnvelope = serde_json::from_slice(&content)
        .map_err(|error| format!("trusted shell store is invalid JSON: {error}"))?;
    if envelope.version != STORE_VERSION {
        return Err("trusted shell store version is not supported".to_owned());
    }
    if envelope.executables.len() > MAX_TRUSTED_EXECUTABLES {
        return Err(format!(
            "trusted shell store exceeds the maximum of {MAX_TRUSTED_EXECUTABLES} executables"
        ));
    }

    envelope
        .executables
        .into_iter()
        .map(|executable| trust_key(&executable))
        .collect()
}

fn write_trusted_keys(path: &Path, executables: &BTreeSet<String>) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "trusted shell store path has no parent directory".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("unable to create trusted shell directory: {error}"))?;

    let temporary = directory.join(format!(".{STORE_FILE_NAME}.{}.tmp", process::id()));
    let envelope = TrustedShellEnvelope {
        version: STORE_VERSION,
        executables: executables.iter().cloned().collect(),
    };
    let content = serde_json::to_vec_pretty(&envelope)
        .map_err(|error| format!("unable to encode trusted shell store: {error}"))?;
    fs::write(&temporary, content)
        .map_err(|error| format!("unable to write trusted shell store: {error}"))?;

    let backup = directory.join(format!(".{STORE_FILE_NAME}.{}.bak", process::id()));
    let had_existing_store = path.exists();
    if had_existing_store {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("unable to clear stale trusted shell backup: {error}"))?;
        }
        fs::rename(path, &backup)
            .map_err(|error| format!("unable to stage trusted shell store replacement: {error}"))?;
    }

    if let Err(error) = fs::rename(&temporary, path) {
        if had_existing_store {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("unable to publish trusted shell store: {error}"));
    }
    if had_existing_store {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_store_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        env::temp_dir().join(format!(
            "tonymux-trusted-shells-{name}-{}-{nonce}.json",
            process::id()
        ))
    }

    fn temporary_executable_path(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock should be after Unix epoch")
            .as_nanos();
        env::temp_dir().join(format!(
            "tonymux-custom-shell-{name}-{}-{nonce}.exe",
            process::id()
        ))
    }

    #[test]
    fn custom_executable_validation_is_strict_and_layout_independent() {
        assert_eq!(
            normalize_custom_executable(r"c:/Tools/My Shell/shell.exe").unwrap(),
            r"C:\Tools\My Shell\shell.exe"
        );
        for invalid in [
            r"shell.exe",
            r"\\server\share\shell.exe",
            r"C:\Tools\..\shell.exe",
            r"C:\Tools\shell.cmd",
            r"C:\Tools\shell.exe --flag",
            r"%LOCALAPPDATA%\shell.exe",
            "C:\\Tools\\shell.exe\n",
        ] {
            assert!(normalize_custom_executable(invalid).is_err(), "{invalid}");
        }
    }

    #[test]
    fn trust_store_persists_normalized_case_insensitive_paths() {
        let path = temporary_store_path("persist");
        let executable_path = temporary_executable_path("persist");
        fs::write(&executable_path, b"test executable placeholder")
            .expect("temporary executable should be written");
        let executable = executable_path.to_string_lossy().replace('\\', "/");
        let upper_case_executable = executable.to_ascii_uppercase();

        let store = TrustedShellStore::from_path(path.clone()).expect("store should load");
        assert!(!store
            .is_trusted(&executable)
            .expect("trust query should work"));
        assert!(store.trust(&executable).expect("trust should persist"));
        assert!(store
            .is_trusted(&upper_case_executable)
            .expect("trust should be case insensitive"));

        let reloaded = TrustedShellStore::from_path(path.clone()).expect("store should reload");
        assert!(reloaded
            .is_trusted(&executable)
            .expect("reloaded trust should exist"));
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(executable_path);
    }

    #[test]
    fn trust_rejects_a_missing_executable() {
        let path = temporary_store_path("missing");
        let executable_path = temporary_executable_path("missing");
        let executable = executable_path.to_string_lossy();
        let store = TrustedShellStore::from_path(path.clone()).expect("store should load");

        assert!(store.trust(&executable).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn corrupt_or_future_stores_fail_closed() {
        let corrupt_path = temporary_store_path("corrupt");
        fs::write(&corrupt_path, b"{broken").expect("corrupt store should be written");
        assert!(TrustedShellStore::from_path(corrupt_path.clone()).is_err());
        let _ = fs::remove_file(corrupt_path);

        let future_path = temporary_store_path("future");
        fs::write(
            &future_path,
            br#"{"version":99,"executables":["c:\\tools\\shell.exe"]}"#,
        )
        .expect("future store should be written");
        assert!(TrustedShellStore::from_path(future_path.clone()).is_err());
        let _ = fs::remove_file(future_path);
    }
}
