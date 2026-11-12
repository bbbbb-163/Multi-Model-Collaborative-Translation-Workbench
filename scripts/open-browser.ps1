param([string]$Url = 'http://127.0.0.1:3210')
$ErrorActionPreference = 'SilentlyContinue'
for ($attempt = 0; $attempt -lt 40; $attempt++) {
    try {
        $health = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 1
        if ($health.ok) { Start-Process $Url; exit 0 }
    } catch {}
    Start-Sleep -Milliseconds 500
}
exit 1
