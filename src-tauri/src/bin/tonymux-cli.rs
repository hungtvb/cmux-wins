const HELP: &str = "tonymux-cli <ping|info|workspace|pane|terminal|event>\n\n\
  tonymux-cli workspace list\n\
  tonymux-cli workspace create <title> [--cwd <path>] [--no-activate]\n\
  tonymux-cli workspace select <workspace-id>\n\
  tonymux-cli workspace close <workspace-id>\n\
  tonymux-cli pane terminal <workspace-id>\n\
  tonymux-cli pane browser <workspace-id> [url]\n\
  tonymux-cli pane close <workspace-id> <pane-id>\n\
  tonymux-cli terminal write <session-id> <data> [--enter]\n\
  tonymux-cli terminal read <session-id> [--after <seq>] [--max-bytes <n>] [--wait-ms <n>]\n\
  tonymux-cli terminal run <session-id> <command> [--timeout <seconds>]\n\
  tonymux-cli event read [--after <seq>] [--max-events <n>] [--wait-ms <n>]";

#[cfg(windows)]
#[tokio::main]
async fn main() {
    let first_argument = std::env::args().nth(1);
    if first_argument
        .as_deref()
        .is_none_or(|value| matches!(value, "help" | "--help" | "-h"))
    {
        println!("{HELP}");
        return;
    }

    match tonymux_lib::automation::client::run_cli().await {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            println!(
                "{}",
                serde_json::json!({
                    "version": 1,
                    "ok": false,
                    "error": {
                        "code": "CLIENT_ERROR",
                        "message": error
                    }
                })
            );
            std::process::exit(2);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    println!(
        "{}",
        serde_json::json!({
            "version": 1,
            "ok": false,
            "error": {
                "code": "UNSUPPORTED_PLATFORM",
                "message": "tonymux-cli is supported on Windows only"
            }
        })
    );
    std::process::exit(2);
}
