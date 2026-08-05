[CmdletBinding()]
param(
    [string]$OutputRoot,
    [string[]]$InstallerPaths = @(),
    [switch]$SkipNpmInstall,
    [switch]$SkipBuild,
    [switch]$SkipAutomationSmoke,
    [switch]$IncludeTerminalAutomation,
    [switch]$IncludeEventAutomation,
    [ValidateRange(10, 180)]
    [int]$StartupTimeoutSeconds = 60,
    [switch]$NoArchive
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "scripts\collect-windows-qa-evidence.ps1 must run on Windows 11."
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$generatedAt = (Get-Date).ToUniversalTime()
$runId = $generatedAt.ToString("yyyyMMddTHHmmssZ")
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
    $OutputRoot = Join-Path $repoRoot "artifacts\windows-qa"
}
$evidenceDirectory = Join-Path $OutputRoot $runId
$logsDirectory = Join-Path $evidenceDirectory "logs"
$snapshotsDirectory = Join-Path $evidenceDirectory "snapshots"
$stepResults = @()

New-Item -ItemType Directory -Path $logsDirectory -Force | Out-Null
New-Item -ItemType Directory -Path $snapshotsDirectory -Force | Out-Null

function ConvertTo-SafeFileName {
    param([Parameter(Mandatory)][string]$Value)

    $safe = $Value.ToLowerInvariant() -replace "[^a-z0-9]+", "-"
    $safe.Trim("-")
}

function Get-SafeCommandText {
    param(
        [Parameter(Mandatory)][string]$Name,
        [string[]]$Arguments = @()
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        return $null
    }

    try {
        (& $command.Source @Arguments 2>&1 | Out-String).Trim()
    }
    catch {
        "unavailable: $($_.Exception.Message)"
    }
}

function Get-GitText {
    param([Parameter(Mandatory)][string[]]$Arguments)

    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) {
        return $null
    }

    try {
        (& $git.Source -C $repoRoot @Arguments 2>&1 | Out-String).Trim()
    }
    catch {
        return $null
    }
}

function Get-OptionalPropertyValue {
    param(
        [Parameter(Mandatory)]$InputObject,
        [Parameter(Mandatory)][string[]]$Names
    )

    foreach ($name in $Names) {
        $property = $InputObject.PSObject.Properties[$name]
        if ($null -ne $property -and
            -not [string]::IsNullOrWhiteSpace([string]$property.Value)) {
            return $property.Value
        }
    }

    $null
}

function Get-WebView2RuntimeVersion {
    $registryRoots = @(
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\*",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\*"
    )

    foreach ($root in $registryRoots) {
        $clients = Get-ItemProperty -Path $root -ErrorAction SilentlyContinue
        foreach ($client in @($clients)) {
            $displayName = Get-OptionalPropertyValue -InputObject $client `
                -Names @("name", "DisplayName")
            if ([string]$displayName -like "*WebView2 Runtime*") {
                $version = Get-OptionalPropertyValue -InputObject $client `
                    -Names @("pv", "version")
                if ($version) {
                    return [string]$version
                }
            }
        }
    }

    $null
}

function Get-ProcessSnapshot {
    $names = @("tonymux", "cmux-wins", "powershell", "pwsh")
    $rows = foreach ($name in $names) {
        foreach ($process in @(Get-Process -Name $name -ErrorAction SilentlyContinue)) {
            $startedAt = $null
            try {
                $startedAt = $process.StartTime.ToUniversalTime().ToString("o")
            }
            catch {
                $startedAt = $null
            }

            [PSCustomObject]@{
                processName = $process.ProcessName
                id = $process.Id
                startedAtUtc = $startedAt
            }
        }
    }

    @($rows | Sort-Object processName, id)
}

