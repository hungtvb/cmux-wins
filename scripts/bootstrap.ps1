[CmdletBinding()]
param(
    [switch]$Build,
    [switch]$SkipInstall
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Assert-Command {
    param([Parameter(Mandatory = $true)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command '$Name' was not found in PATH. See README.md prerequisites."
    }
}

if ($env:OS -ne "Windows_NT") {
    throw "cmux Windows must be bootstrapped from Windows 11."
}

Assert-Command -Name "node"
Assert-Command -Name "npm"
Assert-Command -Name "cargo"
Assert-Command -Name "rustc"

Write-Host "Node:  $(node --version)"
Write-Host "npm:   $(npm --version)"
Write-Host "Rust:  $(rustc --version)"
Write-Host "Cargo: $(cargo --version)"

if (-not $SkipInstall) {
    Write-Host "Installing frontend dependencies..."
    npm install
}

if ($Build) {
    Write-Host "Building MSI and NSIS installers..."
    npm run tauri build
} else {
    Write-Host "Starting cmux Windows in development mode..."
    npm run tauri dev
}
