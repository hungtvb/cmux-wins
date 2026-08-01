use std::path::PathBuf;

fn main() {
    tauri_build::build();

    if std::env::var_os("CARGO_CFG_WINDOWS").is_some() {
        let manifest = PathBuf::from(
            std::env::var_os("CARGO_MANIFEST_DIR")
                .expect("CARGO_MANIFEST_DIR must be set for build scripts"),
        )
        .join("windows")
        .join("test.manifest");

        println!("cargo:rerun-if-changed={}", manifest.display());
        println!("cargo:rustc-link-arg-tests=/MANIFEST:EMBED");
        println!(
            "cargo:rustc-link-arg-tests=/MANIFESTINPUT:{}",
            manifest.display()
        );
    }
}
