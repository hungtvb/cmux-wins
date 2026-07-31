[CmdletBinding()]
param(
    [switch]$SkipNpmInstall,
    [switch]$AutomationSmoke,
    [ValidateRange(10, 180)]
    [int]$StartupTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "src-tauri\Cargo.toml"
$releaseDirectory = Join-Path $repoRoot "src-tauri\target\release"
$appPath = Join-Path $releaseDirectory "cmux-wins.exe"
$cliPath = Join-Path $releaseDirectory "cmux-cli.exe"

function Assert-Command {
    param([Parameter(Mandatory)][string]$Name)

    if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
        throw "Required command was not found on PATH: $Name"
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$Command
    )

    Write-Host "`n==> $Name" -ForegroundColor Cyan
    & $Command
    if ($LASTEXITCODE -ne 0) {
        throw "$Name failed with exit code $LASTEXITCODE"
    }
}

function Invoke-CmuxCli {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $raw = (& $script:cliPath @Arguments 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE
    $json = $null

    try {
        $json = $raw | ConvertFrom-Json
    }
    catch {
        throw "cmux-cli returned non-JSON output for '$($Arguments -join ' ')':`n$raw"
    }

    if (-not $AllowFailure -and ($exitCode -ne 0 -or -not $json.ok)) {
        $errorCode = if ($json.error.code) { $json.error.code } else { "UNKNOWN" }
        $errorMessage = if ($json.error.message) { $json.error.message } else { $raw }
        throw "cmux-cli '$($Arguments -join ' ')' failed [$errorCode]: $errorMessage"
    }

    [PSCustomObject]@{
        ExitCode = $exitCode
        Json = $json
        Raw = $raw
    }
}

function Wait-ForAutomationUi {
    param(
        [Parameter(Mandatory)][Diagnostics.Process]$Process,
        [Parameter(Mandatory)][datetime]$Deadline
    )

    $lastFailure = "automation endpoint did not answer"
    while ((Get-Date) -lt $Deadline) {
        if ($Process.HasExited) {
            throw "cmux desktop exited before automation became ready (exit code $($Process.ExitCode))"
        }

        try {
            $ping = Invoke-CmuxCli -Arguments @("ping") -AllowFailure
            if ($ping.Json.ok) {
                $workspaceList = Invoke-CmuxCli -Arguments @("workspace", "list") -AllowFailure
                if ($workspaceList.Json.ok) {
                    return
                }
                $lastFailure = "[$($workspaceList.Json.error.code)] $($workspaceList.Json.error.message)"
            }
            else {
                $lastFailure = "[$($ping.Json.error.code)] $($ping.Json.error.message)"
            }
        }
        catch {
            $lastFailure = $_.Exception.Message
        }

        Start-Sleep -Milliseconds 500
    }

    throw "cmux automation UI was not ready within $StartupTimeoutSeconds seconds. Last result: $lastFailure"
}

Assert-Command "node"
Assert-Command "npm"
Assert-Command "cargo"

Push-Location $repoRoot
try {
    if (-not $SkipNpmInstall) {
        Invoke-Checked "Install frontend dependencies" { npm install }
    }

    Invoke-Checked "Frontend tests, type-check and Vite build" { npm run build }
    Invoke-Checked "Rust check for all targets" {
        cargo check --manifest-path $manifestPath --all-targets
    }
    Invoke-Checked "Rust unit tests" {
        cargo test --manifest-path $manifestPath --lib -- --nocapture --test-threads=1
    }
    Invoke-Checked "Windows ConPTY integration tests" {
        cargo test --manifest-path $manifestPath --test conpty_smoke -- --nocapture --test-threads=1
    }
    Invoke-Checked "Build release desktop and CLI binaries" {
        cargo build --manifest-path $manifestPath --release --bins
    }

    if (-not $AutomationSmoke) {
        Write-Host "`nLocal compile and test verification passed." -ForegroundColor Green
        Write-Host "Run again with -AutomationSmoke to exercise the named-pipe API against the desktop app."
        return
    }

    if (-not (Test-Path $appPath)) {
        throw "Desktop executable was not produced: $appPath"
    }
    if (-not (Test-Path $cliPath)) {
        throw "CLI executable was not produced: $cliPath"
    }
    if (Get-Process -Name "cmux-wins" -ErrorAction SilentlyContinue) {
        throw "A cmux-wins process is already running. Close it before the isolated automation smoke test."
    }

    Write-Host "`n==> Start desktop automation smoke" -ForegroundColor Cyan
    $desktop = Start-Process -FilePath $appPath -WorkingDirectory $repoRoot -PassThru
    $workspaceId = $null

    try {
        Wait-ForAutomationUi -Process $desktop -Deadline (Get-Date).AddSeconds($StartupTimeoutSeconds)

        $info = Invoke-CmuxCli -Arguments @("info")
        if ($info.Json.result.protocolVersion -ne 1) {
            throw "Unexpected automation protocol version: $($info.Json.result.protocolVersion)"
        }

        $title = "cmux-smoke-$([Guid]::NewGuid().ToString('N').Substring(0, 10))"
        $create = Invoke-CmuxCli -Arguments @(
            "workspace", "create", $title, "--cwd", $repoRoot
        )
        $workspaceId = [string]$create.Json.result.workspaceId
        $initialPaneId = [string]$create.Json.result.paneId
        if (-not $workspaceId -or -not $initialPaneId) {
            throw "workspace.create did not return workspace and pane IDs"
        }

        $terminal = Invoke-CmuxCli -Arguments @("pane", "terminal", $workspaceId)
        $terminalPaneId = [string]$terminal.Json.result.paneId
        $browser = Invoke-CmuxCli -Arguments @(
            "pane", "browser", $workspaceId, "https://example.com/"
        )
        $browserPaneId = [string]$browser.Json.result.paneId

        $list = Invoke-CmuxCli -Arguments @("workspace", "list")
        $createdWorkspace = @($list.Json.result.workspaces) |
            Where-Object { $_.id -eq $workspaceId } |
            Select-Object -First 1
        if (-not $createdWorkspace) {
            throw "workspace.list did not include the smoke workspace"
        }

        $paneIds = @($createdWorkspace.panes | ForEach-Object { [string]$_.id })
        foreach ($expectedPaneId in @($initialPaneId, $terminalPaneId, $browserPaneId)) {
            if ($expectedPaneId -notin $paneIds) {
                throw "workspace.list did not include expected pane: $expectedPaneId"
            }
        }

        Invoke-CmuxCli -Arguments @("pane", "close", $workspaceId, $browserPaneId) | Out-Null
        Invoke-CmuxCli -Arguments @("pane", "close", $workspaceId, $terminalPaneId) | Out-Null
        Invoke-CmuxCli -Arguments @("workspace", "close", $workspaceId) | Out-Null
        $workspaceId = $null

        Write-Host "`nDesktop named-pipe automation smoke passed." -ForegroundColor Green
    }
    finally {
        if ($workspaceId) {
            try {
                Invoke-CmuxCli -Arguments @("workspace", "close", $workspaceId) -AllowFailure | Out-Null
            }
            catch {
                Write-Warning "Unable to clean smoke workspace: $($_.Exception.Message)"
            }
        }

        if ($desktop -and -not $desktop.HasExited) {
            Stop-Process -Id $desktop.Id -Force
            $desktop.WaitForExit()
        }
    }
}
finally {
    Pop-Location
}
