param([Parameter(Mandatory=$true)][string]$PackagePath)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$taskSource = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../wechat-companion'))
$taskSourcePrefix = $taskSource.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$taskArchive = [System.IO.Compression.ZipFile]::OpenRead([System.IO.Path]::GetFullPath($PackagePath))
$taskChecked = 0
try {
  foreach ($taskEntry in $taskArchive.Entries) {
    if ($taskEntry.FullName.EndsWith('/')) { continue }
    $taskTarget = [System.IO.Path]::GetFullPath((Join-Path $taskSource $taskEntry.FullName))
    if (-not $taskTarget.StartsWith($taskSourcePrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry is outside source directory' }
    if (-not (Test-Path -LiteralPath $taskTarget -PathType Leaf)) { throw ('Missing source file: ' + $taskEntry.FullName) }
    $taskStream = $taskEntry.Open()
    $taskHash = [System.Security.Cryptography.SHA256]::Create()
    try { $taskActual = [System.BitConverter]::ToString($taskHash.ComputeHash($taskStream)).Replace('-', '') }
    finally { $taskHash.Dispose(); $taskStream.Dispose() }
    $taskExpected = (Get-FileHash -LiteralPath $taskTarget -Algorithm SHA256).Hash
    if ($taskActual -ne $taskExpected) { throw ('Package differs from current source: ' + $taskEntry.FullName) }
    Write-Output ($taskEntry.FullName + ': SHA256 matches')
    $taskChecked++
  }
  if ($taskChecked -lt 8) { throw 'Package has too few source files' }
  Write-Output ('Verified package source identity: ' + $taskChecked + ' files')
} finally { $taskArchive.Dispose() }
