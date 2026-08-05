[CmdletBinding()]
param(
    [switch]$SkipNpmInstall,
    [switch]$SkipBuild,
    [switch]$AutomationSmoke,
    [ValidateRange(10, 180)]
    [int]$StartupTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "scripts\verify-local.ps1 must run on Windows."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repoRoot "src-tauri\Cargo.toml"
$releaseDirectory = Join-Path $repoRoot "src-tauri\target\release"
$appCandidates = @(
    (Join-Path $releaseDirectory "tonymux.exe"),
    (Join-Path $releaseDirectory "cmux-wins.exe")
)
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

function Get-CmuxErrorDescription {
    param(
        [Parameter(Mandatory)]$Json,
        [Parameter(Mandatory)][string]$Fallback
    )

    $errorCode = "UNKNOWN"
    $errorMessage = $Fallback
    $errorProperty = $Json.PSObject.Properties["error"]
    if ($null -ne $errorProperty -and $null -ne $errorProperty.Value) {
        $errorObject = $errorProperty.Value
        $codeProperty = $errorObject.PSObject.Properties["code"]
        $messageProperty = $errorObject.PSObject.Properties["message"]
        if ($null -ne $codeProperty -and $codeProperty.Value) {
            $errorCode = [string]$codeProperty.Value
        }
        if ($null -ne $messageProperty -and $messageProperty.Value) {
            $errorMessage = [string]$messageProperty.Value
        }
    }

    "[$errorCode] $errorMessage"
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

    $okProperty = $json.PSObject.Properties["ok"]
    $isSuccessful = $null -ne $okProperty -and [bool]$okProperty.Value
    if (-not $AllowFailure -and ($exitCode -ne 0 -or -not $isSuccessful)) {
        $description = Get-CmuxErrorDescription -Json $json -Fallback $raw
        throw "cmux-cli '$($Arguments -join ' ')' failed $description"
    }

    [PSCustomObject]@{
        ExitCode = $exitCode
        Json = $json
        Raw = $raw
        Ok = $isSuccessful
    }
}

function Wait-ForAutomationUi {
    param(
        [Parameter(Mandatory)][System.Diagnostics.Process]$Process,
        [Parameter(Mandatory)][datetime]$Deadline
    )

    $lastFailure = "automation endpoint did not answer"
    while ((Get-Date) -lt $Deadline) {
        if ($Process.HasExited) {
            throw "cmux desktop exited before automation became ready (exit code $($Process.ExitCode))"
        }

        try {
            $ping = Invoke-CmuxCli -Arguments @("ping") -AllowFailure
            if ($ping.Ok) {
                $workspaceList = Invoke-CmuxCli -Arguments @("workspace", "list") -AllowFailure
                if ($workspaceList.Ok) {
                    return
                }
                $lastFailure = Get-CmuxErrorDescription -Json $workspaceList.Json -Fallback $workspaceList.Raw
            }
            else {
                $lastFailure = Get-CmuxErrorDescription -Json $ping.Json -Fallback $ping.Raw
            }
        }
        catch {
            $lastFailure = $_.Exception.Message
        }

        Start-Sleep -Milliseconds 500
    }

    throw "cmux automation UI was not ready within $StartupTimeoutSeconds seconds. Last result: $lastFailure"
}

Push-Location $repoRoot
try {
    if (-not $SkipBuild) {
        Assert-Command "node"
        Assert-Command "npm"
        Assert-Command "cargo"

        if (-not $SkipNpmInstall) {
            Invoke-Checked "Install frontend dependencies" { npm install }
        }

        Invoke-Checked "Frontend tests, type-check and Vite build" { npm run build }
        Invoke-Checked "Rust check for all targets" {
            cargo check --manifest-path $manifestPath --all-targets
        }
        Invoke-Checked "Rust unit tests" {
            powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "run-rust-unit-tests.ps1") `
                -ManifestPath $manifestPath
        }
        Invoke-Checked "Windows ConPTY integration tests" {
            cargo test --manifest-path $manifestPath --test conpty_smoke -- --nocapture --test-threads=1
        }
        Invoke-Checked "Build release desktop and CLI binaries" {
            cargo build --manifest-path $manifestPath --release --bins
        }
    }
    else {
        Write-Host "`n==> Skip compile and test gate; use existing release binaries" -ForegroundColor Yellow
    }

    if (-not $AutomationSmoke) {
        if ($SkipBuild) {
            Write-Host "`nNo verification step was requested." -ForegroundColor Yellow
        }
        else {
            Write-Host "`nLocal compile and test verification passed." -ForegroundColor Green
            Write-Host "Run again with -AutomationSmoke to exercise the named-pipe API against the desktop app."
        }
        return
    }

    $appPath = @($appCandidates | Where-Object { Test-Path $_ }) | Select-Object -First 1
    if (-not $appPath) {
        throw "Desktop executable was not produced. Expected one of: $($appCandidates -join ", ")"
    }
    if (-not (Test-Path $cliPath)) {
        throw "CLI executable was not produced: $cliPath"
    }
    if (Get-Process -Name "tonymux", "cmux-wins" -ErrorAction SilentlyContinue) {
        throw "A TonyMux process is already running. Close it before the isolated automation smoke test."
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
