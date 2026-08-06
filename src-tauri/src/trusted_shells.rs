use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env,
    fs::{self, File, OpenOptions},
    io::{ErrorKind, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    process,
    sync::Mutex,
};
#[cfg(windows)]
use std::os::windows::fs::OpenOptionsExt;
use tauri::State;

const STORE_VERSION: u32 = 2;
const STORE_FILE_NAME: &str = "trusted-shells-v2.json";
const MAX_TRUSTED_EXECUTABLES: usize = 32;
const MAX_EXECUTABLE_LENGTH: usize = 1_024;
const MAX_EXECUTABLE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_STORE_BYTES: u64 = 64 * 1024;
const HASH_BUFFER_BYTES: usize = 64 * 1024;
#[cfg(windows)]
const FILE_SHARE_READ_ONLY: u32 = 0x0000_0001;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedExecutableRecord {
    executable: String,
    sha256: String,
    size_bytes: u64,
}

#[derive(Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TrustedShellEnvelope {
    version: u32,
    executables: Vec<TrustedExecutableRecord>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TrustedExecutableStatus {
    Trusted,
    Changed,
    Missing,
    Unavailable,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustedExecutableSnapshot {
    executable: String,
    sha256: String,
    size_bytes: u64,
    status: TrustedExecutableStatus,
    detail: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrustedShellStoreSnapshot {
    healthy: bool,
    error: Option<String>,
    entries: Vec<TrustedExecutableSnapshot>,
}

struct TrustedShellState {
    records: BTreeMap<String, TrustedExecutableRecord>,
    load_error: Option<String>,
}

pub(crate) struct TrustedShellStore {
    path: Result<PathBuf, String>,
    state: Mutex<TrustedShellState>,
}

pub(crate) struct TrustedExecutableGuard {
    executable: String,
    sha256: String,
    size_bytes: u64,
    file: File,
}

impl TrustedExecutableGuard {
    pub(crate) fn executable(&self) -> &str {
        &self.executable
    }

    pub(crate) fn verify_unchanged(&mut self) -> Result<(), String> {
        let metadata = self
            .file
            .metadata()
            .map_err(|error| format!("unable to re-inspect custom shell executable: {error}"))?;
        if metadata.len() != self.size_bytes {
            return Err(format!(
                "custom shell executable changed while it was being launched: {}",
                self.executable
            ));
        }
        self.file
            .seek(SeekFrom::Start(0))
            .map_err(|error| format!("unable to rewind custom shell executable: {error}"))?;
        let sha256 = hash_executable(&mut self.file)?;
        if sha256 != self.sha256 {
            return Err(format!(
                "custom shell executable changed while it was being launched: {}",
                self.executable
            ));
        }
        Ok(())
    }
}

impl Default for TrustedShellStore {
    fn default() -> Self {
        match default_store_path() {
            Ok(path) => Self::from_resolved_path(path),
            Err(error) => Self {
                path: Err(error.clone()),
                state: Mutex::new(TrustedShellState {
                    records: BTreeMap::new(),
                    load_error: Some(error),
                }),
            },
        }
    }
}

impl TrustedShellStore {
    fn from_resolved_path(path: PathBuf) -> Self {
        match load_trusted_records(&path) {
            Ok(records) => Self {
                path: Ok(path),
                state: Mutex::new(TrustedShellState {
                    records,
                    load_error: None,
                }),
            },
            Err(error) => Self {
                path: Ok(path),
                state: Mutex::new(TrustedShellState {
                    records: BTreeMap::new(),
                    load_error: Some(error),
                }),
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn from_path(path: PathBuf) -> Self {
        Self::from_resolved_path(path)
    }

    pub(crate) fn is_trusted(&self, executable: &str) -> Result<bool, String> {
        self.ensure_loaded()?;
        let (current, _guard) = match inspect_executable(executable) {
            Ok(value) => value,
            Err(_) => return Ok(false),
        };
        let state = self
            .state
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;
        Ok(state
            .records
            .get(&record_key(&current.executable))
            .is_some_and(|trusted| records_match(trusted, &current)))
    }

    pub(crate) fn resolve_trusted(
        &self,
        executable: &str,
    ) -> Result<TrustedExecutableGuard, String> {
        self.ensure_loaded()?;
        let (current, guard) = inspect_executable(executable)?;
        let state = self
            .state
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;
        let Some(trusted) = state.records.get(&record_key(&current.executable)) else {
            return Err(format!(
                "custom shell executable is not trusted for this Windows account: {}",
                current.executable
            ));
        };
        if !records_match(trusted, &current) {
            return Err(format!(
                "custom shell executable changed after it was trusted and must be trusted again: {}",
                current.executable
            ));
        }
        drop(state);
        Ok(TrustedExecutableGuard {
            executable: current.executable,
            sha256: current.sha256,
            size_bytes: current.size_bytes,
            file: guard,
        })
    }

    pub(crate) fn trust(&self, executable: &str) -> Result<bool, String> {
        self.ensure_loaded()?;
        let (record, mut guard) = inspect_executable(executable)?;
        verify_file_matches_record(&mut guard, &record)?;
        let key = record_key(&record.executable);
        let path = self.path.as_ref().map_err(|error| error.clone())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;

        if state.records.get(&key).is_some_and(|existing| existing == &record) {
            return Ok(true);
        }
        if !state.records.contains_key(&key) && state.records.len() >= MAX_TRUSTED_EXECUTABLES {
            return Err(format!(
                "trusted shell store already contains the maximum of {MAX_TRUSTED_EXECUTABLES} executables"
            ));
        }

        let previous = state.records.insert(key.clone(), record);
        if let Err(error) = write_trusted_records(path, &state.records) {
            match previous {
                Some(record) => {
                    state.records.insert(key, record);
                }
                None => {
                    state.records.remove(&key);
                }
            }
            return Err(error);
        }
        Ok(true)
    }

    pub(crate) fn revoke(&self, executable: &str) -> Result<bool, String> {
        self.ensure_loaded()?;
        let normalized = normalize_custom_executable(executable)?;
        let mut candidate_keys = vec![record_key(&normalized)];
        if let Ok((current, _guard)) = inspect_executable(&normalized) {
            let canonical_key = record_key(&current.executable);
            if !candidate_keys.contains(&canonical_key) {
                candidate_keys.push(canonical_key);
            }
        }

        let path = self.path.as_ref().map_err(|error| error.clone())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;
        let Some((key, removed)) = candidate_keys
            .into_iter()
            .find_map(|key| state.records.remove(&key).map(|record| (key, record)))
        else {
            return Ok(false);
        };

        if let Err(error) = write_trusted_records(path, &state.records) {
            state.records.insert(key, removed);
            return Err(error);
        }
        Ok(true)
    }

    pub(crate) fn clear(&self) -> Result<usize, String> {
        let path = self.path.as_ref().map_err(|error| error.clone())?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;
        let previous_records = state.records.clone();
        let previous_error = state.load_error.clone();
        let removed = previous_records.len();
        state.records.clear();
        state.load_error = None;

        if let Err(error) = write_trusted_records(path, &state.records) {
            state.records = previous_records;
            state.load_error = previous_error;
            return Err(error);
        }
        Ok(removed)
    }

    pub(crate) fn snapshot(&self) -> Result<TrustedShellStoreSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;
        if let Some(error) = &state.load_error {
            return Ok(TrustedShellStoreSnapshot {
                healthy: false,
                error: Some(error.clone()),
                entries: Vec::new(),
            });
        }
        self.path.as_ref().map_err(|error| error.clone())?;
        let records: Vec<TrustedExecutableRecord> = state.records.values().cloned().collect();
        drop(state);

        let entries = records
            .into_iter()
            .map(|trusted| snapshot_record(&trusted))
            .collect();
        Ok(TrustedShellStoreSnapshot {
            healthy: true,
            error: None,
            entries,
        })
    }

    fn ensure_loaded(&self) -> Result<(), String> {
        self.path.as_ref().map_err(|error| error.clone())?;
        let state = self
            .state
            .lock()
            .map_err(|_| "trusted shell store lock is poisoned".to_owned())?;
        match &state.load_error {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
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

#[tauri::command]
pub(crate) fn get_trusted_shell_store(
    store: State<'_, TrustedShellStore>,
) -> Result<TrustedShellStoreSnapshot, String> {
    store.snapshot()
}

#[tauri::command]
pub(crate) fn revoke_shell_executable(
    store: State<'_, TrustedShellStore>,
    executable: String,
) -> Result<bool, String> {
    store.revoke(&executable)
}

#[tauri::command]
pub(crate) fn clear_trusted_shell_executables(
    store: State<'_, TrustedShellStore>,
) -> Result<usize, String> {
    store.clear()
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

fn record_key(executable: &str) -> String {
    executable.to_ascii_lowercase()
}

fn records_match(trusted: &TrustedExecutableRecord, current: &TrustedExecutableRecord) -> bool {
    trusted.executable.eq_ignore_ascii_case(&current.executable)
        && trusted.size_bytes == current.size_bytes
        && trusted.sha256 == current.sha256
}

fn inspect_executable(executable: &str) -> Result<(TrustedExecutableRecord, File), String> {
    let normalized = normalize_custom_executable(executable)?;
    let mut file = open_executable_for_verification(&normalized)?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("unable to inspect custom shell executable: {error}"))?;
    if !metadata.is_file() {
        return Err("custom shell executable must reference an existing file".to_owned());
    }
    if metadata.len() > MAX_EXECUTABLE_BYTES {
        return Err(format!(
            "custom shell executable exceeds the {MAX_EXECUTABLE_BYTES} byte verification limit"
        ));
    }

    let canonical = fs::canonicalize(&normalized)
        .map_err(|error| format!("unable to canonicalize custom shell executable: {error}"))?;
    let canonical = normalize_canonical_executable(&canonical)?;
    let sha256 = hash_executable(&mut file)?;

    Ok((
        TrustedExecutableRecord {
            executable: canonical,
            sha256,
            size_bytes: metadata.len(),
        },
        file,
    ))
}

fn verify_file_matches_record(
    file: &mut File,
    expected: &TrustedExecutableRecord,
) -> Result<(), String> {
    let metadata = file
        .metadata()
        .map_err(|error| format!("unable to re-inspect custom shell executable: {error}"))?;
    if metadata.len() != expected.size_bytes {
        return Err(format!(
            "custom shell executable changed while it was being verified: {}",
            expected.executable
        ));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| format!("unable to rewind custom shell executable: {error}"))?;
    if hash_executable(file)? != expected.sha256 {
        return Err(format!(
            "custom shell executable changed while it was being verified: {}",
            expected.executable
        ));
    }
    Ok(())
}

fn hash_executable(file: &mut File) -> Result<String, String> {
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; HASH_BUFFER_BYTES];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("unable to hash custom shell executable: {error}"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn open_executable_for_verification(executable: &str) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    options.share_mode(FILE_SHARE_READ_ONLY);
    options
        .open(executable)
        .map_err(|error| format!("unable to open custom shell executable for verification: {error}"))
}

pub(crate) fn normalize_canonical_executable(path: &Path) -> Result<String, String> {
    let value = path.to_string_lossy();
    let value = value.strip_prefix("\\\\?\\").unwrap_or(&value);
    normalize_custom_executable(value)
}

fn snapshot_record(trusted: &TrustedExecutableRecord) -> TrustedExecutableSnapshot {
    if !Path::new(&trusted.executable).exists() {
        return TrustedExecutableSnapshot {
            executable: trusted.executable.clone(),
            sha256: trusted.sha256.clone(),
            size_bytes: trusted.size_bytes,
            status: TrustedExecutableStatus::Missing,
            detail: Some("The executable no longer exists at the trusted path.".to_owned()),
        };
    }

    match inspect_executable(&trusted.executable) {
        Ok((current, _guard)) if records_match(trusted, &current) => TrustedExecutableSnapshot {
            executable: trusted.executable.clone(),
            sha256: trusted.sha256.clone(),
            size_bytes: trusted.size_bytes,
            status: TrustedExecutableStatus::Trusted,
            detail: None,
        },
        Ok((_current, _guard)) => TrustedExecutableSnapshot {
            executable: trusted.executable.clone(),
            sha256: trusted.sha256.clone(),
            size_bytes: trusted.size_bytes,
            status: TrustedExecutableStatus::Changed,
            detail: Some(
                "The file identity changed after trust was granted. Trust it again before launch."
                    .to_owned(),
            ),
        },
        Err(error) => TrustedExecutableSnapshot {
            executable: trusted.executable.clone(),
            sha256: trusted.sha256.clone(),
            size_bytes: trusted.size_bytes,
            status: TrustedExecutableStatus::Unavailable,
            detail: Some(error),
        },
    }
}

fn default_store_path() -> Result<PathBuf, String> {
    let local_app_data = env::var_os("LOCALAPPDATA").ok_or_else(|| {
        "LOCALAPPDATA is not available for the current Windows user".to_owned()
    })?;
    Ok(PathBuf::from(local_app_data)
        .join("cmux-windows")
        .join(STORE_FILE_NAME))
}

fn load_trusted_records(path: &Path) -> Result<BTreeMap<String, TrustedExecutableRecord>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => return Ok(BTreeMap::new()),
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
        return Err(
            "trusted shell store version is not supported; reset it and trust executables again"
                .to_owned(),
        );
    }
    if envelope.executables.len() > MAX_TRUSTED_EXECUTABLES {
        return Err(format!(
            "trusted shell store exceeds the maximum of {MAX_TRUSTED_EXECUTABLES} executables"
        ));
    }

    let mut records = BTreeMap::new();
    for mut record in envelope.executables {
        record.executable = normalize_custom_executable(&record.executable)?;
        record.sha256 = record.sha256.to_ascii_lowercase();
        if record.sha256.len() != 64
            || !record.sha256.bytes().all(|value| value.is_ascii_hexdigit())
        {
            return Err("trusted shell store contains an invalid SHA-256 fingerprint".to_owned());
        }
        if record.size_bytes > MAX_EXECUTABLE_BYTES {
            return Err("trusted shell store contains an oversized executable record".to_owned());
        }
        let key = record_key(&record.executable);
        if records.insert(key, record).is_some() {
            return Err("trusted shell store contains duplicate executable paths".to_owned());
        }
    }
    Ok(records)
}

fn write_trusted_records(
    path: &Path,
    records: &BTreeMap<String, TrustedExecutableRecord>,
) -> Result<(), String> {
    let directory = path
        .parent()
        .ok_or_else(|| "trusted shell store path has no parent directory".to_owned())?;
    fs::create_dir_all(directory)
        .map_err(|error| format!("unable to create trusted shell directory: {error}"))?;

    let temporary = directory.join(format!(".{STORE_FILE_NAME}.{}.tmp", process::id()));
    let envelope = TrustedShellEnvelope {
        version: STORE_VERSION,
        executables: records.values().cloned().collect(),
    };
    let content = serde_json::to_vec_pretty(&envelope)
        .map_err(|error| format!("unable to encode trusted shell store: {error}"))?;
    if content.len() as u64 > MAX_STORE_BYTES {
        return Err(format!(
            "trusted shell store exceeds the {MAX_STORE_BYTES} byte limit"
        ));
    }
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
    fn trust_store_binds_canonical_path_and_sha256_identity() {
        let path = temporary_store_path("identity");
        let executable_path = temporary_executable_path("identity");
        fs::write(&executable_path, b"first executable version")
            .expect("temporary executable should be written");
        let executable = executable_path.to_string_lossy().replace('\\', "/");

        let store = TrustedShellStore::from_path(path.clone());
        assert!(!store
            .is_trusted(&executable)
            .expect("trust query should work"));
        assert!(store.trust(&executable).expect("trust should persist"));
        assert!(store
            .is_trusted(&executable)
            .expect("trusted executable should match"));

        fs::write(&executable_path, b"second executable version")
            .expect("temporary executable should be replaced");
        assert!(!store
            .is_trusted(&executable)
            .expect("changed executable should be untrusted"));
        assert_eq!(
            store.snapshot().expect("snapshot should work").entries[0].status,
            TrustedExecutableStatus::Changed
        );
        assert!(store.resolve_trusted(&executable).is_err());

        assert!(store.trust(&executable).expect("re-trust should update identity"));
        assert!(store.resolve_trusted(&executable).is_ok());

        let reloaded = TrustedShellStore::from_path(path.clone());
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
        let store = TrustedShellStore::from_path(path.clone());

        assert!(store.trust(&executable).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn revoke_and_clear_update_the_persisted_store() {
        let path = temporary_store_path("revoke");
        let first_path = temporary_executable_path("revoke-first");
        let second_path = temporary_executable_path("revoke-second");
        fs::write(&first_path, b"first").expect("first executable should be written");
        fs::write(&second_path, b"second").expect("second executable should be written");
        let first = first_path.to_string_lossy();
        let second = second_path.to_string_lossy();
        let store = TrustedShellStore::from_path(path.clone());

        store.trust(&first).expect("first trust should persist");
        store.trust(&second).expect("second trust should persist");
        assert!(store.revoke(&first).expect("revoke should persist"));
        assert!(!store.is_trusted(&first).expect("first should be revoked"));
        assert!(store.is_trusted(&second).expect("second should remain trusted"));
        assert_eq!(store.clear().expect("clear should persist"), 1);
        assert!(store
            .snapshot()
            .expect("snapshot should load")
            .entries
            .is_empty());

        let reloaded = TrustedShellStore::from_path(path.clone());
        assert!(reloaded
            .snapshot()
            .expect("reloaded snapshot should work")
            .entries
            .is_empty());
        let _ = fs::remove_file(path);
        let _ = fs::remove_file(first_path);
        let _ = fs::remove_file(second_path);
    }

    #[cfg(windows)]
    #[test]
    fn verification_guard_blocks_replacement_until_launch_check_finishes() {
        let path = temporary_store_path("guard");
        let executable_path = temporary_executable_path("guard");
        fs::write(&executable_path, b"guarded executable")
            .expect("temporary executable should be written");
        let executable = executable_path.to_string_lossy();
        let store = TrustedShellStore::from_path(path.clone());
        store.trust(&executable).expect("trust should persist");

        let mut guard = store
            .resolve_trusted(&executable)
            .expect("trusted executable should resolve");
        assert!(
            fs::write(&executable_path, b"replacement should be blocked").is_err(),
            "the verification handle must deny write/delete sharing"
        );
        guard
            .verify_unchanged()
            .expect("unchanged executable should pass the post-spawn check");
        drop(guard);
        fs::write(&executable_path, b"replacement after guard release")
            .expect("replacement should work after guard release");

        let _ = fs::remove_file(path);
        let _ = fs::remove_file(executable_path);
    }

    #[test]
    fn corrupt_or_future_stores_fail_closed_and_can_be_reset() {
        for (name, content) in [
            ("corrupt", b"{broken".as_slice()),
            (
                "future",
                br#"{"version":99,"executables":[]}"#.as_slice(),
            ),
        ] {
            let path = temporary_store_path(name);
            fs::write(&path, content).expect("invalid store should be written");
            let store = TrustedShellStore::from_path(path.clone());
            let snapshot = store.snapshot().expect("snapshot should report load error");
            assert!(!snapshot.healthy);
            assert!(store.trust(r"C:\Tools\shell.exe").is_err());
            assert_eq!(store.clear().expect("reset should recover the store"), 0);
            assert!(store.snapshot().expect("store should recover").healthy);
            let reloaded = TrustedShellStore::from_path(path.clone());
            assert!(reloaded.snapshot().expect("store should reload").healthy);
            let _ = fs::remove_file(path);
        }
    }
}
