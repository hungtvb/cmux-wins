use serde::{Deserialize, Serialize};
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

const LOCAL_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const NETWORK_COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const TERMINATION_GRACE: Duration = Duration::from_millis(500);

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

fn terminate_bounded(child: &mut Child) {
    let _ = child.kill();
    let deadline = Instant::now() + TERMINATION_GRACE;

    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) | Err(_) => return,
            Ok(None) => thread::sleep(Duration::from_millis(25)),
        }
    }
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
                terminate_bounded(&mut child);
                return None;
            }
        }
    };

    let mut output = String::new();
    child.stdout.take()?.read_to_string(&mut output).ok()?;
    status.success().then(|| output.trim().to_owned())
}

fn inspect_git(cwd: &Path, resolve_pull_request: bool) -> WorkspaceMetadata {
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

    let pull_request = resolve_pull_request
        .then(|| {
            run_bounded(
                "gh",
                &["pr", "view", "--json", "number,title,url,state"],
                &root,
                NETWORK_COMMAND_TIMEOUT,
            )
            .and_then(|value| serde_json::from_str::<PullRequestMetadata>(&value).ok())
        })
        .flatten();

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

    tauri::async_runtime::spawn_blocking(move || inspect_git(&path, true))
        .await
        .map_err(|error| format!("workspace metadata task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        process,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_dir(name: &str) -> PathBuf {
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock is before Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("cmux-{name}-{}-{timestamp}", process::id()))
    }

    fn git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("git is required for workspace metadata tests");
        assert!(status.success(), "git command failed: git {}", args.join(" "));
    }

    fn create_repository() -> PathBuf {
        let repository = unique_temp_dir("workspace-metadata");
        fs::create_dir_all(&repository).expect("unable to create temporary repository");
        git(&repository, &["init"]);
        git(&repository, &["config", "user.email", "ci@cmux.local"]);
        git(&repository, &["config", "user.name", "cmux CI"]);
        fs::write(repository.join("README.md"), "initial\n").expect("unable to create test file");
        git(&repository, &["add", "README.md"]);
        git(&repository, &["commit", "-m", "initial"]);
        git(&repository, &["checkout", "-b", "feature/metadata"]);
        repository
    }

    #[test]
    fn detects_repository_branch_and_dirty_state() {
        let repository = create_repository();

        let clean = inspect_git(&repository, false);
        assert!(clean.available);
        assert_eq!(clean.branch.as_deref(), Some("feature/metadata"));
        assert!(!clean.dirty);
        assert_eq!(clean.ahead, 0);
        assert_eq!(clean.behind, 0);
        assert!(clean.pull_request.is_none());

        fs::write(repository.join("README.md"), "changed\n").expect("unable to edit test file");
        let dirty = inspect_git(&repository, false);
        assert!(dirty.dirty);

        fs::remove_dir_all(repository).expect("unable to remove temporary repository");
    }

    #[test]
    fn non_repository_returns_unavailable_metadata() {
        let directory = unique_temp_dir("not-a-repository");
        fs::create_dir_all(&directory).expect("unable to create temporary directory");

        let metadata = inspect_git(&directory, false);
        assert!(!metadata.available);
        assert!(metadata.repository.is_none());

        fs::remove_dir_all(directory).expect("unable to remove temporary directory");
    }

    #[cfg(windows)]
    #[test]
    fn bounded_command_kills_a_slow_process() {
        let started = Instant::now();
        let result = run_bounded(
            "powershell.exe",
            &["-NoLogo", "-NoProfile", "-Command", "Start-Sleep -Seconds 10"],
            &std::env::temp_dir(),
            Duration::from_millis(200),
        );

        assert!(result.is_none());
        assert!(started.elapsed() < Duration::from_secs(3));
    }
}
