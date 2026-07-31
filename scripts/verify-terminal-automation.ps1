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
$appPath = Join-Path $releaseDirectory "cmux-wins.exe"
$cliPath = Join-Path $releaseDirectory "cmux-cli.exe"
$tempRoot = Join-Path $env:TEMP "cmux-terminal-smoke-$([Guid]::NewGuid().ToString('N'))"

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

function Wait-ForCall {
    param(
        [Parameter(Mandatory)][scriptblock]$Call,
        [Parameter(Mandatory)][datetime]$Deadline,
        [Parameter(Mandatory)][string]$Description
    )

    $last = "not attempted"
    while ((Get-Date) -lt $Deadline) {
        try {
            $result = & $Call
            if ($result.Json.ok) {
                return $result
            }
            $last = $result.Raw
        }
        catch {
            $last = $_.Exception.Message
        }
        Start-Sleep -Milliseconds 400
    }

    throw "$Description did not become ready. Last result: $last"
}

function Wait-ForProcessExit {
    param(
        [Parameter(Mandatory)][Diagnostics.Process]$Process,
        [Parameter(Mandatory)][int]$TimeoutSeconds,
        [Parameter(Mandatory)][string]$Description
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while (-not $Process.HasExited -and (Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 100
        $Process.Refresh()
    }
    if (-not $Process.HasExited) {
        throw "$Description did not exit within $TimeoutSeconds seconds"
    }
}

function Test-ConcurrentClients {
    param([ValidateRange(2, 32)][int]$Count = 8)

    Write-Host "==> Test $Count concurrent named-pipe clients" -ForegroundColor Cyan
    $clients = @()
    for ($index = 0; $index -lt $Count; $index++) {
        $stdout = Join-Path $script:tempRoot "concurrent-$index.out.json"
        $stderr = Join-Path $script:tempRoot "concurrent-$index.err.txt"
        $process = Start-Process -FilePath $script:cliPath `
            -ArgumentList @("ping") `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -PassThru
        $clients += [PSCustomObject]@{
            Process = $process
            Stdout = $stdout
            Stderr = $stderr
        }
    }

    foreach ($client in $clients) {
        Wait-ForProcessExit -Process $client.Process -TimeoutSeconds 15 -Description "concurrent cmux-cli"
        $raw = (Get-Content -Raw -Path $client.Stdout -ErrorAction SilentlyContinue).Trim()
        $errors = (Get-Content -Raw -Path $client.Stderr -ErrorAction SilentlyContinue).Trim()
        if ($client.Process.ExitCode -ne 0) {
            throw "concurrent client failed with exit code $($client.Process.ExitCode): $errors $raw"
        }
        try {
            $json = $raw | ConvertFrom-Json
        }
        catch {
            throw "concurrent client returned invalid JSON: $raw $errors"
        }
        if (-not $json.ok -or -not $json.result.pong) {
            throw "concurrent client returned an unsuccessful ping: $raw"
        }
    }
}

function Start-LongPollProcess {
    param(
        [Parameter(Mandatory)][string]$PaneId,
        [Parameter(Mandatory)][long]$AfterSeq
    )

    $stdout = Join-Path $script:tempRoot "shutdown-long-poll.out.json"
    $stderr = Join-Path $script:tempRoot "shutdown-long-poll.err.txt"
    $process = Start-Process -FilePath $script:cliPath `
        -ArgumentList @(
            "terminal", "read", $PaneId,
            "--after", [string]$AfterSeq,
            "--max-bytes", "1024",
            "--wait-ms", "30000"
        ) `
        -RedirectStandardOutput $stdout `
        -RedirectStandardError $stderr `
        -PassThru

    [PSCustomObject]@{
        Process = $process
        Stdout = $stdout
        Stderr = $stderr
    }
}

Push-Location $repoRoot
$desktop = $null
$workspaceId = $null
New-Item -ItemType Directory -Path $tempRoot -Force | Out-Null
try {
    if (-not $SkipBuild) {
        & (Join-Path $PSScriptRoot "verify-local.ps1") -SkipNpmInstall
        if ($LASTEXITCODE -ne 0) {
            throw "verify-local.ps1 failed with exit code $LASTEXITCODE"
        }
    }

    if (-not (Test-Path $appPath)) {
        throw "Desktop executable was not found: $appPath"
    }
    if (-not (Test-Path $cliPath)) {
        throw "CLI executable was not found: $cliPath"
    }
    if (Get-Process -Name "cmux-wins" -ErrorAction SilentlyContinue) {
        throw "Close the running cmux-wins process before this isolated smoke test."
    }

    Write-Host "==> Start cmux terminal automation smoke" -ForegroundColor Cyan
    $desktop = Start-Process -FilePath $appPath -WorkingDirectory $repoRoot -PassThru
    Wait-ForCall -Deadline (Get-Date).AddSeconds($StartupTimeoutSeconds) `
        -Description "automation endpoint" -Call {
            Invoke-Cli -Arguments @("workspace", "list") -AllowFailure
        } | Out-Null

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Invoke-Cli -Arguments @("ping") | Out-Null
    }
    Test-ConcurrentClients -Count 8

    $title = "terminal-smoke-$([Guid]::NewGuid().ToString('N').Substring(0, 10))"
    $created = Invoke-Cli -Arguments @(
        "workspace", "create", $title, "--cwd", $repoRoot
    )
    $workspaceId = [string]$created.Json.result.workspaceId
    $paneId = [string]$created.Json.result.paneId
    if (-not $workspaceId -or -not $paneId) {
        throw "workspace.create did not return workspaceId and paneId"
    }

    Wait-ForCall -Deadline (Get-Date).AddSeconds(20) -Description "terminal session" -Call {
        Invoke-Cli -Arguments @(
            "terminal", "read", $paneId, "--max-bytes", "1024"
        ) -AllowFailure
    } | Out-Null

    $rawMarker = "raw-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    Invoke-Cli -Arguments @(
        "terminal", "write", $paneId, "Write-Output '$rawMarker'", "--enter"
    ) | Out-Null

    $rawSeen = $false
    $cursor = 0
    $rawDeadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $rawDeadline -and -not $rawSeen) {
        $read = Invoke-Cli -Arguments @(
            "terminal", "read", $paneId,
            "--after", [string]$cursor,
            "--max-bytes", "8192",
            "--wait-ms", "2000"
        )
        if ($read.Json.result.dropped) {
            throw "raw terminal output cursor was dropped"
        }
        foreach ($chunk in @($read.Json.result.chunks)) {
            $cursor = [Math]::Max($cursor, [long]$chunk.seq)
            if ([string]$chunk.data -like "*$rawMarker*") {
                $rawSeen = $true
            }
        }
    }
    if (-not $rawSeen) {
        throw "terminal.write/read did not observe the raw marker"
    }

    $success = Invoke-Cli -Arguments @(
        "terminal", "run", $paneId,
        "Write-Output 'terminal-automation-ok'",
        "--timeout", "30"
    )
    if ([int]$success.Json.result.exitCode -ne 0) {
        throw "successful terminal.run returned non-zero exit code"
    }
    if ([string]$success.Json.result.output -notlike "*terminal-automation-ok*") {
        throw "terminal.run output did not contain the success marker"
    }

    $failure = Invoke-Cli -Arguments @(
        "terminal", "run", $paneId,
        "cmd /c exit 7",
        "--timeout", "30"
    ) -AllowFailure
    if (-not $failure.Json.ok) {
        throw "terminal.run transport failed instead of returning command completion: $($failure.Raw)"
    }
    if ([int]$failure.Json.result.exitCode -ne 7 -or $failure.ExitCode -eq 0) {
        throw "terminal.run did not preserve external exit code 7"
    }

    $latest = Invoke-Cli -Arguments @(
        "terminal", "read", $paneId,
        "--after", "0",
        "--max-bytes", "8192"
    )
    $shutdownCursor = [long]$latest.Json.result.latestSeq
    $longPoll = Start-LongPollProcess -PaneId $paneId -AfterSeq $shutdownCursor
    Start-Sleep -Milliseconds 500
    if ($longPoll.Process.HasExited) {
        throw "shutdown long-poll exited before the desktop was stopped"
    }

    Write-Host "==> Test app shutdown releases long-poll client" -ForegroundColor Cyan
    Stop-Process -Id $desktop.Id -Force
    $desktop.WaitForExit()
    $desktop = $null
    Wait-ForProcessExit -Process $longPoll.Process -TimeoutSeconds 10 `
        -Description "terminal long-poll after app shutdown"

    Write-Host "==> Restart desktop and reconnect for cleanup" -ForegroundColor Cyan
    $desktop = Start-Process -FilePath $appPath -WorkingDirectory $repoRoot -PassThru
    Wait-ForCall -Deadline (Get-Date).AddSeconds($StartupTimeoutSeconds) `
        -Description "automation endpoint after restart" -Call {
            Invoke-Cli -Arguments @("workspace", "list") -AllowFailure
        } | Out-Null
    Invoke-Cli -Arguments @("workspace", "close", $workspaceId) | Out-Null
    $workspaceId = $null

    Write-Host "Terminal automation, concurrency, reconnect and shutdown smoke passed." `
        -ForegroundColor Green
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
    Remove-Item -Recurse -Force -Path $tempRoot -ErrorAction SilentlyContinue
    Pop-Location
}
