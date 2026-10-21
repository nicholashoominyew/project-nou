$ErrorActionPreference = 'Stop'
$root = Join-Path ([IO.Path]::GetTempPath()) ('nou-cold-test-' + [guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
$script = Join-Path $PSScriptRoot '../tools/Recover-Nou.ps1'
function Read-Host { return 'PRESERVE AND RESET' }
try {
    $data = Join-Path $root 'profile'
    New-Item -ItemType Directory -Path $data | Out-Null
    [IO.File]::WriteAllText((Join-Path $data 'notes.sqlite3'), 'damaged-main')
    [IO.File]::WriteAllText((Join-Path $data 'notes.sqlite3-wal'), 'precious-wal')
    [IO.File]::WriteAllText((Join-Path $data 'notes.sqlite3-shm'), 'sidecar')
    & $script -DataDirectory $data | Out-Null
    if (-not (Test-Path -LiteralPath $data)) { throw 'Preview changed data' }
    $lock = [IO.File]::Open((Join-Path $data 'nou.lock'), 'OpenOrCreate', 'ReadWrite', 'ReadWrite')
    try {
        $lock.Lock(0, 1)
        $blocked = $false
        try { & $script -DataDirectory $data -Execute | Out-Null } catch { $blocked = $true }
        if (-not $blocked -or -not (Test-Path -LiteralPath $data)) { throw 'Running app lock was not respected' }
    } finally { $lock.Dispose() }
    & $script -DataDirectory $data -Execute | Out-Null
    if (Test-Path -LiteralPath $data) { throw 'Original directory was not moved' }
    $preserved = @(Get-ChildItem -LiteralPath $root -Directory)
    if ($preserved.Count -ne 1) { throw 'Expected one preserved profile' }
    if ([IO.File]::ReadAllText((Join-Path $preserved[0].FullName 'notes.sqlite3')) -ne 'damaged-main') { throw 'Main database changed' }
    if ([IO.File]::ReadAllText((Join-Path $preserved[0].FullName 'notes.sqlite3-wal')) -ne 'precious-wal') { throw 'WAL changed' }
    if ([IO.File]::ReadAllText((Join-Path $preserved[0].FullName 'notes.sqlite3-shm')) -ne 'sidecar') { throw 'SHM changed' }
    Write-Output 'Cold recovery: preview, running-instance refusal and complete profile preservation passed.'
} finally {
    # Restrict cleanup to this test's generated temporary root.
    $resolved = [IO.Path]::GetFullPath($root)
    $temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if ($resolved.StartsWith($temp) -and [IO.Path]::GetFileName($resolved).StartsWith('nou-cold-test-')) {
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