function Get-ListeningPortSnapshot {
    $connections = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue
    $processNames = @{}

    foreach ($connection in @($connections)) {
        $processId = [int]$connection.OwningProcess
        if (-not $processNames.ContainsKey($processId)) {
            $processName = $null
            try {
                $processName = (Get-Process -Id $processId -ErrorAction Stop).ProcessName
            }
            catch {
                $processName = $null
            }
            $processNames[$processId] = $processName
        }
    }

    @($connections | ForEach-Object {
        [PSCustomObject]@{
            localAddress = [string]$_.LocalAddress
            localPort = [int]$_.LocalPort
            owningProcess = [int]$_.OwningProcess
            processName = $processNames[[int]$_.OwningProcess]
        }
    } | Sort-Object localPort, owningProcess)
}

function Save-JsonFile {
    param(
        [Parameter(Mandatory)]$Value,
        [Parameter(Mandatory)][string]$Path
    )

    $json = ConvertTo-Json -InputObject $Value -Depth 12
    $json | Set-Content -Path $Path -Encoding UTF8
}

function Add-StepResult {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][ValidateSet("passed", "failed", "skipped")][string]$Status,
        [Parameter(Mandatory)][datetime]$StartedAt,
        [Parameter(Mandatory)][datetime]$FinishedAt,
        [Parameter(Mandatory)][string]$LogFile,
        [string]$Message
    )

    $script:stepResults += [PSCustomObject]@{
        name = $Name
        status = $Status
        startedAtUtc = $StartedAt.ToUniversalTime().ToString("o")
        finishedAtUtc = $FinishedAt.ToUniversalTime().ToString("o")
        durationSeconds = [Math]::Round(($FinishedAt - $StartedAt).TotalSeconds, 3)
        logFile = $LogFile
        message = $Message
    }
}

