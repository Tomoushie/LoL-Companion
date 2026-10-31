# E2E V0.6 — tier list + builds OP.GG (LIVE, sans clé) et progression Riot (MOCK).
#
# Passe 1 (réelle, sans clé) :
#   - non-régression UI V0.1→V0.5 (ui-scenarios.mjs) ;
#   - onglet Méta : tier list RÉELLE OP.GG (EUW) + builds Ahri mid challenger RÉELS
#     (via le MCP public OP.GG) → captures docs/v0.6-meta-*.png.
# Passe 2 (mock test-only) :
#   - serveur scripts/mock-riot-server.mjs, 50 matchs simulés ;
#   - profil + fiche de match + **progression personnelle** (50 derniers matchs) ;
#   - cache/rate-limit Riot vérifiés.
#   Données simulées uniquement dans cette passe, jamais présentées comme réelles.
#
# Usage :
#   pwsh -File scripts/e2e-v06.ps1
#   pwsh -File scripts/e2e-v06.ps1 -SkipBuild

param(
    [switch]$SkipBuild,
    [int]$CdpPort = 9333,
    [int]$MockPort = 18765
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$exe = Join-Path $root "src-tauri\target\debug\lol-bot.exe"
$cacheDir = Join-Path $env:APPDATA "LoL BOT\cache"
$realFailed = $false
$mockFailed = $false
$cacheFailed = $false
$mockProcess = $null
$tempCache = Join-Path $root "_e2e-cache"
$savedCacheEnv = $env:LOL_BOT_CACHE_DIR

function Stop-App {
    Get-Process -Name "lol-bot" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 700
}

function Wait-Cdp([int]$port, [int]$timeoutSeconds = 90) {
    $deadline = (Get-Date).AddSeconds($timeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/list" -TimeoutSec 3
            if (@($targets | Where-Object { $_.type -eq "page" }).Count -gt 0) { return $true }
        } catch {
            Start-Sleep -Milliseconds 400
        }
    }
    return $false
}

