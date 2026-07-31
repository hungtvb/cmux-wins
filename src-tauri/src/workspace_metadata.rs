use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const LOCAL_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const NETWORK_COMMAND_TIMEOUT: Duration = Duration::from_secs(4);

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestMetadata {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub state: String,
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadata {
    pub repository: Option<String>,
    pub repository_root: Option<String>,
    pub branch: Option<String>,
    pub dirty: bool,
    pub ahead: u32,
    pub behind: u32,
    pub pull_request: Option<PullRequestMetadata>,
    pub listening_ports: Vec<u16>,
    pub available: bool,
}

fn run_bounded(
    program: &str,
    args: &[&str],
    cwd: &Path,
    timeout: Duration,
) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait().ok()? {
            Some(status) => break status,
            None if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
        }
    };

    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    status.success().then(|| output.trim().to_owned())
}

fn inspect_git(cwd: &Path) -> WorkspaceMetadata {
    let Some(root_text) = run_bounded(
        "git",
        &["rev-parse", "--show-toplevel"],
        cwd,
        LOCAL_COMMAND_TIMEOUT,
    ) else {
        return WorkspaceMetadata::default();
    };

    let root = PathBuf::from(&root_text);
    let repository = root
        .file_name()
        .and_then(|value| value.to_str())
        .map(str::to_owned);

    let branch_name = run_bounded(
        "git",
        &["branch", "--show-current"],
        &root,
        LOCAL_COMMAND_TIMEOUT,
    )
    .filter(|value| !value.is_empty())
    .or_else(|| {
        run_bounded(
            "git",
            &["rev-parse", "--short", "HEAD"],
            &root,
            LOCAL_COMMAND_TIMEOUT,
        )
        .map(|commit| format!("detached@{commit}"))
    });

    let dirty = run_bounded(
        "git",
        &["status", "--porcelain", "--untracked-files=normal"],
        &root,
        LOCAL_COMMAND_TIMEOUT,
    )
    .is_some_and(|value| !value.is_empty());

    let (behind, ahead) = run_bounded(
        "git",
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
        &root,
        LOCAL_COMMAND_TIMEOUT,
    )
    .and_then(|value| {
        let mut counts = value.split_whitespace();
        Some((counts.next()?.parse().ok()?, counts.next()?.parse().ok()?))
    })
    .unwrap_or((0, 0));

    let pull_request = run_bounded(
        "gh",
        &["pr", "view", "--json", "number,title,url,state"],
        &root,
        NETWORK_COMMAND_TIMEOUT,
    )
    .and_then(|value| serde_json::from_str::<PullRequestMetadata>(&value).ok());

    WorkspaceMetadata {
        repository,
        repository_root: Some(root_text),
        branch: branch_name,
        dirty,
        ahead,
        behind,
        pull_request,
        listening_ports: Vec::new(),
        available: true,
    }
}

#[tauri::command]
pub async fn get_workspace_metadata(cwd: String) -> Result<WorkspaceMetadata, String> {
    if cwd.trim().is_empty() {
        return Ok(WorkspaceMetadata::default());
    }

    let path = PathBuf::from(cwd);
    if !path.is_dir() {
        return Ok(WorkspaceMetadata::default());
    }

    tauri::async_runtime::spawn_blocking(move || inspect_git(&path))
        .await
        .map_err(|error| format!("workspace metadata task failed: {error}"))
}
