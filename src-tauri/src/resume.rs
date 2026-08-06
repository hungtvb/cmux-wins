use serde::{Deserialize, Serialize};
use std::{
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
};

/// Resume store: append-only JSONL recording the most recent agent session
/// per (agent, cwd) so TonyMux can offer a one-click "Resume" action that
/// re-attaches the agent CLI to its previous session.
///
/// Hook scripts (installed by `setup_agent_hooks`) append one JSON object per
/// line. The app dedupes on read, keeping the newest record per key. The store
/// is data only — it is never executed; the app validates the executable
/// against the trusted-shell store before spawning anything.

#[allow(dead_code)] // format version marker kept for future store migrations; mirror of ts side
pub const RESUME_STORE_VERSION: u32 = 1;
const MAX_STORE_BYTES: u64 = 1024 * 1024;
const MAX_LINE_BYTES: usize = 32 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentKind {
    Claude,
    Codex,
    Opencode,
}

impl AgentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            AgentKind::Claude => "claude",
            AgentKind::Codex => "codex",
            AgentKind::Opencode => "opencode",
        }
    }

    #[allow(dead_code)] // mirror of AGENT_DISPLAY_NAMES in src/resumeModel.ts
    pub fn display_name(self) -> &'static str {
        match self {
            AgentKind::Claude => "Claude Code",
            AgentKind::Codex => "Codex",
            AgentKind::Opencode => "opencode",
        }
    }
}

pub fn parse_agent(value: &str) -> Result<AgentKind, String> {
    match value.to_ascii_lowercase().as_str() {
        "claude" | "claude-code" => Ok(AgentKind::Claude),
        "codex" => Ok(AgentKind::Codex),
        "opencode" => Ok(AgentKind::Opencode),
        _ => Err(format!("unknown agent '{value}'; expected claude, codex or opencode")),
    }
}

/// Resolve a candidate executable (bare name or path) against PATH, returning
/// the first existing file. Bare names like `claude` resolve like the shell
/// would on Windows (`PATH`-ordered, `PATHEXT`-suffixed candidates).
#[allow(dead_code)] // used by tests; future backend trust-gate entry point
pub fn resolve_executable_path(candidate: &str) -> Option<PathBuf> {
    if candidate.is_empty() {
        return None;
    }
    let candidate_path = PathBuf::from(candidate);
    if candidate_path.is_absolute() {
        return candidate_path.is_file().then_some(candidate_path);
    }
    let path_var = env::var_os("PATH")?;
    let extensions: Vec<String> = if cfg!(windows) {
        env::var("PATHEXT")
            .unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".to_owned())
            .split(';')
            .map(str::to_owned)
            .collect()
    } else {
        Vec::new()
    };
    for dir in env::split_paths(&path_var) {
        let base = dir.join(candidate);
        if base.is_file() {
            return Some(base);
        }
        if cfg!(windows) {
            for extension in &extensions {
                let mut with_ext = base.as_os_str().to_owned();
                with_ext.push(extension);
                let candidate = PathBuf::from(with_ext);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResumeRecord {
    pub agent: AgentKind,
    pub session_id: String,
    pub cwd: String,
    pub updated_at: u64,
    /// Absolute path (resolved by the hook script at write time) of the agent
    /// CLI executable, e.g. `C:\Users\me\AppData\Local\Programs\claude\claude.exe`.
    pub executable: String,
    /// Arguments that re-attach the session, e.g. `["--resume", "<id>", "--cwd", "<dir>"]`.
    pub args: Vec<String>,
}

impl ResumeRecord {
    /// Render the record as a shell command line that the terminal pane will
    /// execute as its startup command (typed into the shell, not spawned).
    /// Single-quote every argument PowerShell-style: paths with spaces or
    /// quotes survive; a literal `'` becomes `''`.
    #[allow(dead_code)] // mirror of toStartupCommand in src/resumeModel.ts
    pub fn to_startup_command(&self) -> String {
        let mut parts = Vec::with_capacity(1 + self.args.len());
        parts.push(quote_powershell_arg(&self.executable));
        for arg in &self.args {
            parts.push(quote_powershell_arg(arg));
        }
        parts.join(" ")
    }
}

#[allow(dead_code)] // used by to_startup_command (mirror of quotePowerShellArg in resumeModel.ts)
fn quote_powershell_arg(value: &str) -> String {
    if value.is_empty() {
        return "''".to_owned();
    }
    let escaped = value.replace('\'', "''");
    if value
        .chars()
        .any(|ch| ch.is_whitespace() || ch == '"' || ch == '\'')
    {
        format!("'{escaped}'")
    } else {
        value.to_owned()
    }
}

/// Normalized key for grouping records: trimmed, trailing-separator-stripped,
/// lowercased (Windows paths are case-insensitive).
pub fn cwd_key(cwd: &str) -> String {
    let trimmed = cwd.trim().trim_end_matches(['/', '\\']);
    trimmed.to_lowercase()
}

pub fn resume_dir() -> Result<PathBuf, String> {
    if let Some(local) = env::var_os("LOCALAPPDATA") {
        return Ok(PathBuf::from(local).join("tonymux").join("resume"));
    }
    if let Some(home) = env::var_os("HOME") {
        return Ok(PathBuf::from(home).join(".tonymux").join("resume"));
    }
    Err("neither LOCALAPPDATA nor HOME is available".to_owned())
}

pub fn resume_store_path() -> Result<PathBuf, String> {
    Ok(resume_dir()?.join("resume.jsonl"))
}

/// Append a record as one JSONL line, creating the directory if needed.
#[allow(dead_code)] // used by tests; entry point for future Rust-side recorders
pub fn append_record(path: &Path, record: &ResumeRecord) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("unable to create resume store directory: {error}"))?;
    }
    let mut line = serde_json::to_string(record)
        .map_err(|error| format!("unable to encode resume record: {error}"))?;
    line.push('\n');
    if line.len() > MAX_LINE_BYTES {
        return Err("resume record exceeds maximum line size".to_owned());
    }
    let mut file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|error| format!("unable to open resume store: {error}"))?;
    file.write_all(line.as_bytes())
        .map_err(|error| format!("unable to write resume record: {error}"))?;
    Ok(())
}

