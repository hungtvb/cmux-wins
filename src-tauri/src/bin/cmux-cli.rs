#[cfg(windows)]
#[tokio::main]
async fn main() {
    eprintln!("cmux-cli is a compatibility alias; use tonymux-cli for new integrations.");
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
                "message": "cmux-cli is a legacy TonyMux compatibility alias supported on Windows only"
            }
        })
    );
    std::process::exit(2);
}
