$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Please install Node.js 24 or newer: https://nodejs.org' -ForegroundColor Red
    exit 1
}
$nodeVersion = & node -p 'parseInt(process.versions.node)'
if ([int]$nodeVersion -lt 24) {
    Write-Host 'Node.js 24 or newer is required.' -ForegroundColor Red
    exit 1
}
$portValue = if ($env:PORT) { $env:PORT } else { '3210' }
$localUrl = "http://127.0.0.1:$portValue"
try {
    $existing = Invoke-RestMethod -Uri "$localUrl/api/health" -TimeoutSec 2
    if ($existing.ok) { Start-Process $localUrl; Write-Host "Already running: $localUrl"; exit 0 }
} catch {}
if (-not (Test-Path -LiteralPath 'node_modules')) {
    & npm.cmd install --registry=https://registry.npmjs.org
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
Start-Process -FilePath 'powershell.exe' -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"' + (Join-Path $PSScriptRoot 'open-browser.ps1') + '"'), '-Url', $localUrl)
& npm.cmd start
exit $LASTEXITCODE
