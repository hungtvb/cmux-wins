[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Continue"

$repoRoot = Split-Path -Parent $PSScriptRoot
$diagnostics = Join-Path $repoRoot "test-loader-diagnostics"
$targetDirectory = Join-Path $repoRoot "src-tauri\target\debug\deps"

Remove-Item -Recurse -Force $diagnostics -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $diagnostics -Force | Out-Null

$summaryPath = Join-Path $diagnostics "summary.txt"
function Write-Summary([string]$Message) {
    $Message | Tee-Object -FilePath $summaryPath -Append | Write-Host
}

$testExe = Get-ChildItem -Path $targetDirectory -Filter "cmux_wins_lib-*.exe" -File `
    -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTimeUtc -Descending |
    Select-Object -First 1

if (-not $testExe) {
    Write-Summary "No cmux_wins_lib test executable was found in $targetDirectory"
    exit 0
}

Write-Summary "Test executable: $($testExe.FullName)"
Write-Summary "Size: $($testExe.Length) bytes"
Write-Summary "Last write UTC: $($testExe.LastWriteTimeUtc.ToString('O'))"
(Get-FileHash -Algorithm SHA256 $testExe.FullName | Format-List | Out-String) |
    Set-Content -Path (Join-Path $diagnostics "sha256.txt")

$mt = Get-ChildItem -Path "${env:ProgramFiles(x86)}\Windows Kits\10\bin" -Filter mt.exe `
    -File -Recurse -ErrorAction SilentlyContinue |
    Where-Object FullName -Match '\\x64\\mt\.exe$' |
    Sort-Object FullName -Descending |
    Select-Object -First 1

if ($mt) {
    Write-Summary "mt.exe: $($mt.FullName)"
    $manifestOutput = Join-Path $diagnostics "embedded.manifest"
    & $mt.FullName -nologo "-inputresource:$($testExe.FullName);#1" "-out:$manifestOutput" `
        *> (Join-Path $diagnostics "mt.log")
    Write-Summary "mt.exe exit code: $LASTEXITCODE"
} else {
    Write-Summary "mt.exe was not found"
}

$vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
$dumpbin = $null
if (Test-Path $vswhere) {
    $installation = (& $vswhere -latest -products * -property installationPath | Select-Object -First 1)
    if ($installation) {
        $dumpbin = Get-ChildItem -Path (Join-Path $installation "VC\Tools\MSVC") `
            -Filter dumpbin.exe -File -Recurse -ErrorAction SilentlyContinue |
            Where-Object FullName -Match '\\Hostx64\\x64\\dumpbin\.exe$' |
            Sort-Object FullName -Descending |
            Select-Object -First 1
    }
}

if ($dumpbin) {
    Write-Summary "dumpbin.exe: $($dumpbin.FullName)"
    & $dumpbin.FullName /nologo /dependents $testExe.FullName `
        *> (Join-Path $diagnostics "dependents.txt")
    & $dumpbin.FullName /nologo /imports $testExe.FullName `
        *> (Join-Path $diagnostics "imports.txt")
} else {
    Write-Summary "dumpbin.exe was not found"
}

$startTime = (Get-Date).AddMinutes(-20)
Get-WinEvent -FilterHashtable @{ LogName = "Application"; StartTime = $startTime } `
    -ErrorAction SilentlyContinue |
    Where-Object {
        $_.ProviderName -in @("Application Error", "Windows Error Reporting") -or
        $_.Message -match "cmux_wins_lib|ENTRYPOINT|0xc0000139"
    } |
    Select-Object TimeCreated, ProviderName, Id, LevelDisplayName, Message |
    Format-List |
    Out-String -Width 4096 |
    Set-Content -Path (Join-Path $diagnostics "application-events.txt")

$debuggerRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\Debuggers\x64"
$cdb = Join-Path $debuggerRoot "cdb.exe"
$gflags = Join-Path $debuggerRoot "gflags.exe"
if ((Test-Path $cdb) -and (Test-Path $gflags)) {
    Write-Summary "Using Loader Snaps through cdb: $cdb"
    $imageName = $testExe.Name
    try {
        & $gflags /i $imageName +sls *> (Join-Path $diagnostics "gflags-enable.log")
        & $cdb -logo (Join-Path $diagnostics "cdb-loader-snaps.log") `
            -c "g;q" $testExe.FullName --list `
            *> (Join-Path $diagnostics "cdb-console.log")
        Write-Summary "cdb exit code: $LASTEXITCODE"
    } finally {
        & $gflags /i $imageName -sls *> (Join-Path $diagnostics "gflags-disable.log")
    }
} else {
    Write-Summary "Windows Debugging Tools (cdb/gflags) were not found at $debuggerRoot"
}

Get-ChildItem -Path $diagnostics -File |
    Select-Object Name, Length, LastWriteTimeUtc |
    Format-Table -AutoSize |
    Out-String |
    Tee-Object -FilePath (Join-Path $diagnostics "files.txt") |
    Write-Host

exit 0