/// Read all records. Malformed or oversized lines are skipped; the store is
/// capped at MAX_STORE_BYTES so a runaway hook cannot exhaust disk.
pub fn load_records(path: &Path) -> Vec<ResumeRecord> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(_) => return Vec::new(),
    };
    if metadata.len() > MAX_STORE_BYTES {
        return Vec::new();
    }
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(_) => return Vec::new(),
    };
    let reader = BufReader::new(file);
    let mut records = Vec::new();
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() || line.len() > MAX_LINE_BYTES {
            continue;
        }
        if let Ok(record) = serde_json::from_str::<ResumeRecord>(&line) {
            records.push(record);
        }
    }
    records
}

/// Keep the newest record per (agent, cwd) key, preserving read order.
pub fn latest_by_agent_and_cwd(records: &[ResumeRecord]) -> Vec<ResumeRecord> {
    let mut latest: Vec<ResumeRecord> = Vec::new();
    for record in records {
        let key = (record.agent, cwd_key(&record.cwd));
        if let Some(existing) = latest.iter_mut().find(|r| {
            r.agent == key.0 && cwd_key(&r.cwd) == key.1
        }) {
            if record.updated_at >= existing.updated_at {
                *existing = record.clone();
            }
        } else {
            latest.push(record.clone());
        }
    }
    latest
}

/// Find the newest record for one (agent, cwd) pair.
#[allow(dead_code)] // used by tests; helper for future targeted-resume lookups
pub fn find_latest(records: &[ResumeRecord], agent: AgentKind, cwd: &str) -> Option<ResumeRecord> {
    latest_by_agent_and_cwd(records)
        .into_iter()
        .find(|record| record.agent == agent && cwd_key(&record.cwd) == cwd_key(cwd))
}

