# Cold recovery for a Notes database that prevents NOU from starting. Preview by default.
[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$DataDirectory, [switch]$Execute)
$ErrorActionPreference = 'Stop'
$data = (Resolve-Path -LiteralPath $DataDirectory).Path.TrimEnd('\')
if (-not (Test-Path -LiteralPath (Join-Path $data 'notes.sqlite3') -PathType Leaf)) {
    throw 'The selected directory does not contain notes.sqlite3. No changes made.'
}
if ((Get-Item -LiteralPath $data).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Select the actual data directory, not a link.'
}
$parent = [IO.Path]::GetDirectoryName($data)
if (-not $parent) { throw 'A drive root cannot be used as the app data directory.' }
$recovery = Join-Path $parent ([IO.Path]::GetFileName($data) + '-cold-recovery-' + [guid]::NewGuid().ToString())
if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($recovery)) -ne $parent -or (Test-Path -LiteralPath $recovery)) {
    throw 'Invalid recovery destination. No changes made.'
}
Write-Output "Preserve the entire data directory: $data"
Write-Output "Rename to: $recovery"
Write-Output 'All database files, WAL/SHM sidecars, settings and rollback packages stay together.'
Write-Output 'Afterward, reopen NOU to create an empty profile and restore a verified backup package.'
if (-not $Execute) { Write-Output 'Preview only. Close NOU and run with -Execute when ready.'; return }
if ((Read-Host 'Type PRESERVE AND RESET to continue') -cne 'PRESERVE AND RESET') { throw 'Cancelled. No changes made.' }
# Share-delete permits an atomic same-volume directory rename while our byte-range lock
# conflicts with NOU's fs2 process lock. A running old alpha's SQLite handles also block rename.
$share = [IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete
$lock = [IO.File]::Open((Join-Path $data 'nou.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, $share)
try {
    $lock.Lock(0, 1)
    # One directory rename, never individual SQLite files. Both absolute paths checked above.
    Move-Item -LiteralPath $data -Destination $recovery
    Write-Output "Original profile preserved at: $recovery"
    Write-Output 'Reopen NOU and restore a verified package. Nothing was deleted. Do not remove this preserved profile until recovery is confirmed.'
} finally { $lock.Dispose() }
