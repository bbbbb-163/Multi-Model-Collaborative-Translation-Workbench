param([string]$OutputDirectory = 'release')
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $projectRoot

# Explicit allowlist: never archive .data, .env, node_modules or local screenshots.
$items = @(
    'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.server.json',
    'vite.config.ts', 'index.html', 'src', 'server', 'shared', 'tests',
    'Dockerfile', '.dockerignore', 'compose.yaml', '.env.example',
    '.gitattributes', 'deploy', 'DEPLOYMENT.md', 'README.md', 'SECURITY_REVIEW.md'
)
foreach ($item in $items) {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot $item))) {
        throw "Missing release input: $item"
    }
}
$outputPath = [IO.Path]::GetFullPath((Join-Path $projectRoot $OutputDirectory))
New-Item -ItemType Directory -Path $outputPath -Force | Out-Null
$releaseName = 'mstar-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
$archivePath = Join-Path $outputPath ($releaseName + '.tar.gz')
if (Test-Path -LiteralPath $archivePath) { throw "Archive already exists: $archivePath" }
$exclusions = @(
    '--exclude=__pycache__', '--exclude=*.pyc', '--exclude=node_modules',
    '--exclude=.data', '--exclude=runtime', '--exclude=backups',
    '--exclude=.env', '--exclude=.env.local', '--exclude=.env.production',
    '--exclude=*.sqlite*', '--exclude=*.db', '--exclude=*.db-*',
    '--exclude=*.log', '--exclude=*.pem', '--exclude=*.key',
    '--exclude=*.p12', '--exclude=*.pfx', '--exclude=*.env',
    '--exclude=uploads', '--exclude=attachments',
    '--exclude=id_rsa*', '--exclude=id_ed25519*', '--exclude=gitee_ed25519*',
    '--exclude=known_hosts*', '--exclude=admin-setup.txt',
    '--exclude=auto-deploy.json', '--exclude=webhook.json',
    '--exclude=*.secret', '--exclude=*.secrets', '--exclude=*.tar.gz',
    '--exclude=*.zip', '--exclude=*.tmp', '--exclude=*.bak'
)
foreach ($item in $items) {
    $inputPath = Join-Path $projectRoot $item
    if (Test-Path -LiteralPath $inputPath -PathType Container) {
        Get-ChildItem -LiteralPath $inputPath -Recurse -Force -File |
            Where-Object { $_.Name -like '.env*' -and $_.Name -ne '.env.example' } |
            ForEach-Object {
                $relativePath = $_.FullName.Substring($projectRoot.Length + 1).Replace('\', '/')
                $exclusions += '--exclude=' + $relativePath
            }
    }
}
& tar.exe -czf $archivePath @exclusions @items
if ($LASTEXITCODE -ne 0) { throw 'Release archive failed.' }
$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText(($archivePath + '.sha256'), "$hash  $releaseName.tar.gz`n", [Text.UTF8Encoding]::new($false))
Write-Host "Release: $archivePath"
Write-Host "SHA256:  $hash"
Write-Host 'Contains source and deployment files only; no local workspace data or credentials.'
