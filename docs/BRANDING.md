# TonyMux branding and compatibility

The Windows product is named **TonyMux**.

This rename changes the user-facing product, desktop executable, installer metadata, package names, release assets and primary CLI to TonyMux naming.

## New names

- Desktop product: `TonyMux`
- Desktop executable: `tonymux.exe`
- Rust package and default binary: `tonymux`
- Rust library crate: `tonymux_lib`
- Primary automation CLI: `tonymux-cli.exe`
- CI installer artifact: `tonymux-windows-installers`

## Compatibility retained intentionally

The following legacy identifiers remain during the migration so existing installations do not lose state or automation access:

- `cmux-cli.exe` remains as a compatibility alias and prints a deprecation notice.
- `cmux-wins.exe` remains as a local desktop compatibility alias for existing QA scripts; packaged installers use `tonymux.exe`.
- `%LOCALAPPDATA%\cmux-windows\automation-v1.json` remains the automation endpoint discovery file.
- The versioned named pipe continues to use its `cmux-windows-v1-*` name.
- Existing browser localStorage keys under `cmux-wins.workspaces.*` remain readable and writable.
- `CMUX_SHELL` remains the shell override environment variable.
- Tauri application identifier `com.hungtvb.cmuxwins` remains unchanged so Windows upgrades target the existing installation.

These identifiers are implementation compatibility contracts, not current product branding. A future protocol or persistence migration can introduce TonyMux-native identifiers with explicit dual-read migration and rollback support.

## Repository name

This code change does not rename the GitHub repository. Repository renaming is an administrative operation and should happen after open stacked pull requests, CI links and documentation references are reviewed.
