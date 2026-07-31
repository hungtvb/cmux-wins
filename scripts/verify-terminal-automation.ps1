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

Push-Location $repoRoot
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
    $workspaceId = $null

    try {
        $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
        Wait-ForCall -Deadline $deadline -Description "automation endpoint" -Call {
            Invoke-Cli -Arguments @("workspace", "list") -AllowFailure
        } | Out-Null

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
            "Write-Error 'expected-terminal-failure'",
            "--timeout", "30"
        ) -AllowFailure
        if (-not $failure.Json.ok) {
            throw "terminal.run transport failed instead of returning command completion: $($failure.Raw)"
        }
        if ([int]$failure.Json.result.exitCode -eq 0 -or $failure.ExitCode -eq 0) {
            throw "failing terminal.run did not propagate a non-zero process status"
        }

        Invoke-Cli -Arguments @("workspace", "close", $workspaceId) | Out-Null
        $workspaceId = $null
        Write-Host "Terminal automation smoke passed." -ForegroundColor Green
    }
    finally {
        if ($workspaceId) {
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
    }
}
finally {
    Pop-Location
}
