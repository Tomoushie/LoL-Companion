# E2E V0.5 — Riot API.
#
# Deux passes :
#   1. RÉEL (sans clé valide) : non-régression V0.1→V0.4 + onglet Profil sans clé
#      + clé invalide enregistrée localement → vrai appel Riot (401) → erreur claire.
#      La clé locale existante de l'utilisateur est sauvegardée puis restaurée.
#   2. MOCK (test-only) : serveur scripts/mock-riot-server.mjs + RIOT_API_BASE
#      → vérifie le flux complet UI/backend, les 10 matchs, la fiche de match,
#      le cache (2e chargement = 0 requête réseau) et le rafraîchissement forcé.
#      Les captures mock vont dans `_e2e-mock/` et ne sont PAS des données réelles.
#
# Usage :
#   pwsh -File scripts/e2e-v05.ps1                  # build + deux passes
#   pwsh -File scripts/e2e-v05.ps1 -SkipBuild
#   pwsh -File scripts/e2e-v05.ps1 -FreshCache      # supprime aussi le cache Data Dragon

param(
    [switch]$SkipBuild,
    [switch]$FreshCache,
    [int]$CdpPort = 9333,
    [int]$MockPort = 18765
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$exe = Join-Path $root "src-tauri\target\debug\lol-bot.exe"
$cacheDir = Join-Path $env:APPDATA "LoL BOT\cache"
$configDir = Join-Path $env:APPDATA "LoL BOT\config"
$keyFile = Join-Path $configDir "riot_api_key"
$keyBackup = $null
$mockProcess = $null
$realFailed = $false
$mockFailed = $false
$cacheFailed = $false

function Stop-App {
    Get-Process -Name "lol-bot" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 700
}

function Wait-Cdp([int]$port, [int]$timeoutSeconds = 60) {
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
    foreach ($name in @("RIOT_API_KEY", "RIOT_API_BASE")) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
    Remove-Item Env:RIOT_API_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:RIOT_API_BASE -ErrorAction SilentlyContinue
    foreach ($pair in $extraEnv) {
        $parts = $pair.Split("=", 2)
        Set-Item -Path "Env:$($parts[0])" -Value $parts[1]
    }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
    $process = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
    Write-Host "Application lancée (PID $($process.Id))"
    if (-not (Wait-Cdp $CdpPort 90)) { throw "port CDP $CdpPort indisponible" }
    return @{ Process = $process; Env = $saved }
}

function Restore-AppEnv($state) {
    foreach ($name in @("RIOT_API_KEY", "RIOT_API_BASE")) {
        if ($null -ne $state.Env[$name] -and $state.Env[$name] -ne "") {
            Set-Item -Path "Env:$name" -Value $state.Env[$name]
        } else {
            Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue
        }
    }
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}

function Close-App($process) {
    if ($null -ne $process -and -not $process.HasExited) {
        $process.CloseMainWindow() | Out-Null
        Start-Sleep -Seconds 2
        if (-not $process.HasExited) { $process.Kill() }
    }
    Stop-App
}

# --- Sauvegarde/neutralisation de la clé locale de l'utilisateur ----------
if (Test-Path -LiteralPath $keyFile) {
    $keyBackup = Join-Path ([System.IO.Path]::GetTempPath()) "lolbot-riot-key-backup-$([guid]::NewGuid().ToString('N')).txt"
    Copy-Item -LiteralPath $keyFile -Destination $keyBackup -Force
    Write-Host "Clé locale existante sauvegardée puis neutralisée pour les tests."
    Remove-Item -LiteralPath $keyFile -Force
}

if (-not $SkipBuild) {
    Write-Host "=== Build debug Tauri (frontend + Rust) ===" -ForegroundColor Cyan
    pnpm tauri build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "build échoué" }
}
if (-not (Test-Path -LiteralPath $exe)) { throw "exécutable introuvable : $exe" }

if ($FreshCache -and (Test-Path -LiteralPath $cacheDir)) {
    Write-Host "=== Cache supprimé (premier lancement) ===" -ForegroundColor Cyan
    Remove-Item -LiteralPath $cacheDir -Recurse -Force
}

Stop-App

# --- Cache e2e isolé : le cache réel de l'utilisateur n'est jamais modifié -----
$tempCache = Join-Path $root "_e2e-cache"
if (Test-Path -LiteralPath $tempCache) { Remove-Item -LiteralPath $tempCache -Recurse -Force }
New-Item -ItemType Directory -Force -Path $tempCache | Out-Null
if (-not $FreshCache -and (Test-Path -LiteralPath (Join-Path $cacheDir "ddragon"))) {
    Copy-Item -Path (Join-Path $cacheDir "*") -Destination $tempCache -Recurse -Force
}
$tempRiotCache = Join-Path $tempCache "riot"
if (Test-Path -LiteralPath $tempRiotCache) { Remove-Item -LiteralPath $tempRiotCache -Recurse -Force }
$savedCacheEnv = $env:LOL_BOT_CACHE_DIR
$env:LOL_BOT_CACHE_DIR = $tempCache
Write-Host "Cache e2e isolé : $tempCache"