function Start-App([string[]]$extraEnv = @()) {
    $saved = @{}
    foreach ($name in @("RIOT_API_KEY", "RIOT_API_BASE")) {
        $saved[$name] = [Environment]::GetEnvironmentVariable($name)
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
    foreach ($pair in $extraEnv) {
        $parts = $pair.Split("=", 2)
        Set-Item -Path "Env:$($parts[0])" -Value $parts[1]
    }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
    $process = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
    if (-not (Wait-Cdp $CdpPort 90)) { throw "port CDP $CdpPort indisponible" }
    return @{ Process = $process; Env = $saved }
}

function Restore-AppEnv($state) {
    foreach ($name in @("RIOT_API_KEY", "RIOT_API_BASE")) {
        $value = $state.Env[$name]
        if ($null -ne $value -and $value -ne "") { Set-Item -Path "Env:$name" -Value $value }
        else { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    }
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}

function Close-App($state) {
    if ($null -ne $state -and $null -ne $state.Process -and -not $state.Process.HasExited) {
        $state.Process.CloseMainWindow() | Out-Null
        Start-Sleep -Seconds 2
        if (-not $state.Process.HasExited) { $state.Process.Kill() }
    }
    Stop-App
}

if (-not $SkipBuild) {
    Write-Host "=== Build debug Tauri (frontend + Rust) ===" -ForegroundColor Cyan
    pnpm tauri build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "build échoué" }
}
if (-not (Test-Path -LiteralPath $exe)) { throw "exécutable introuvable : $exe" }

Stop-App

# =========================================================================
# PASSE 1 — LIVE : non-régression + Méta OP.GG (données réelles, sans clé)
# =========================================================================
Write-Host "=== PASSE 1 : Méta OP.GG réel + non-régression ===" -ForegroundColor Cyan
$app = $null
try {
    Remove-Item Env:RIOT_API_KEY, Env:RIOT_API_BASE -ErrorAction SilentlyContinue
    $app = Start-App
    node scripts\ui-scenarios.mjs --port $CdpPort --out-dir docs
    if ($LASTEXITCODE -ne 0) { $realFailed = $true }
    node scripts\ui-scenarios-meta.mjs --port $CdpPort --out-dir docs
    if ($LASTEXITCODE -ne 0) { $realFailed = $true }
} finally {
    Close-App $app
}

Write-Host "=== Cache Méta OP.GG ===" -ForegroundColor Cyan
$metaCache = Join-Path $cacheDir "meta"
if (-not (Test-Path -LiteralPath $metaCache)) {
    Write-Host "ECHEC : cache Méta absent" -ForegroundColor Red
    $realFailed = $true
} else {
    $tierFiles = @(Get-ChildItem -LiteralPath (Join-Path $metaCache "tier") -Filter *.json -File -Recurse -ErrorAction SilentlyContinue)
    $buildFiles = @(Get-ChildItem -LiteralPath (Join-Path $metaCache "build") -Filter *.json -File -Recurse -ErrorAction SilentlyContinue)
    Write-Host "  tier lists en cache : $($tierFiles.Count)"
    Write-Host "  builds en cache : $($buildFiles.Count)"
    if ($tierFiles.Count -lt 1) { Write-Host "ECHEC : tier list non cachée" -ForegroundColor Red; $realFailed = $true }
    if ($buildFiles.Count -lt 1) { Write-Host "ECHEC : build non caché" -ForegroundColor Red; $realFailed = $true }
}

Write-Host "=== Vérification cache Data Dragon ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "verify-cache.ps1") -Champion Aatrox
if ($LASTEXITCODE -ne 0) { $cacheFailed = $true }

# =========================================================================
# PASSE 2 — MOCK : progression personnelle 50 matchs + fiche de match
# =========================================================================
Write-Host "=== PASSE 2 : mock Riot (progression 50 matchs, test-only) ===" -ForegroundColor Cyan
$mockDir = Join-Path $root "_e2e-mock"
New-Item -ItemType Directory -Force -Path $mockDir | Out-Null
try {
    if (Test-Path -LiteralPath $tempCache) { Remove-Item -LiteralPath $tempCache -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $tempCache | Out-Null
    if (Test-Path -LiteralPath (Join-Path $cacheDir "ddragon")) {
        Copy-Item -Path (Join-Path $cacheDir "*") -Destination $tempCache -Recurse -Force
    }
    foreach ($stale in @("riot", "meta")) {
        $stalePath = Join-Path $tempCache $stale
        if (Test-Path -LiteralPath $stalePath) { Remove-Item -LiteralPath $stalePath -Recurse -Force }
    }
    $env:LOL_BOT_CACHE_DIR = $tempCache

    $mockLog = Join-Path $mockDir "mock-server.log"
    $mockProcess = Start-Process -FilePath "node" -ArgumentList @(
        "scripts/mock-riot-server.mjs", "--port", "$MockPort"
    ) -WorkingDirectory $root -RedirectStandardOutput $mockLog -RedirectStandardError "$mockLog.err" -PassThru -WindowStyle Hidden
    $mockReady = $false
    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
        try {
            $health = Invoke-RestMethod -Uri "http://127.0.0.1:$MockPort/__health" -TimeoutSec 2
            if ($health.ok) { $mockReady = $true; break }
        } catch {
            Start-Sleep -Milliseconds 300
        }
    }
    if (-not $mockReady) { throw "serveur mock indisponible sur le port $MockPort" }

    $app = Start-App @(
        "RIOT_API_KEY=RGAPI-mock-test",
        "RIOT_API_BASE=http://127.0.0.1:$MockPort"
    )
    try {
        node scripts\ui-scenarios-riot.mjs --port $CdpPort --mode mock --mock-url "http://127.0.0.1:$MockPort" --out-dir "_e2e-mock"
        if ($LASTEXITCODE -ne 0) { $mockFailed = $true }
    } finally {
        Close-App $app
        Restore-AppEnv $app
    }

    Write-Host "=== Cache progression Riot ===" -ForegroundColor Cyan
    $progressionDir = Join-Path $tempCache "riot\progression"
    $progressionFiles = @(Get-ChildItem -LiteralPath $progressionDir -Filter *.json -File -Recurse -ErrorAction SilentlyContinue)
    $matchFiles = @(Get-ChildItem -LiteralPath (Join-Path $tempCache "riot\match") -Filter *.json -File -ErrorAction SilentlyContinue)
    Write-Host "  progressions en cache : $($progressionFiles.Count)"
    Write-Host "  matchs en cache : $($matchFiles.Count)"
    if ($progressionFiles.Count -lt 1) { Write-Host "ECHEC : progression non cachée" -ForegroundColor Red; $mockFailed = $true }
    if ($matchFiles.Count -lt 50) { Write-Host "ECHEC : moins de 50 matchs en cache ($($matchFiles.Count))" -ForegroundColor Red; $mockFailed = $true }
} catch {
    Write-Host "PASSE MOCK en erreur : $($_.Exception.Message)" -ForegroundColor Red
    $mockFailed = $true
} finally {
    if ($null -ne $mockProcess -and -not $mockProcess.HasExited) { $mockProcess.Kill() }
    Stop-App
    if ($null -eq $savedCacheEnv -or $savedCacheEnv -eq "") { Remove-Item Env:LOL_BOT_CACHE_DIR -ErrorAction SilentlyContinue }
    else { $env:LOL_BOT_CACHE_DIR = $savedCacheEnv }
    if (Test-Path -LiteralPath $tempCache) { Remove-Item -LiteralPath $tempCache -Recurse -Force -ErrorAction SilentlyContinue }
}

Write-Host ""
Write-Host "=== RÉSULTAT E2E V0.6 ==="
Write-Host "Passe live (Méta OP.GG + non-régression) : $(-not $realFailed)"
Write-Host "Passe mock (progression 50 matchs + cache) : $(-not $mockFailed)"
Write-Host "Cache Data Dragon : $(-not $cacheFailed)"
if ($realFailed -or $mockFailed -or $cacheFailed) { exit 1 }
Write-Host "E2E V0.6 terminé." -ForegroundColor Green
