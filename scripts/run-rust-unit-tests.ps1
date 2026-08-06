[CmdletBinding()]
param(
    [string]$ManifestPath = "",
    [string]$LogPath = ""
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "scripts\run-rust-unit-tests.ps1 must run on Windows."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $ManifestPath) {
    $ManifestPath = Join-Path $repoRoot "src-tauri\Cargo.toml"
}
$ManifestPath = [System.IO.Path]::GetFullPath($ManifestPath)
$manifestDirectory = Split-Path -Parent $ManifestPath
$targetDeps = Join-Path $manifestDirectory "target\debug\deps"
$appManifest = Join-Path $manifestDirectory "windows\test.manifest"

if (-not (Test-Path $ManifestPath)) {
    throw "Cargo manifest was not found: $ManifestPath"
}
if (-not (Test-Path $appManifest)) {
    throw "Windows test manifest was not found: $appManifest"
}

function Write-OutputLine {
    param(
        [Parameter(Mandatory)]
        [AllowNull()]
        [AllowEmptyString()]
        [string]$Message
    )

    if ($null -eq $Message) {
        $Message = ""
    }
    Write-Host $Message
    if ($LogPath) {
        $Message | Out-File -FilePath $LogPath -Append -Encoding utf8
    }
}

function Invoke-LoggedCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [Parameter(Mandatory)][string[]]$Arguments
    )

    # Windows PowerShell 5.1 wraps native stderr lines as NativeCommandError
    # records. Capture them with Continue and use LASTEXITCODE as the source of
    # truth so normal Cargo progress output cannot abort the harness.
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = "Continue"
        $output = & $FilePath @Arguments 2>&1
        $exitCode = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $previousErrorActionPreference
    }

    foreach ($line in @($output)) {
        $text = if ($null -eq $line) { "" } else { [string]$line }
        Write-OutputLine $text
    }
    if ($exitCode -ne 0) {
        throw "Command failed with exit code ${exitCode}: $FilePath $($Arguments -join ' ')"
    }
}

function Find-MtExe {
    $kitsRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
    if (-not (Test-Path $kitsRoot)) {
        throw "Windows SDK bin directory was not found: $kitsRoot"
    }

    $mt = Get-ChildItem -Path $kitsRoot -Filter mt.exe -File -Recurse |
        Where-Object FullName -Match '\\x64\\mt\.exe$' |
        Sort-Object FullName -Descending |
        Select-Object -First 1
    if (-not $mt) {
        throw "Windows SDK mt.exe was not found under $kitsRoot"
    }
    $mt.FullName
}

if ($LogPath) {
    $LogPath = [System.IO.Path]::GetFullPath($LogPath)
    Remove-Item -Force $LogPath -ErrorAction SilentlyContinue
}

Write-OutputLine "==> Build Rust library unit-test executable"
$buildStarted = Get-Date
Invoke-LoggedCommand "cargo" @(
    "test",
    "--manifest-path", $ManifestPath,
    "--lib",
    "--no-run"
)

# TonyMux renamed the Rust library target from cmux_wins_lib to tonymux_lib.
# Keep the legacy pattern so older stacked branches remain testable while the
# rename rolls through the stack.
$testExecutablePatterns = @(
    "tonymux_lib-*.exe",
    "cmux_wins_lib-*.exe"
)
$testCandidates = foreach ($pattern in $testExecutablePatterns) {
    Get-ChildItem -Path $targetDeps -Filter $pattern -File
}
$testExe = $testCandidates |
    Where-Object LastWriteTime -GE $buildStarted.AddSeconds(-2) |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1
if (-not $testExe) {
    $testExe = $testCandidates |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
}
if (-not $testExe) {
    throw "Cargo did not produce a TonyMux library unit-test executable in $targetDeps (patterns: $($testExecutablePatterns -join ', '))"
}

$mt = Find-MtExe
Write-OutputLine "==> Embed Common Controls v6 manifest"
Write-OutputLine "Test executable: $($testExe.FullName)"
Write-OutputLine "mt.exe: $mt"
Invoke-LoggedCommand $mt @(
    "-nologo",
    "-manifest", $appManifest,
    "-outputresource:$($testExe.FullName);#1"
)

$tempRoot = if ($env:RUNNER_TEMP) {
    $env:RUNNER_TEMP
} else {
    [System.IO.Path]::GetTempPath()
}
$extractedManifest = Join-Path $tempRoot "tonymux-unit-test-embedded.manifest"
Remove-Item -Force $extractedManifest -ErrorAction SilentlyContinue
Invoke-LoggedCommand $mt @(
    "-nologo",
    "-inputresource:$($testExe.FullName);#1",
    "-out:$extractedManifest"
)

$embedded = Get-Content -Raw $extractedManifest
if ($embedded -notmatch "Microsoft\.Windows\.Common-Controls" -or $embedded -notmatch 'version="6\.0\.0\.0"') {
    throw "Embedded test manifest does not request Microsoft.Windows.Common-Controls v6"
}
Write-OutputLine "Embedded Common Controls v6 manifest verified."

Write-OutputLine "==> Run Rust library unit tests"
Invoke-LoggedCommand $testExe.FullName @(
    "--nocapture",
    "--test-threads=1"
)
Write-OutputLine "Rust library unit tests passed."