# =========================================================================
# PASSE 1 — RÉEL sans clé valide
# =========================================================================
Write-Host "=== PASSE 1 : réel (sans clé / clé invalide) ===" -ForegroundColor Cyan
$app = $null
try {
    $app = Start-App
    Write-Host "=== Scénarios non-régression V0.1→V0.4 ===" -ForegroundColor Cyan
    node scripts\ui-scenarios.mjs --port $CdpPort --out-dir docs
    if ($LASTEXITCODE -ne 0) { $realFailed = $true }

    Write-Host "=== Profil sans clé ===" -ForegroundColor Cyan
    node scripts\ui-scenarios-riot.mjs --port $CdpPort --mode no-key --out-dir docs
    if ($LASTEXITCODE -ne 0) { $realFailed = $true }

    Write-Host "=== Profil clé invalide (vrai appel Riot 401) ===" -ForegroundColor Cyan
    node scripts\ui-scenarios-riot.mjs --port $CdpPort --mode invalid-key --out-dir docs
    if ($LASTEXITCODE -ne 0) { $realFailed = $true }
} finally {
    Close-App $app.Process
    if ($null -ne $app) { Restore-AppEnv $app }
    if (Test-Path -LiteralPath $keyFile) { Remove-Item -LiteralPath $keyFile -Force }
}

Write-Host "=== Vérification cache Data Dragon (non-régression) ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "verify-cache.ps1") -CacheDir $tempCache -Champion Aatrox
if ($LASTEXITCODE -ne 0) { $cacheFailed = $true }

# =========================================================================
# PASSE 2 — MOCK test-only (serveur local, données simulées)
# =========================================================================
Write-Host "=== PASSE 2 : intégration mock (test-only) ===" -ForegroundColor Cyan
$mockDir = Join-Path $root "_e2e-mock"
New-Item -ItemType Directory -Force -Path $mockDir | Out-Null
try {
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

    # Repart d'un cache Riot vide pour vérifier le vrai premier appel réseau.
    if (Test-Path -LiteralPath $tempRiotCache) { Remove-Item -LiteralPath $tempRiotCache -Recurse -Force }

    $app = Start-App @(
        "RIOT_API_KEY=RGAPI-mock-test",
        "RIOT_API_BASE=http://127.0.0.1:$MockPort"
    )
    try {
        node scripts\ui-scenarios-riot.mjs --port $CdpPort --mode mock --mock-url "http://127.0.0.1:$MockPort" --out-dir "_e2e-mock"
        if ($LASTEXITCODE -ne 0) { $mockFailed = $true }
    } finally {
        Close-App $app.Process
        Restore-AppEnv $app
    }

    Write-Host "=== Inventaire cache Riot ===" -ForegroundColor Cyan
    $riotCache = Join-Path $tempCache "riot"
    if (-not (Test-Path -LiteralPath $riotCache)) {
        Write-Host "ECHEC : cache Riot absent" -ForegroundColor Red
        $mockFailed = $true
    } else {
        $rateFile = Join-Path $riotCache "rate-limits.json"
        $matchFiles = @(Get-ChildItem -LiteralPath (Join-Path $riotCache "match") -Filter *.json -File -ErrorAction SilentlyContinue)
        $leagueFiles = @(Get-ChildItem -LiteralPath (Join-Path $riotCache "league") -Filter *.json -File -Recurse -ErrorAction SilentlyContinue)
        Write-Host "  rate-limits.json : $(Test-Path -LiteralPath $rateFile)"
        Write-Host "  matchs en cache : $($matchFiles.Count)"
        Write-Host "  classements en cache : $($leagueFiles.Count)"
        if (-not (Test-Path -LiteralPath $rateFile)) { Write-Host "ECHEC : fichier rate-limits absent" -ForegroundColor Red; $mockFailed = $true }
        if ($matchFiles.Count -lt 10) { Write-Host "ECHEC : moins de 10 matchs en cache" -ForegroundColor Red; $mockFailed = $true }
        if ($leagueFiles.Count -lt 1) { Write-Host "ECHEC : classements absents du cache" -ForegroundColor Red; $mockFailed = $true }
    }
} catch {
    Write-Host "PASSE MOCK en erreur : $($_.Exception.Message)" -ForegroundColor Red
    $mockFailed = $true
} finally {
    if ($null -ne $mockProcess -and -not $mockProcess.HasExited) { $mockProcess.Kill() }
    Stop-App
}

# --- Restauration de la clé utilisateur -----------------------------------
if ($null -ne $keyBackup -and (Test-Path -LiteralPath $keyBackup)) {
    New-Item -ItemType Directory -Force -Path $configDir | Out-Null
    Copy-Item -LiteralPath $keyBackup -Destination $keyFile -Force
    Remove-Item -LiteralPath $keyBackup -Force
    Write-Host "Clé locale utilisateur restaurée."
}
if ($null -eq $savedCacheEnv -or $savedCacheEnv -eq "") {
    Remove-Item Env:LOL_BOT_CACHE_DIR -ErrorAction SilentlyContinue
} else {
    $env:LOL_BOT_CACHE_DIR = $savedCacheEnv
}
if (Test-Path -LiteralPath $tempCache) { Remove-Item -LiteralPath $tempCache -Recurse -Force -ErrorAction SilentlyContinue }

Write-Host ""
Write-Host "=== RÉSULTAT E2E V0.5 ==="
Write-Host "Passe réelle (non-régression + sans/invalide clé) : $(-not $realFailed)"
Write-Host "Passe mock (UI/backend/cache/rate-limit, test-only) : $(-not $mockFailed)"
Write-Host "Cache Data Dragon : $(-not $cacheFailed)"
if ($realFailed -or $mockFailed -or $cacheFailed) { exit 1 }
Write-Host "E2E V0.5 terminé." -ForegroundColor Green
