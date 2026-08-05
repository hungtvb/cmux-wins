[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$DesktopExecutable,

    [Parameter(Mandatory)]
    [string]$PrimaryCli,

    [Parameter(Mandatory)]
    [string]$CompatibilityCli,

    [Parameter(Mandatory)]
    [string]$OutputDirectory,

    [Parameter(Mandatory)]
    [ValidatePattern('^[0-9A-Za-z][0-9A-Za-z.+-]*$')]
    [string]$Version,

    [string]$Commit = "unknown",

    [string[]]$AdditionalFiles = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:OS -ne "Windows_NT") {
    throw "scripts\package-windows-portable.ps1 must run on Windows."
}

function Resolve-RequiredFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Description
    )

    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Path)
    if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
        throw "$Description was not found: $resolved"
    }

    (Get-Item -LiteralPath $resolved).FullName
}

function Write-Utf8NoBomFile {
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Get-RelativeArchivePath {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$Path
    )

    $normalizedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    $normalizedPath = [IO.Path]::GetFullPath($Path)
    if (-not $normalizedPath.StartsWith($normalizedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside portable staging directory: $normalizedPath"
    }

    $normalizedPath.Substring($normalizedRoot.Length)
}

function New-DeterministicZip {
    param(
        [Parameter(Mandatory)][string]$SourceDirectory,
        [Parameter(Mandatory)][string]$DestinationPath
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    if (Test-Path -LiteralPath $DestinationPath) {
        Remove-Item -LiteralPath $DestinationPath -Force
    }

    $files = @(Get-ChildItem -LiteralPath $SourceDirectory -File -Recurse | Sort-Object FullName)
    if ($files.Count -eq 0) {
        throw "Portable staging directory is empty: $SourceDirectory"
    }

    $fixedTimestamp = [DateTimeOffset]::Parse("1980-01-01T00:00:00Z")
    $stream = [IO.File]::Open(
        $DestinationPath,
        [IO.FileMode]::CreateNew,
        [IO.FileAccess]::Write,
        [IO.FileShare]::None
    )

    try {
        $archive = New-Object -TypeName System.IO.Compression.ZipArchive -ArgumentList @(
            $stream,
            [IO.Compression.ZipArchiveMode]::Create,
            $false,
            [Text.Encoding]::UTF8
        )

        try {
            foreach ($file in $files) {
                $entryName = (Get-RelativeArchivePath -Root $SourceDirectory -Path $file.FullName).Replace('\', '/')
                $entry = $archive.CreateEntry($entryName, [IO.Compression.CompressionLevel]::Optimal)
                $entry.LastWriteTime = $fixedTimestamp

                $inputStream = [IO.File]::OpenRead($file.FullName)
                $entryStream = $entry.Open()
                try {
                    $inputStream.CopyTo($entryStream)
                }
                finally {
                    $entryStream.Dispose()
                    $inputStream.Dispose()
                }
            }
        }
        finally {
            $archive.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Test-PortableZip {
    param(
        [Parameter(Mandatory)][string]$SourceDirectory,
        [Parameter(Mandatory)][string]$ZipPath
    )

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem

    $expectedFiles = @(Get-ChildItem -LiteralPath $SourceDirectory -File -Recurse | Sort-Object FullName)
    $expectedByName = @{}
    foreach ($file in $expectedFiles) {
        $name = (Get-RelativeArchivePath -Root $SourceDirectory -Path $file.FullName).Replace('\', '/')
        $expectedByName[$name] = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    }

    $stream = [IO.File]::OpenRead($ZipPath)
    try {
        $archive = New-Object -TypeName System.IO.Compression.ZipArchive -ArgumentList @(
            $stream,
            [IO.Compression.ZipArchiveMode]::Read,
            $false,
            [Text.Encoding]::UTF8
        )

        try {
            $entries = @($archive.Entries | Where-Object { -not [string]::IsNullOrEmpty($_.Name) })
            if ($entries.Count -ne $expectedByName.Count) {
                throw "Portable ZIP entry count mismatch. expected=$($expectedByName.Count) actual=$($entries.Count)"
            }

            foreach ($entry in $entries) {
                if (-not $expectedByName.ContainsKey($entry.FullName)) {
                    throw "Unexpected portable ZIP entry: $($entry.FullName)"
                }

                $sha = [Security.Cryptography.SHA256]::Create()
                $entryStream = $entry.Open()
                try {
                    $hashBytes = $sha.ComputeHash($entryStream)
                }
                finally {
                    $entryStream.Dispose()
                    $sha.Dispose()
                }
                $actualHash = ([BitConverter]::ToString($hashBytes)).Replace('-', '').ToLowerInvariant()
                if ($actualHash -ne $expectedByName[$entry.FullName]) {
                    throw "Portable ZIP hash mismatch for $($entry.FullName)"
                }
            }
        }
        finally {
            $archive.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

$desktopPath = Resolve-RequiredFile -Path $DesktopExecutable -Description "TonyMux desktop executable"
$primaryCliPath = Resolve-RequiredFile -Path $PrimaryCli -Description "TonyMux automation CLI"
$compatibilityCliPath = Resolve-RequiredFile -Path $CompatibilityCli -Description "Compatibility automation CLI"
$outputRoot = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputDirectory)
$stagingDirectory = Join-Path $outputRoot "tonymux-portable-x64"
$zipPath = Join-Path $outputRoot "tonymux-$Version-windows-portable-x64.zip"

New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
if (Test-Path -LiteralPath $stagingDirectory) {
    Remove-Item -LiteralPath $stagingDirectory -Recurse -Force
}
New-Item -ItemType Directory -Path $stagingDirectory -Force | Out-Null

$copyPlan = @(
    [PSCustomObject]@{ Source = $desktopPath; DestinationName = "TonyMux.exe" },
    [PSCustomObject]@{ Source = $primaryCliPath; DestinationName = "tonymux-cli.exe" },
    [PSCustomObject]@{ Source = $compatibilityCliPath; DestinationName = "cmux-cli.exe" }
)

foreach ($additionalFile in @($AdditionalFiles)) {
    if ([string]::IsNullOrWhiteSpace($additionalFile)) {
        continue
    }

    $resolvedAdditionalFile = Resolve-RequiredFile -Path $additionalFile -Description "Portable sidecar"
    $copyPlan += [PSCustomObject]@{
        Source = $resolvedAdditionalFile
        DestinationName = [IO.Path]::GetFileName($resolvedAdditionalFile)
    }
}

$duplicateNames = @($copyPlan | Group-Object DestinationName | Where-Object Count -gt 1)
if ($duplicateNames.Count -gt 0) {
    $names = @($duplicateNames | ForEach-Object { $_.Name }) -join ", "
    throw "Portable package contains duplicate destination names: $names"
}

foreach ($item in $copyPlan) {
    Copy-Item -LiteralPath $item.Source -Destination (Join-Path $stagingDirectory $item.DestinationName)
}

$readme = @"
TonyMux $Version - Portable Windows x64 build

QUICK START
1. Extract the entire ZIP into a writable folder.
2. Double-click TonyMux.exe.
3. Keep tonymux-cli.exe and cmux-cli.exe in the same folder when using local automation.

REQUIREMENTS
- Windows 11 x64.
- Microsoft Edge WebView2 Runtime must be installed. Current Windows 11 installations normally provide it.

DATA LOCATION
This no-install build intentionally uses the same TonyMux application identifier and user-data locations as the installed build. Settings and workspace state remain under the current Windows user profile. Local automation discovery remains under %LOCALAPPDATA%\cmux-windows.

For isolated QA, close every TonyMux instance first and back up or clear the existing TonyMux user data before launching this build. Deleting this extracted directory removes only the portable binaries; it does not remove user data stored under the Windows profile.

CLEANUP
- Close TonyMux.
- Delete the extracted folder.
- Remove user data separately only when the QA plan explicitly requires a clean profile.

SOURCE
Version: $Version
Commit: $Commit
Architecture: x64

Verify all shipped files with SHA256SUMS.txt before launch.
"@
Write-Utf8NoBomFile -Path (Join-Path $stagingDirectory "README-PORTABLE.txt") -Content $readme

$metadata = [ordered]@{
    schemaVersion = 1
    product = "TonyMux"
    version = $Version
    commit = $Commit
    architecture = "x64"
    executable = "TonyMux.exe"
    webView2Mode = "system-runtime"
    userDataMode = "shared-windows-profile"
    automationData = "%LOCALAPPDATA%\cmux-windows"
}
$metadataJson = $metadata | ConvertTo-Json -Depth 4
Write-Utf8NoBomFile -Path (Join-Path $stagingDirectory "PORTABLE-METADATA.json") -Content ($metadataJson + "`r`n")

$checksumLines = @(Get-ChildItem -LiteralPath $stagingDirectory -File |
    Where-Object Name -ne "SHA256SUMS.txt" |
    Sort-Object Name |
    ForEach-Object {
        $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$hash  $($_.Name)"
    })
Write-Utf8NoBomFile -Path (Join-Path $stagingDirectory "SHA256SUMS.txt") -Content (($checksumLines -join "`r`n") + "`r`n")

New-DeterministicZip -SourceDirectory $stagingDirectory -DestinationPath $zipPath
Test-PortableZip -SourceDirectory $stagingDirectory -ZipPath $zipPath

$zipFile = Get-Item -LiteralPath $zipPath
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()

$outputs = [ordered]@{
    portable_directory = $stagingDirectory
    portable_zip = $zipPath
    portable_zip_name = $zipFile.Name
    portable_zip_size_bytes = $zipFile.Length
    portable_zip_sha256 = $zipHash
}

if (-not [string]::IsNullOrWhiteSpace($env:GITHUB_OUTPUT)) {
    $outputEncoding = New-Object System.Text.UTF8Encoding($false)
    foreach ($entry in $outputs.GetEnumerator()) {
        [IO.File]::AppendAllText(
            $env:GITHUB_OUTPUT,
            "$($entry.Key)=$($entry.Value)`n",
            $outputEncoding
        )
    }
}

$outputs | ConvertTo-Json
