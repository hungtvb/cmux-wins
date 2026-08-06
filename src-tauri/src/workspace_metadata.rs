use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows::Win32::System::Threading::CREATE_NO_WINDOW;

const LOCAL_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const NETWORK_COMMAND_TIMEOUT: Duration = Duration::from_secs(4);
const PROCESS_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const TERMINATION_GRACE: Duration = Duration::from_millis(500);

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadataRequest {
    pub workspace_id: String,
    pub cwd: String,
    pub resolve_pull_request: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMetadataEntry {
    pub workspace_id: String,
    pub metadata: WorkspaceMetadata,
}

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

#[derive(Default, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessSnapshot {
    #[serde(default)]
    processes: Vec<ProcessRecord>,
    #[serde(default)]
    listeners: Vec<ListenerRecord>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessRecord {
    process_id: u32,
    parent_process_id: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ListenerRecord {
    owning_process: u32,
    local_port: u16,
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
    let mut command = Command::new(program);
    command
        .args(args)
        .current_dir(cwd)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GH_PROMPT_DISABLED", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());

    #[cfg(windows)]
    {
        // TonyMux is a GUI-subsystem process. Without CREATE_NO_WINDOW, every
        // metadata helper (especially the 15-second powershell.exe process
        // snapshot) may allocate a visible console window and steal focus from
        // the embedded terminal. Keep all bounded background helpers hidden.
        command.creation_flags(CREATE_NO_WINDOW.0);
    }

    let mut child = command.spawn().ok()?;

    let mut stdout = child.stdout.take()?;
    let (output_tx, output_rx) = mpsc::sync_channel(1);
    thread::spawn(move || {
        let mut output = String::new();
        let result = stdout.read_to_string(&mut output).map(|_| output);
        let _ = output_tx.send(result);
    });

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

    if !status.success() {
        return None;
    }

    output_rx
        .recv_timeout(TERMINATION_GRACE)
        .ok()?
        .ok()
        .map(|output| output.trim().to_owned())
}

fn inspect_process_snapshot() -> Option<ProcessSnapshot> {
    #[cfg(not(windows))]
    {
        None
    }

    #[cfg(windows)]
    {
        const SCRIPT: &str = r#"
$ErrorActionPreference = 'Stop'
$processes = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
$listeners = @(Get-NetTCPConnection -State Listen | Select-Object OwningProcess, LocalPort)
[PSCustomObject]@{ Processes = $processes; Listeners = $listeners } |
  ConvertTo-Json -Compress -Depth 4
"#;

        run_bounded(
            "powershell.exe",
            &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT],
            &std::env::temp_dir(),
            PROCESS_SNAPSHOT_TIMEOUT,
        )
        .and_then(|value| serde_json::from_str::<ProcessSnapshot>(&value).ok())
    }
}

fn ports_by_workspace(
    snapshot: &ProcessSnapshot,
    roots_by_workspace: &HashMap<String, Vec<u32>>,
) -> HashMap<String, Vec<u16>> {
    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for process in &snapshot.processes {
        children_by_parent
            .entry(process.parent_process_id)
            .or_default()
            .push(process.process_id);
    }

    roots_by_workspace
        .iter()
        .map(|(workspace_id, roots)| {
            let mut owned_processes = HashSet::new();
            let mut queue = VecDeque::from(roots.clone());

            while let Some(process_id) = queue.pop_front() {
                if !owned_processes.insert(process_id) {
                    continue;
                }

                if let Some(children) = children_by_parent.get(&process_id) {
                    queue.extend(children.iter().copied());
                }
            }

            let mut ports = snapshot
                .listeners
                .iter()
                .filter(|listener| owned_processes.contains(&listener.owning_process))
                .map(|listener| listener.local_port)
                .collect::<Vec<_>>();
            ports.sort_unstable();
            ports.dedup();

            (workspace_id.clone(), ports)
        })
        .collect()
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

pub async fn inspect_workspace_metadata_batch(
    requests: Vec<WorkspaceMetadataRequest>,
    roots_by_workspace: HashMap<String, Vec<u32>>,
) -> Result<Vec<WorkspaceMetadataEntry>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let port_map = inspect_process_snapshot()
            .map(|snapshot| ports_by_workspace(&snapshot, &roots_by_workspace))
            .unwrap_or_default();

        requests
            .into_iter()
            .map(|request| {
                let mut metadata = if request.cwd.trim().is_empty() {
                    WorkspaceMetadata::default()
                } else {
                    let path = PathBuf::from(&request.cwd);
                    if path.is_dir() {
                        inspect_git(&path, request.resolve_pull_request)
                    } else {
                        WorkspaceMetadata::default()
                    }
                };

                metadata.listening_ports = port_map
                    .get(&request.workspace_id)
                    .cloned()
                    .unwrap_or_default();

                WorkspaceMetadataEntry {
                    workspace_id: request.workspace_id,
                    metadata,
                }
            })
            .collect()
    })
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
    fn maps_only_descendant_listener_ports_to_a_workspace() {
        let snapshot = ProcessSnapshot {
            processes: vec![
                ProcessRecord {
                    process_id: 20,
                    parent_process_id: 10,
                },
                ProcessRecord {
                    process_id: 30,
                    parent_process_id: 20,
                },
                ProcessRecord {
                    process_id: 99,
                    parent_process_id: 1,
                },
            ],
            listeners: vec![
                ListenerRecord {
                    owning_process: 30,
                    local_port: 3000,
                },
                ListenerRecord {
                    owning_process: 20,
                    local_port: 5173,
                },
                ListenerRecord {
                    owning_process: 99,
                    local_port: 8080,
                },
            ],
        };
        let roots = HashMap::from([("workspace-a".to_owned(), vec![10])]);

        let result = ports_by_workspace(&snapshot, &roots);
        assert_eq!(result.get("workspace-a"), Some(&vec![3000, 5173]));
    }

    #[test]
    fn drains_large_command_output_without_blocking_the_child() {
        #[cfg(windows)]
        let (program, args) = (
            "powershell.exe",
            vec![
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "'x' * 131072",
            ],
        );
        #[cfg(not(windows))]
        let (program, args) = ("sh", vec!["-c", "head -c 131072 /dev/zero | tr '\\0' x"]);

        let output = run_bounded(program, &args, &std::env::temp_dir(), Duration::from_secs(5))
            .expect("large command output should be drained concurrently");
        assert!(output.len() >= 131_072);
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
    fn bounded_powershell_helper_has_no_visible_console_window() {
        const SCRIPT: &str = r#"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class TonyMuxConsoleProbe {
    [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
    [DllImport("user32.dll")] [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr window);
}
'@
$window = [TonyMuxConsoleProbe]::GetConsoleWindow()
if ($window -eq [IntPtr]::Zero) {
  'none'
} elseif ([TonyMuxConsoleProbe]::IsWindowVisible($window)) {
  'visible'
} else {
  'hidden'
}
"#;

        let result = run_bounded(
            "powershell.exe",
            &["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT],
            &std::env::temp_dir(),
            Duration::from_secs(10),
        )
        .expect("hidden PowerShell helper should return a console-window state");

        assert_ne!(result.trim(), "visible");
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
