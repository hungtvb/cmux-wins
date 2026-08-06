[CmdletBinding()]
param(
    [switch]$SkipBuild,
    [ValidateRange(10, 180)]
    [int]$StartupTimeoutSeconds = 60
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$releaseDirectory = Join-Path $repoRoot "src-tauri\target\release"
$appCandidates = @(
    (Join-Path $releaseDirectory "tonymux.exe"),
    (Join-Path $releaseDirectory "cmux-wins.exe")
)
$cliPath = Join-Path $releaseDirectory "cmux-cli.exe"

function Invoke-Cli {
    param(
        [Parameter(Mandatory)][string[]]$Arguments,
        [switch]$AllowFailure
    )

    $raw = (& $script:cliPath @Arguments 2>&1 | Out-String).Trim()
    $exitCode = $LASTEXITCODE
    try {
        $json = $raw | ConvertFrom-Json
    }
    catch {
        throw "cmux-cli returned non-JSON output for '$($Arguments -join ' ')':`n$raw"
    }

    if (-not $AllowFailure -and ($exitCode -ne 0 -or -not $json.ok)) {
        $code = if ($json.error -and $json.error.code) { $json.error.code } else { "UNKNOWN" }
        $message = if ($json.error -and $json.error.message) { $json.error.message } else { $raw }
        throw "cmux-cli '$($Arguments -join ' ')' failed [$code]: $message"
    }

    [PSCustomObject]@{
        ExitCode = $exitCode
        Json = $json
        Raw = $raw
    }
}

function Wait-ForAutomation {
    param([Parameter(Mandatory)][datetime]$Deadline)

    $last = "not attempted"
    while ((Get-Date) -lt $Deadline) {
        try {
            $result = Invoke-Cli -Arguments @("workspace", "list") -AllowFailure
            if ($result.Json.ok) {
                return
            }
            $last = $result.Raw
        }
        catch {
            $last = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 400
    }
    throw "automation endpoint did not become ready. Last result: $last"
}

function Read-Events {
    param(
        [Parameter(Mandatory)][long]$AfterSeq,
        [int]$WaitMs = 2000
    )

    Invoke-Cli -Arguments @(
        "event", "read",
        "--after", [string]$AfterSeq,
        "--max-events", "100",
        "--wait-ms", [string]$WaitMs
    )
}

function Wait-ForCreationEvents {
    param(
        [Parameter(Mandatory)][long]$Cursor,
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$TerminalPaneId,
        [Parameter(Mandatory)][string]$BrowserPaneId,
        [Parameter(Mandatory)][datetime]$Deadline
    )

    $seen = @{
        WorkspaceCreated = $false
        WorkspaceSelected = $false
        TerminalPaneCreated = $false
        BrowserPaneCreated = $false
        TerminalStarted = $false
        AttentionRequested = $false
    }

    while ((Get-Date) -lt $Deadline) {
        $read = Read-Events -AfterSeq $Cursor
        if ($read.Json.result.dropped) {
            throw "event cursor was dropped during creation phase"
        }
        foreach ($event in @($read.Json.result.events)) {
            $Cursor = [Math]::Max($Cursor, [long]$event.seq)
            $kind = [string]$event.kind
            $payload = $event.payload
            if ($kind -eq "workspace.created" -and $payload.workspaceId -eq $WorkspaceId) {
                $seen.WorkspaceCreated = $true
            }
            elseif ($kind -eq "workspace.selected" -and $payload.workspaceId -eq $WorkspaceId) {
                $seen.WorkspaceSelected = $true
            }
            elseif ($kind -eq "pane.created" -and $payload.paneId -eq $TerminalPaneId) {
                $seen.TerminalPaneCreated = $true
            }
            elseif ($kind -eq "pane.created" -and $payload.paneId -eq $BrowserPaneId) {
                $seen.BrowserPaneCreated = $true
            }
            elseif ($kind -eq "terminal.started" -and $payload.sessionId -eq $TerminalPaneId) {
                $seen.TerminalStarted = $true
            }
            elseif ($kind -eq "attention.requested" -and $payload.paneId -eq $TerminalPaneId) {
                $seen.AttentionRequested = $true
            }
        }

        if (@($seen.Values | Where-Object { -not $_ }).Count -eq 0) {
            return [long]$Cursor
        }
    }

    $missing = @($seen.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    throw "missing creation events: $($missing -join ', ')"
}

function Wait-ForCloseEvents {
    param(
        [Parameter(Mandatory)][long]$Cursor,
        [Parameter(Mandatory)][string]$WorkspaceId,
        [Parameter(Mandatory)][string]$TerminalPaneId,
        [Parameter(Mandatory)][string]$BrowserPaneId,
        [Parameter(Mandatory)][datetime]$Deadline
    )

    $seen = @{
        TerminalPaneClosed = $false
        BrowserPaneClosed = $false
        WorkspaceClosed = $false
        TerminalClosed = $false
        AttentionCleared = $false
    }

    while ((Get-Date) -lt $Deadline) {
        $read = Read-Events -AfterSeq $Cursor
        if ($read.Json.result.dropped) {
            throw "event cursor was dropped during close phase"
        }
        foreach ($event in @($read.Json.result.events)) {
            $Cursor = [Math]::Max($Cursor, [long]$event.seq)
            $kind = [string]$event.kind
            $payload = $event.payload
            if ($kind -eq "pane.closed" -and $payload.paneId -eq $TerminalPaneId) {
                $seen.TerminalPaneClosed = $true
            }
            elseif ($kind -eq "pane.closed" -and $payload.paneId -eq $BrowserPaneId) {
                $seen.BrowserPaneClosed = $true
            }
            elseif ($kind -eq "workspace.closed" -and $payload.workspaceId -eq $WorkspaceId) {
                $seen.WorkspaceClosed = $true
            }
            elseif ($kind -eq "terminal.closed" -and $payload.sessionId -eq $TerminalPaneId) {
                $seen.TerminalClosed = $true
            }
            elseif ($kind -eq "attention.cleared" -and $payload.paneId -eq $TerminalPaneId) {
                $seen.AttentionCleared = $true
            }
        }

        if (@($seen.Values | Where-Object { -not $_ }).Count -eq 0) {
            return [long]$Cursor
        }
    }

    $missing = @($seen.GetEnumerator() | Where-Object { -not $_.Value } | ForEach-Object { $_.Key })
    throw "missing close events: $($missing -join ', ')"
}

Push-Location $repoRoot
$desktop = $null
$workspaceId = $null
try {
    if (-not $SkipBuild) {
        & (Join-Path $PSScriptRoot "verify-local.ps1") -SkipNpmInstall
        if ($LASTEXITCODE -ne 0) {
            throw "verify-local.ps1 failed with exit code $LASTEXITCODE"
        }
    }

    $appPath = @($appCandidates | Where-Object { Test-Path $_ }) | Select-Object -First 1
    if (-not $appPath) {
        throw "Desktop executable was not found. Expected one of: $($appCandidates -join ", ")"
    }
    if (-not (Test-Path $cliPath)) {
        throw "CLI executable was not found: $cliPath"
    }
    if (Get-Process -Name "tonymux", "cmux-wins" -ErrorAction SilentlyContinue) {
        throw "Close the running TonyMux process before this isolated smoke test."
    }

    Write-Host "==> Start automation event smoke" -ForegroundColor Cyan
    $desktop = Start-Process -FilePath $appPath -WorkingDirectory $repoRoot -PassThru
    Wait-ForAutomation -Deadline (Get-Date).AddSeconds($StartupTimeoutSeconds)

    $baseline = Read-Events -AfterSeq 0 -WaitMs 0
    $cursor = [long]$baseline.Json.result.latestSeq

    $title = "event-smoke-$([Guid]::NewGuid().ToString('N').Substring(0, 10))"
    $created = Invoke-Cli -Arguments @(
        "workspace", "create", $title, "--cwd", $repoRoot
    )
    $workspaceId = [string]$created.Json.result.workspaceId
    $terminalPaneId = [string]$created.Json.result.paneId
    $browser = Invoke-Cli -Arguments @(
        "pane", "browser", $workspaceId, "https://example.com/"
    )
    $browserPaneId = [string]$browser.Json.result.paneId

    $attentionCommand = "Write-Host ([char]27 + ']9;event-smoke-attention' + [char]7) -NoNewline"
    $attention = Invoke-Cli -Arguments @(
        "terminal", "run", $terminalPaneId, $attentionCommand, "--timeout", "30"
    )
    if ([int]$attention.Json.result.exitCode -ne 0) {
        throw "attention command returned non-zero exit code"
    }

    $cursor = Wait-ForCreationEvents `
        -Cursor $cursor `
        -WorkspaceId $workspaceId `
        -TerminalPaneId $terminalPaneId `
        -BrowserPaneId $browserPaneId `
        -Deadline (Get-Date).AddSeconds(30)

    Invoke-Cli -Arguments @("pane", "close", $workspaceId, $browserPaneId) | Out-Null
    Invoke-Cli -Arguments @("workspace", "close", $workspaceId) | Out-Null
    $closedWorkspaceId = $workspaceId
    $workspaceId = $null

    $cursor = Wait-ForCloseEvents `
        -Cursor $cursor `
        -WorkspaceId $closedWorkspaceId `
        -TerminalPaneId $terminalPaneId `
        -BrowserPaneId $browserPaneId `
        -Deadline (Get-Date).AddSeconds(30)

    Write-Host "Automation event journal smoke passed at cursor $cursor." -ForegroundColor Green
}
finally {
    if ($workspaceId -and $desktop -and -not $desktop.HasExited) {
        try {
            Invoke-Cli -Arguments @("workspace", "close", $workspaceId) -AllowFailure | Out-Null
        }
        catch {
            Write-Warning "Unable to remove smoke workspace: $($_.Exception.Message)"
        }
    }
    if ($desktop -and -not $desktop.HasExited) {
        Stop-Process -Id $desktop.Id -Force
        $desktop.WaitForExit()
    }
    Pop-Location
}