/// Rewrite the store without records matching (agent, cwd). Returns the
/// number of removed records (best effort: lines that fail to parse do not
/// count and are preserved).
pub fn remove_agent_cwd(path: &Path, agent: AgentKind, cwd: &str) -> Result<usize, String> {
    if !path.exists() {
        return Ok(0);
    }
    let key = cwd_key(cwd);
    let mut removed = 0usize;
    let mut kept = String::new();
    let reader = BufReader::new(
        fs::File::open(path).map_err(|error| format!("unable to open resume store: {error}"))?,
    );
    for line in reader.lines() {
        let line = match line {
            Ok(line) => line,
            Err(_) => continue,
        };
        if line.trim().is_empty() || line.len() > MAX_LINE_BYTES {
            continue;
        }
        match serde_json::from_str::<ResumeRecord>(&line) {
            Ok(record) if record.agent == agent && cwd_key(&record.cwd) == key => {
                removed += 1;
            }
            _ => {
                kept.push_str(&line);
                kept.push('\n');
            }
        }
    }
    fs::write(path, kept).map_err(|error| format!("unable to rewrite resume store: {error}"))?;
    Ok(removed)
}

/// Remove every record (used by "clear all" and by uninstalling hooks).
pub fn clear(path: &Path) -> Result<(), String> {
    if path.exists() {
        fs::write(path, "").map_err(|error| format!("unable to clear resume store: {error}"))?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Tauri commands (store is file-based; no State required)
// ---------------------------------------------------------------------------

#[tauri::command]
pub(crate) fn get_resume_records() -> Result<Vec<ResumeRecord>, String> {
    let path = resume_store_path()?;
    Ok(latest_by_agent_and_cwd(&load_records(&path)))
}

#[tauri::command]
pub(crate) fn clear_resume_record(agent: String, cwd: String) -> Result<usize, String> {
    let kind = parse_agent(&agent)?;
    let path = resume_store_path()?;
    remove_agent_cwd(&path, kind, &cwd)
}

#[tauri::command]
pub(crate) fn clear_all_resume_records() -> Result<usize, String> {
    let path = resume_store_path()?;
    let count = load_records(&path).len();
    clear(&path)?;
    Ok(count)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn record(agent: AgentKind, session_id: &str, cwd: &str, updated_at: u64) -> ResumeRecord {
        ResumeRecord {
            agent,
            session_id: session_id.to_owned(),
            cwd: cwd.to_owned(),
            updated_at,
            executable: "C:\\tools\\claude.exe".to_owned(),
            args: vec!["--resume".to_owned(), session_id.to_owned(), "--cwd".to_owned(), cwd.to_owned()],
        }
    }

    #[test]
    fn append_and_load_round_trip() {
        let dir = temp_dir();
        let path = dir.join("resume.jsonl");
        let r1 = record(AgentKind::Claude, "abc", "C:\\proj\\app", now_ms());
        append_record(&path, &r1).unwrap();
        append_record(&path, &record(AgentKind::Codex, "xyz", "C:\\proj\\app", now_ms())).unwrap();
        let loaded = load_records(&path);
        assert_eq!(loaded.len(), 2);
        assert_eq!(loaded[0], r1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_skips_malformed_lines() {
        let dir = temp_dir();
        let path = dir.join("resume.jsonl");
        fs::create_dir_all(&dir).unwrap();
        fs::write(&path, "not json\n{\"agent\":\"claude\",\"sessionId\":\"s1\",\"cwd\":\"C:\\\\x\",\"updatedAt\":1,\"executable\":\"c\",\"args\":[]}\n").unwrap();
        let loaded = load_records(&path);
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].session_id, "s1");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn latest_keeps_newest_per_agent_and_cwd() {
        let older = record(AgentKind::Claude, "old", "C:\\Proj\\App", 100);
        let newer = record(AgentKind::Claude, "new", "C:\\proj\\app\\", 200);
        let other_agent = record(AgentKind::Codex, "codex", "C:\\proj\\app", 300);
        let other_cwd = record(AgentKind::Claude, "else", "D:\\other", 400);
        let latest = latest_by_agent_and_cwd(&[older.clone(), newer.clone(), other_agent, other_cwd]);
        assert_eq!(latest.len(), 3);
        let claude = latest
            .iter()
            .find(|r| r.agent == AgentKind::Claude && cwd_key(&r.cwd) == cwd_key("C:\\proj\\app"))
            .unwrap();
        assert_eq!(claude.session_id, "new");
    }

    #[test]
    fn remove_deletes_matching_records_only() {
        let dir = temp_dir();
        let path = dir.join("resume.jsonl");
        append_record(&path, &record(AgentKind::Claude, "a", "C:\\proj", 1)).unwrap();
        append_record(&path, &record(AgentKind::Codex, "b", "C:\\proj", 2)).unwrap();
        let removed = remove_agent_cwd(&path, AgentKind::Claude, "c:\\PROJ").unwrap();
        assert_eq!(removed, 1);
        let remaining = load_records(&path);
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].agent, AgentKind::Codex);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_empties_the_store() {
        let dir = temp_dir();
        let path = dir.join("resume.jsonl");
        append_record(&path, &record(AgentKind::Opencode, "s", "C:\\x", 1)).unwrap();
        clear(&path).unwrap();
        assert!(load_records(&path).is_empty());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn cwd_key_normalizes_case_and_trailing_separator() {
        assert_eq!(cwd_key("C:\\Proj\\App\\"), "c:\\proj\\app");
        assert_eq!(cwd_key("C:\\Proj\\App"), "c:\\proj\\app");
        assert_eq!(cwd_key("/home/me/proj"), "/home/me/proj");
        assert_eq!(cwd_key("  "), "");
    }

    #[test]
    fn startup_command_quotes_arguments() {
        let r = ResumeRecord {
            agent: AgentKind::Claude,
            session_id: "abc".to_owned(),
            cwd: "C:\\My Project\\app".to_owned(),
            updated_at: 1,
            executable: "C:\\tools\\claude.exe".to_owned(),
            args: vec![
                "--resume".to_owned(),
                "abc".to_owned(),
                "--cwd".to_owned(),
                "C:\\My Project\\app".to_owned(),
            ],
        };
        assert_eq!(
            r.to_startup_command(),
            "C:\\tools\\claude.exe --resume abc --cwd 'C:\\My Project\\app'"
        );
    }

    #[test]
    fn startup_command_escapes_quotes() {
        let r = ResumeRecord {
            agent: AgentKind::Claude,
            session_id: "s".to_owned(),
            cwd: "C:\\it's".to_owned(),
            updated_at: 1,
            executable: "claude".to_owned(),
            args: vec!["--cwd".to_owned(), "C:\\it's".to_owned()],
        };
        assert_eq!(r.to_startup_command(), "claude --cwd 'C:\\it''s'");
    }

    #[test]
    fn resolve_finds_absolute_file() {
        let current = env::current_exe().unwrap();
        let resolved = resolve_executable_path(&current.display().to_string());
        assert_eq!(resolved, Some(current));
    }

    #[test]
    fn resolve_returns_none_for_missing() {
        assert_eq!(
            resolve_executable_path("tonymux-definitely-not-a-real-tool-xyz"),
            None
        );
    }

    #[test]
    fn parse_agent_accepts_aliases() {
        assert_eq!(parse_agent("claude").unwrap(), AgentKind::Claude);
        assert_eq!(parse_agent("Claude-Code").unwrap(), AgentKind::Claude);
        assert_eq!(parse_agent("codex").unwrap(), AgentKind::Codex);
        assert_eq!(parse_agent("opencode").unwrap(), AgentKind::Opencode);
        assert!(parse_agent("gemini").is_err());
    }

    #[test]
    fn find_latest_picks_newest_for_pair() {
        let records = vec![
            record(AgentKind::Claude, "old", "C:\\p", 1),
            record(AgentKind::Claude, "new", "C:\\p", 2),
            record(AgentKind::Codex, "cx", "C:\\p", 3),
        ];
        let found = find_latest(&records, AgentKind::Claude, "c:\\p").unwrap();
        assert_eq!(found.session_id, "new");
        assert!(find_latest(&records, AgentKind::Opencode, "C:\\p").is_none());
    }

    fn temp_dir() -> PathBuf {
        let base = env::temp_dir();
        let unique = format!(
            "resume-test-{}-{}",
            std::process::id(),
            now_ms()
        );
        base.join(unique)
    }
}
