# Releasing TonyMux

Windows releases are created by `.github/workflows/windows-release.yml` from version tags. Do not create a release tag until the target commit is merged into `main` and the Windows CI plus interactive QA evidence are acceptable for that release.

## Release prerequisites

- PR changes are merged into `main`.
- Windows CI passes frontend, Rust and ConPTY jobs.
- Installer build verified on demand: **Actions → Windows CI → Run workflow → tick "Build MSI/NSIS installers"** (the `installer` job is skipped on regular PRs/pushes and runs only via this manual dispatch to save Windows runner time; release artifacts themselves are built by `windows-release.yml` on tag push).
- Issue #2 contains current Windows 11 runtime QA evidence.
- Known defects are linked from the release notes or roadmap issue #12.
- `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json` contain the same version.

## Version policy

Use semantic versions:

- Alpha: `0.2.0-alpha.1`
- Beta: `0.2.0-beta.1`
- Release candidate: `0.2.0-rc.1`
- Stable: `0.2.0`

The Git tag must add a `v` prefix and exactly match the configured version, for example `v0.2.0-beta.1`.

Tags containing `alpha`, `beta` or `rc` are published as GitHub prereleases. Stable tags are published as normal releases.

## Prepare a version

Update all three version sources:

```powershell
npm version 0.2.0-beta.1 --no-git-tag-version
```

Update `src-tauri/Cargo.toml`:

```toml
version = "0.2.0-beta.1"
```

Update `src-tauri/tauri.conf.json`:

```json
"version": "0.2.0-beta.1"
```

Commit the version bump through a reviewed pull request.

## Create a release

After the version commit is on `main`:

```powershell
git switch main
git pull --ff-only
git tag v0.2.0-beta.1
git push origin v0.2.0-beta.1
```

The release workflow will:

1. Verify the tagged commit is contained in `origin/main`.
2. Verify npm, Cargo and Tauri versions match the tag.
3. Build the frontend.
4. Run Windows ConPTY integration tests.
5. Build MSI and NSIS installers.
6. Build the TonyMux and compatibility automation CLIs.
7. Assemble and verify the deterministic portable Windows ZIP.
8. Rename assets with version and `x64` architecture.
9. Generate `SHA256SUMS.txt` and `build-metadata.json`.
10. Upload an immutable workflow artifact.
11. Create or update the matching GitHub Release.

## Release assets

Expected assets:

```text
tonymux-<version>-windows-portable-x64.zip
tonymux-<version>-x64.msi
tonymux-<version>-x64-setup.exe
SHA256SUMS.txt
build-metadata.json
```

The portable ZIP is the primary quick-test artifact. Extract the entire archive into a writable directory and run `TonyMux.exe`; no MSI/NSIS installation is required. It contains the desktop executable, `tonymux-cli.exe`, the deprecated `cmux-cli.exe` compatibility alias, portable metadata, a quick-start README and file-level checksums.

The no-install build intentionally uses the same Tauri application identifier and Windows user-data locations as the installed build. Deleting the extracted directory removes the binaries but not settings or workspace state stored under the Windows profile. This behavior is documented in `README-PORTABLE.txt` and must not change silently.

The portable build relies on the supported system Microsoft Edge WebView2 Runtime. TonyMux does not silently download or bundle an untracked runtime into the portable archive.

Verify downloaded assets:

```powershell
Get-FileHash .\tonymux-0.2.0-beta.1-windows-portable-x64.zip -Algorithm SHA256
Get-FileHash .\tonymux-0.2.0-beta.1-x64-setup.exe -Algorithm SHA256
Get-Content .\SHA256SUMS.txt
```

After extracting the portable ZIP, verify its contents:

```powershell
Get-Content .\SHA256SUMS.txt
Get-FileHash .\TonyMux.exe -Algorithm SHA256
```

## Rerunning safely

The workflow updates an existing release and uploads assets with `--clobber`, so a failed release job can be rerun after correcting infrastructure problems. Never move or recreate a published stable tag to point to different source code. Create a patch version instead.

## Code signing and SmartScreen

Issue #11 signing infrastructure is wired into the release workflow and activates the moment signing secrets exist. Until then, installers are unsigned and Windows SmartScreen may warn; published releases must state this clearly and must never describe unsigned builds as production-trusted.

### Choosing a certificate

| Option | Cost | SmartScreen reputation | Notes |
| --- | --- | --- | --- |
| OV code-signing cert (e.g. Sectigo, DigiCert) | ~$200–400/year | Good, grows with download volume | Requires organization verification; 1–3 days |
| EV code-signing cert | ~$300–500/year | Strongest, immediate reputation | Requires hardware token; company docs needed |
| Azure Trusted Signing | ~$10/month + per-signature | Strong (Microsoft root) | Cloud HSM, no token; integrates via `azure-trusted-signing-action` |
| Self-signed | Free | None (SmartScreen still warns) | Only for internal testing; never publish as trusted |

### Enabling signing

1. Obtain a certificate and export it as a PFX (for OV/EV) or configure Azure Trusted Signing.
2. Add repository secrets:
   - `CODE_SIGNING_CERT_BASE64` — base64-encoded PFX contents
   - `CODE_SIGNING_CERT_PASSWORD` — PFX password
3. The next release tag triggers the signing step (signtool, SHA-256, RFC 3161 timestamp via DigiCert) followed by mandatory `Get-AuthenticodeSignature` verification — the job fails if verification fails.

The MSI and NSIS `setup.exe` are signed. The portable ZIP is not re-signed (contained binaries can be signed before zipping in a future hardening pass); its file-level checksums remain the verification path.

### SmartScreen expectations

A new certificate shows "Unknown publisher" for a while. Reputation builds as users run the signed build and submit "More info → Run anyway". EV certificates and high download volume shorten this period. There is no code-side shortcut; treat the first weeks after switching to signing as a reputation ramp.

### Secure auto-update (staged)

A signed, opt-in Tauri updater (signed update manifests, disable-able check) is the remaining part of #11. It is intentionally staged behind real signing: the update manifest is only meaningful when installers are Authenticode-signed. Plan when signing is live: add `tauri-plugin-updater`, publish `latest.json` from the release workflow, and expose a settings toggle. Do not ship an unsigned updater.