function Invoke-EvidenceScript {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][string]$ScriptPath,
        [hashtable]$Parameters = @{},
        [switch]$Skip,
        [string]$SkipReason = "not requested"
    )

    $slug = ConvertTo-SafeFileName -Value $Name
    $relativeLogPath = "logs/$slug.log"
    $logPath = Join-Path $evidenceDirectory ($relativeLogPath -replace "/", "\")
    $startedAt = Get-Date

    if ($Skip) {
        "SKIPPED: $SkipReason" | Set-Content -Path $logPath -Encoding UTF8
        Add-StepResult -Name $Name -Status "skipped" -StartedAt $startedAt `
            -FinishedAt (Get-Date) -LogFile $relativeLogPath -Message $SkipReason
        return
    }

    Write-Host "`n==> Evidence step: $Name" -ForegroundColor Cyan
    try {
        & $ScriptPath @Parameters *>&1 | Tee-Object -FilePath $logPath
        Add-StepResult -Name $Name -Status "passed" -StartedAt $startedAt `
            -FinishedAt (Get-Date) -LogFile $relativeLogPath
    }
    catch {
        $failure = $_ | Out-String
        $failure | Tee-Object -FilePath $logPath -Append | Write-Host
        Add-StepResult -Name $Name -Status "failed" -StartedAt $startedAt `
            -FinishedAt (Get-Date) -LogFile $relativeLogPath `
            -Message $_.Exception.Message
    }
}

function Get-FileEvidence {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Kind
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        return $null
    }

    $item = Get-Item -LiteralPath $Path
    $hash = Get-FileHash -LiteralPath $Path -Algorithm SHA256
    [PSCustomObject]@{
        kind = $Kind
        fileName = $item.Name
        sizeBytes = [long]$item.Length
        sha256 = $hash.Hash.ToLowerInvariant()
    }
}

function Get-ManualChecklist {
    $qaPath = Join-Path $repoRoot "docs\WINDOWS-QA.md"
    $content = Get-Content -Raw -Path $qaPath
    $startMarker = "## Interactive smoke checklist"
    $endMarker = "## Exit criteria for issue #2 and stacked PRs"
    $start = $content.IndexOf($startMarker, [StringComparison]::Ordinal)
    $end = $content.IndexOf($endMarker, [StringComparison]::Ordinal)

    if ($start -lt 0 -or $end -le $start) {
        throw "Unable to extract the manual checklist from docs\WINDOWS-QA.md"
    }

    $header = @"
# TonyMux Windows 11 Manual QA Checklist

Generated for commit: $($script:gitCommit)
Generated at: $($script:generatedAt.ToString("o"))

Automated evidence does **not** mark any item below as passed. Complete these checks on the tested Windows 11 device and attach screenshots or linked defects where applicable.

"@
    $header + $content.Substring($start, $end - $start).Trim() + "`r`n"
}

function Test-EvidenceForSecrets {
    $patterns = @(
        "github_pat_[A-Za-z0-9_]{20,}",
        "ghp_[A-Za-z0-9]{20,}",
        "Authorization\s*:\s*Bearer\s+\S+",
        '"token"\s*:\s*"[^"\r\n]+"'
    )
    $matches = @()

    foreach ($file in @(Get-ChildItem -Path $evidenceDirectory -Recurse -File |
        Where-Object { $_.Extension -in @(".txt", ".log", ".md", ".json") })) {
        $content = Get-Content -Raw -Path $file.FullName -ErrorAction SilentlyContinue
        foreach ($pattern in $patterns) {
            if ($content -match $pattern) {
                $matches += [PSCustomObject]@{
                    file = $file.FullName.Substring($evidenceDirectory.Length + 1) -replace "\\", "/"
                    pattern = $pattern
                }
            }
        }
    }

    @($matches)
}

$script:generatedAt = $generatedAt
$script:gitCommit = Get-GitText -Arguments @("rev-parse", "HEAD")
$gitTree = Get-GitText -Arguments @("rev-parse", "HEAD^{tree}")
$gitBranch = Get-GitText -Arguments @("branch", "--show-current")
$gitStatus = Get-GitText -Arguments @("status", "--porcelain")
if ($script:gitCommit -notmatch "^[0-9a-fA-F]{40}$" -or $gitTree -notmatch "^[0-9a-fA-F]{40}$") {
    throw "The evidence collector requires a valid Git working copy with an exact commit and tree."
}
$dirtyLineCount = if ([string]::IsNullOrWhiteSpace($gitStatus)) {
    0
}
else {
    @($gitStatus -split "`r?`n" | Where-Object { $_ }).Count
}

$operatingSystem = Get-CimInstance Win32_OperatingSystem
$currentPowerShell = [string]$PSVersionTable.PSVersion
$userLanguages = @()
try {
    $userLanguages = @(Get-WinUserLanguageList | ForEach-Object {
        [PSCustomObject]@{
            languageTag = [string](Get-OptionalPropertyValue -InputObject $_ -Names @("LanguageTag"))
            inputMethodTips = @(Get-OptionalPropertyValue -InputObject $_ -Names @("InputMethodTips"))
        }
    })
}
catch {
    $userLanguages = @()
}

$environment = [PSCustomObject]@{
    windows = [PSCustomObject]@{
        caption = [string]$operatingSystem.Caption
        version = [string]$operatingSystem.Version
        buildNumber = [string]$operatingSystem.BuildNumber
        architecture = [string]$operatingSystem.OSArchitecture
    }
    currentPowerShell = $currentPowerShell
    windowsPowerShell = Get-SafeCommandText -Name "powershell.exe" -Arguments @(
        "-NoProfile", "-Command", '$PSVersionTable.PSVersion.ToString()'
    )
    powerShell7 = Get-SafeCommandText -Name "pwsh.exe" -Arguments @(
        "-NoProfile", "-Command", '$PSVersionTable.PSVersion.ToString()'
    )
    node = Get-SafeCommandText -Name "node.exe" -Arguments @("--version")
    npm = Get-SafeCommandText -Name "npm.cmd" -Arguments @("--version")
    cargo = Get-SafeCommandText -Name "cargo.exe" -Arguments @("--version")
    git = Get-SafeCommandText -Name "git.exe" -Arguments @("--version")
    githubCli = Get-SafeCommandText -Name "gh.exe" -Arguments @("--version")
    webView2Runtime = Get-WebView2RuntimeVersion
    culture = (Get-Culture).Name
    userLanguages = $userLanguages
}

Save-JsonFile -Value @(Get-ProcessSnapshot) `
    -Path (Join-Path $snapshotsDirectory "processes-before.json")
Save-JsonFile -Value @(Get-ListeningPortSnapshot) `
    -Path (Join-Path $snapshotsDirectory "listening-ports-before.json")

$verifyLocalParameters = @{
    StartupTimeoutSeconds = $StartupTimeoutSeconds
}
if ($SkipNpmInstall) {
    $verifyLocalParameters.SkipNpmInstall = $true
}
Invoke-EvidenceScript -Name "Local build and test gate" `
    -ScriptPath (Join-Path $PSScriptRoot "verify-local.ps1") `
    -Parameters $verifyLocalParameters `
    -Skip:$SkipBuild `
    -SkipReason "-SkipBuild was supplied"

$automationParameters = @{
    SkipBuild = $true
    AutomationSmoke = $true
    StartupTimeoutSeconds = $StartupTimeoutSeconds
}
Invoke-EvidenceScript -Name "Basic desktop automation smoke" `
    -ScriptPath (Join-Path $PSScriptRoot "verify-local.ps1") `
    -Parameters $automationParameters `
    -Skip:$SkipAutomationSmoke `
    -SkipReason "-SkipAutomationSmoke was supplied"

Invoke-EvidenceScript -Name "Terminal automation and reconnect smoke" `
    -ScriptPath (Join-Path $PSScriptRoot "verify-terminal-automation.ps1") `
    -Parameters @{
        SkipBuild = $true
        StartupTimeoutSeconds = $StartupTimeoutSeconds
    } `
    -Skip:(-not $IncludeTerminalAutomation) `
    -SkipReason "use -IncludeTerminalAutomation to run this extended check"

Invoke-EvidenceScript -Name "Automation event journal smoke" `
    -ScriptPath (Join-Path $PSScriptRoot "verify-automation-events.ps1") `
    -Parameters @{
        SkipBuild = $true
        StartupTimeoutSeconds = $StartupTimeoutSeconds
    } `
    -Skip:(-not $IncludeEventAutomation) `
    -SkipReason "use -IncludeEventAutomation to run this extended check"

Save-JsonFile -Value @(Get-ProcessSnapshot) `
    -Path (Join-Path $snapshotsDirectory "processes-after.json")
Save-JsonFile -Value @(Get-ListeningPortSnapshot) `
    -Path (Join-Path $snapshotsDirectory "listening-ports-after.json")

$artifactEvidence = @()
foreach ($installerPath in @($InstallerPaths)) {
    if ([string]::IsNullOrWhiteSpace($installerPath)) {
        continue
    }
    $resolvedInstaller = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($installerPath)
    $evidence = Get-FileEvidence -Path $resolvedInstaller -Kind "installer"
    if ($evidence) {
        $artifactEvidence += $evidence
    }
    else {
        $artifactEvidence += [PSCustomObject]@{
            kind = "installer"
            fileName = [IO.Path]::GetFileName($resolvedInstaller)
            sizeBytes = $null
            sha256 = $null
            error = "file not found"
        }
    }
}

$releaseDirectory = Join-Path $repoRoot "src-tauri\target\release"
foreach ($candidate in @(
    @{ Path = (Join-Path $releaseDirectory "tonymux.exe"); Kind = "desktop" },
    @{ Path = (Join-Path $releaseDirectory "cmux-wins.exe"); Kind = "desktop-compatibility" },
    @{ Path = (Join-Path $releaseDirectory "tonymux-cli.exe"); Kind = "cli" },
    @{ Path = (Join-Path $releaseDirectory "cmux-cli.exe"); Kind = "cli-compatibility" }
)) {
    $evidence = Get-FileEvidence -Path $candidate.Path -Kind $candidate.Kind
    if ($evidence) {
        $artifactEvidence += $evidence
    }
}

$artifactLogRelativePath = "logs/artifact-validation.log"
$artifactLogPath = Join-Path $evidenceDirectory "logs\artifact-validation.log"
$artifactStartedAt = Get-Date
$missingInstallers = @($artifactEvidence | Where-Object {
    $_.kind -eq "installer" -and $null -eq $_.sha256
})
if ($InstallerPaths.Count -eq 0) {
    "SKIPPED: no -InstallerPaths were supplied" | Set-Content -Path $artifactLogPath -Encoding UTF8
    Add-StepResult -Name "Installer artifact validation" -Status "skipped" `
        -StartedAt $artifactStartedAt -FinishedAt (Get-Date) `
        -LogFile $artifactLogRelativePath -Message "no installer paths were supplied"
}
elseif ($missingInstallers.Count -gt 0) {
    $missingNames = @($missingInstallers | ForEach-Object { $_.fileName }) -join ", "
    "FAILED: installer files were not found: $missingNames" | Set-Content -Path $artifactLogPath -Encoding UTF8
    Add-StepResult -Name "Installer artifact validation" -Status "failed" `
        -StartedAt $artifactStartedAt -FinishedAt (Get-Date) `
        -LogFile $artifactLogRelativePath -Message "installer files were not found: $missingNames"
}
else {
    @($artifactEvidence | Where-Object { $_.kind -eq "installer" } | ForEach-Object {
        "$($_.fileName)  $($_.sizeBytes) bytes  sha256:$($_.sha256)"
    }) | Set-Content -Path $artifactLogPath -Encoding UTF8
    Add-StepResult -Name "Installer artifact validation" -Status "passed" `
        -StartedAt $artifactStartedAt -FinishedAt (Get-Date) `
        -LogFile $artifactLogRelativePath
}

Get-ManualChecklist | Set-Content -Path (Join-Path $evidenceDirectory "manual-checklist.md") -Encoding UTF8

$failedSteps = @($stepResults | Where-Object { $_.status -eq "failed" })
$requestedSteps = @($stepResults | Where-Object { $_.status -ne "skipped" })
$automatedVerdict = if ($failedSteps.Count -gt 0) {
    "FAILED"
}
elseif ($requestedSteps.Count -eq 0) {
    "NOT RUN"
}
else {
    "PASSED"
}

$manifest = [PSCustomObject]@{
    schemaVersion = 1
    generatedAtUtc = $generatedAt.ToString("o")
    automatedVerdict = $automatedVerdict
    manualVerdict = "NOT VERIFIED"
    git = [PSCustomObject]@{
        commit = $gitCommit
        tree = $gitTree
        branch = $gitBranch
        dirty = ($dirtyLineCount -gt 0)
        dirtyEntryCount = $dirtyLineCount
    }
    environment = $environment
    artifacts = $artifactEvidence
    steps = $stepResults
    privacy = [PSCustomObject]@{
        environmentVariablesCollected = $false
        processCommandLinesCollected = $false
        terminalHistoryCollected = $false
        credentialsCollected = $false
    }
}
Save-JsonFile -Value $manifest -Path (Join-Path $evidenceDirectory "manifest.json")

$stepTable = @($stepResults | ForEach-Object {
    "| $($_.name) | $($_.status.ToUpperInvariant()) | $($_.durationSeconds) | $($_.logFile) |"
}) -join "`r`n"
$artifactTable = if ($artifactEvidence.Count -eq 0) {
    "| — | — | — | — |"
}
else {
    @($artifactEvidence | ForEach-Object {
        $size = if ($null -eq $_.sizeBytes) { "—" } else { [string]$_.sizeBytes }
        $hash = if ([string]::IsNullOrWhiteSpace([string]$_.sha256)) { "—" } else { [string]$_.sha256 }
        "| $($_.kind) | $($_.fileName) | $size | $hash |"
    }) -join "`r`n"
}

$report = @"
# TonyMux Windows 11 QA Evidence

## Verdict

- Automated requested steps: **$automatedVerdict**
- Manual Windows 11 checks: **NOT VERIFIED**
- Generated at: $($generatedAt.ToString("o"))

## Tested revision

- Commit: $gitCommit
- Git tree: $gitTree
- Branch: $gitBranch
- Dirty working tree: $($dirtyLineCount -gt 0) ($dirtyLineCount entries)

## Environment

- Windows: $($environment.windows.caption) $($environment.windows.version), build $($environment.windows.buildNumber)
- Architecture: $($environment.windows.architecture)
- Current PowerShell: $($environment.currentPowerShell)
- Windows PowerShell: $($environment.windowsPowerShell)
- PowerShell 7: $($environment.powerShell7)
- WebView2 Runtime: $($environment.webView2Runtime)
- Culture: $($environment.culture)

## Automated steps

| Step | Result | Seconds | Log |
|---|---:|---:|---|
$stepTable

## Tested artifacts

| Kind | File | Bytes | SHA-256 |
|---|---|---:|---|
$artifactTable

## Evidence files

- manifest.json: machine-readable environment, revision, artifact and step results
- manual-checklist.md: checks that still require a human tester
- logs/: complete combined output for each requested automated step
- snapshots/processes-before.json and snapshots/processes-after.json
- snapshots/listening-ports-before.json and snapshots/listening-ports-after.json

## Trust boundary

This bundle does not prove MSI/NSIS installation, Vietnamese IME, clipboard behavior, DPI/display transitions, native WebView2 focus/compositor behavior, SmartScreen, or orphan-process cleanup by visual inspection. Those remain unchecked in manual-checklist.md until a tester records evidence.

The collector intentionally excludes environment variables, arbitrary process command lines, terminal history and credentials.
"@
$report | Set-Content -Path (Join-Path $evidenceDirectory "report.md") -Encoding UTF8

$secretMatches = @(Test-EvidenceForSecrets)
$secretScan = [PSCustomObject]@{
    status = if ($secretMatches.Count -eq 0) { "passed" } else { "failed" }
    matches = $secretMatches
}
Save-JsonFile -Value $secretScan -Path (Join-Path $evidenceDirectory "secret-scan.json")

$checksums = @()
foreach ($file in @(Get-ChildItem -Path $evidenceDirectory -Recurse -File | Sort-Object FullName)) {
    if ($file.Name -eq "SHA256SUMS.txt") {
        continue
    }
    $relativePath = $file.FullName.Substring($evidenceDirectory.Length + 1) -replace "\\", "/"
    $hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $checksums += "$hash  $relativePath"
}
$checksums | Set-Content -Path (Join-Path $evidenceDirectory "SHA256SUMS.txt") -Encoding ASCII

$archivePath = $null
if (-not $NoArchive -and $secretMatches.Count -eq 0) {
    $archivePath = "$evidenceDirectory.zip"
    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    Compress-Archive -Path (Join-Path $evidenceDirectory "*") -DestinationPath $archivePath -CompressionLevel Optimal
}

Write-Host "`nEvidence directory: $evidenceDirectory" -ForegroundColor Green
if ($archivePath) {
    Write-Host "Evidence archive:   $archivePath" -ForegroundColor Green
}

if ($secretMatches.Count -gt 0) {
    throw "Potential token or authorization material was detected. Do not upload this bundle; inspect secret-scan.json."
}
if ($failedSteps.Count -gt 0) {
    throw "$($failedSteps.Count) requested automated QA step(s) failed. The evidence bundle was still written."
}
