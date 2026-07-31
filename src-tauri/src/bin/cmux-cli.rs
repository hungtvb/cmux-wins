#[cfg(windows)]
#[tokio::main]
async fn main() {
    match cmux_wins_lib::automation::client::run_cli().await {
        Ok(true) => {}
        Ok(false) => std::process::exit(1),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}

#[cfg(not(windows))]
fn main() {
    eprintln!("cmux-cli is supported on Windows only");
    std::process::exit(2);
}
