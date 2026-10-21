[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$CertificateThumbprint,
    [uri]$TimestampUrl = 'https://timestamp.digicert.com'
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'Build signed releases on Windows with the MSVC toolchain.' }
if ($TimestampUrl.Scheme -ne 'https') { throw 'Use an HTTPS timestamp endpoint supported by your signing provider.' }
$certificate = Get-Item "Cert:\CurrentUser\My\$CertificateThumbprint"
if (-not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)) {
    throw 'A valid code-signing certificate with an accessible private key is required.'
}
if (-not ($certificate.EnhancedKeyUsageList | Where-Object { $_.ObjectId.Value -eq '1.3.6.1.5.5.7.3.3' })) {
    throw 'The certificate is not intended for code signing.'
}
$root = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $root 'apps/desktop/src-tauri/tauri.signing.local.json'
if (Test-Path $configPath) { throw 'A local signing override already exists; review it before continuing.' }
function Invoke-Checked([string]$Program, [string[]]$Arguments) {
    & $Program @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Program failed with exit code $LASTEXITCODE" }
}
Push-Location $root
try {
    Invoke-Checked 'npm' @('ci','--no-audit','--no-fund')
    Invoke-Checked 'npm' @('run','icons')
    Invoke-Checked 'npm' @('test')
    Invoke-Checked 'npm' @('run','build')
    Invoke-Checked 'python' @('-m','unittest','discover','-s','tests','-v')
    & (Join-Path $root 'tests/test_cold_recovery.ps1')
    Invoke-Checked 'cargo' @('test','--locked','--manifest-path','apps/desktop/src-tauri/Cargo.toml')
    @{ bundle = @{ windows = @{ certificateThumbprint = $CertificateThumbprint; digestAlgorithm = 'sha256'; timestampUrl = $TimestampUrl.AbsoluteUri; tsp = $true } } } |
        ConvertTo-Json -Depth 5 | Set-Content -Path $configPath -Encoding ascii
    Invoke-Checked 'npm' @('exec','--workspace=@nou/desktop','--','tauri','build','--config',$configPath,'--bundles','nsis','--','--locked')
    $files = @(Get-ChildItem 'apps/desktop/src-tauri/target/release/bundle/nsis/*.exe')
    $appExe = Get-Item 'apps/desktop/src-tauri/target/release/nou-desktop.exe'
    if ($files.Count -eq 0) { throw 'No installer was produced.' }
    foreach ($file in @($appExe) + $files) {
        $signature = Get-AuthenticodeSignature $file.FullName
        if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Thumbprint -ne $CertificateThumbprint -or -not $signature.TimeStamperCertificate) {
            throw "Signature or timestamp verification failed for $($file.Name). Do not publish."
        }
    }
    $lines = foreach ($file in $files) { "$((Get-FileHash $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($file.Name)" }
    $lines | Set-Content 'apps/desktop/src-tauri/target/release/bundle/nsis/SHA256SUMS.txt' -Encoding ascii
    Write-Output 'Signed application and installers verified. Complete the Windows acceptance drill before publishing.'
} finally {
    if (Test-Path $configPath) { Remove-Item $configPath }
    Pop-Location
}
