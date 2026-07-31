#![cfg(windows)]

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::{
    io::{Read, Write},
    process::Command,
    sync::mpsc,
    thread,
    time::{Duration, Instant},
};

const READY_MARKER: &str = "CMUX_PTY_READY";
const TEST_TIMEOUT: Duration = Duration::from_secs(12);

fn command_exists(command: &str) -> bool {
    Command::new("where.exe")
        .arg(command)
        .output()
        .map(|output| output.status.success())
        .unwrap_or(false)
}

fn wait_for_exit(child: &mut Box<dyn portable_pty::Child + Send + Sync>) -> bool {
    let deadline = Instant::now() + TEST_TIMEOUT;

    while Instant::now() < deadline {
        match child.try_wait() {
            Ok(Some(_)) => return true,
            Ok(None) => thread::sleep(Duration::from_millis(50)),
            Err(error) => panic!("unable to query PTY child status: {error}"),
        }
    }

    false
}

fn run_round_trip(shell: &str) {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("unable to open native Windows PTY");

    let mut command = CommandBuilder::new(shell);
    command.arg("-NoLogo");
    command.arg("-NoProfile");

    let mut child = pair
        .slave
        .spawn_command(command)
        .unwrap_or_else(|error| panic!("unable to spawn {shell}: {error}"));
    let mut reader = pair
        .master
        .try_clone_reader()
        .expect("unable to clone PTY reader");
    let mut writer = pair
        .master
        .take_writer()
        .expect("unable to take PTY writer");
    let master = pair.master;
    drop(pair.slave);

    let (output_tx, output_rx) = mpsc::channel::<Vec<u8>>();
    thread::spawn(move || {
        let mut buffer = [0_u8; 4096];

        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => {
                    if output_tx.send(buffer[..count].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });

    master
        .resize(PtySize {
            rows: 40,
            cols: 120,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("unable to resize ConPTY session");

    // Build the marker from character codes so terminal command echo cannot
    // produce a false positive for the expected output.
    writer
        .write_all(
            b"[Console]::WriteLine((-join (67,77,85,88,95,80,84,89,95,82,69,65,68,89 | ForEach-Object {[char]$_})))\r\n",
        )
        .expect("unable to write command to PTY");
    writer.flush().expect("unable to flush PTY writer");

    let deadline = Instant::now() + TEST_TIMEOUT;
    let mut observed = Vec::new();
    let mut marker_seen = false;

    while Instant::now() < deadline {
        match output_rx.recv_timeout(Duration::from_millis(250)) {
            Ok(chunk) => {
                observed.extend_from_slice(&chunk);
                if String::from_utf8_lossy(&observed).contains(READY_MARKER) {
                    marker_seen = true;
                    break;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    writer
        .write_all(b"exit\r\n")
        .expect("unable to request shell exit");
    writer.flush().expect("unable to flush shell exit");

    let clean_exit = wait_for_exit(&mut child);
    if !clean_exit {
        let _ = child.kill();
        let _ = wait_for_exit(&mut child);
    }

    // Never join the blocking PTY reader. Dropping all PTY/process handles
    // makes it exit naturally, while avoiding an unbounded CI hang if a
    // Windows console driver delays EOF delivery.
    drop(writer);
    drop(master);
    drop(child);
    drop(output_rx);

    let output_text = String::from_utf8_lossy(&observed);
    assert!(
        marker_seen,
        "{shell} did not return the input/output marker. Output: {output_text}"
    );
    assert!(
        clean_exit,
        "{shell} did not exit cleanly within {TEST_TIMEOUT:?}"
    );
}

#[test]
fn windows_powershell_round_trip_resize_and_exit() {
    run_round_trip("powershell.exe");
}

#[test]
fn powershell_7_round_trip_when_available() {
    if !command_exists("pwsh.exe") {
        eprintln!("pwsh.exe is not installed; optional PowerShell 7 smoke test skipped");
        return;
    }

    run_round_trip("pwsh.exe");
}

#[test]
fn killing_a_conpty_child_terminates_it() {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })
        .expect("unable to open native Windows PTY");

    let mut command = CommandBuilder::new("powershell.exe");
    command.arg("-NoLogo");
    command.arg("-NoProfile");
    command.arg("-Command");
    command.arg("Start-Sleep -Seconds 60");

    let mut child = pair
        .slave
        .spawn_command(command)
        .expect("unable to spawn long-running PowerShell child");
    assert!(child.process_id().is_some(), "PTY child has no process ID");

    child.kill().expect("unable to kill PTY child");
    assert!(
        wait_for_exit(&mut child),
        "killed PTY child did not terminate within {TEST_TIMEOUT:?}"
    );
}