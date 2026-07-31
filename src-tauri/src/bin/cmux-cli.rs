#[cfg(windows)]
#[tokio::main]
async fn main() {
    match cmux_wins_lib::automation::client::run_cli().await {
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
                "message": "cmux-cli is supported on Windows only"
            }
        })
    );
    std::process::exit(2);
}
