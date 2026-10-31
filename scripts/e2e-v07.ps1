# E2E V0.7 — Rune Builder : 3 pages de runes réelles OP.GG (LIVE, sans clé) + non-régression.
#
# Ce que fait ce script :
#   1. build debug 0.7.0 ;
#   2. lance l'app (cache Data Dragon réel) et exécute la non-régression UI V0.1→V0.6
#      (ui-scenarios.mjs) puis le scénario Rune Builder (ui-scenarios-runes.mjs) :
#      Ahri mid + Dr. Mundo top → 3 pages réelles OP.GG, 4 runes primaires + 2 secondaires
#      + 3 fragments de stats, icônes locales, source/cache → docs/v0.7-rune-builder.png ;
#   3. vérifie le cache Data Dragon et le cache des pages de runes (12 h).
#
# Aucune clé Riot n'est nécessaire : OP.GG MCP est public. La progression Riot
# (V0.6) reste testée avec son propre mock dans scripts/e2e-v06.ps1.
#
# Usage :
#   pwsh -File scripts/e2e-v07.ps1
#   pwsh -File scripts/e2e-v07.ps1 -SkipBuild

param(
    [switch]$SkipBuild,
    [int]$CdpPort = 9333
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$exe = Join-Path $root "src-tauri\target\debug\lol-bot.exe"
$cacheDir = Join-Path $env:APPDATA "LoL BOT\cache"
$realFailed = $false
$cacheFailed = $false

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

if (-not $SkipBuild) {
    Write-Host "=== Build debug Tauri (frontend + Rust) ===" -ForegroundColor Cyan
    pnpm tauri build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "build échoué" }
}
if (-not (Test-Path -LiteralPath $exe)) { throw "exécutable introuvable : $exe" }

Stop-App
Remove-Item Env:RIOT_API_KEY, Env:RIOT_API_BASE, Env:LOL_BOT_CACHE_DIR -ErrorAction SilentlyContinue

Write-Host "=== Passe live : non-régression + Rune Builder OP.GG ===" -ForegroundColor Cyan
$app = $null
try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
    $app = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
    if (-not (Wait-Cdp $CdpPort 90)) { throw "port CDP $CdpPort indisponible" }

    node scripts\ui-scenarios.mjs --port $CdpPort --out-dir docs
    if ($LASTEXITCODE -ne 0) { $realFailed = $true }

    node scripts\ui-scenarios-runes.mjs --port $CdpPort --out-dir docs
    if ($LASTEXITCODE -ne 0) { $realFailed = $true }
} finally {
    if ($null -ne $app -and -not $app.HasExited) {
        $app.CloseMainWindow() | Out-Null
        Start-Sleep -Seconds 2
        if (-not $app.HasExited) { $app.Kill() }
    }
    Stop-App
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}

Write-Host "=== Cache des pages de runes (12 h) ===" -ForegroundColor Cyan
$runeCacheDir = Join-Path $cacheDir "meta\runes"
if (-not (Test-Path -LiteralPath $runeCacheDir)) {
    Write-Host "ECHEC : cache runes absent" -ForegroundColor Red
    $realFailed = $true
} else {
    $runeFiles = @(Get-ChildItem -LiteralPath $runeCacheDir -Filter *.json -File -Recurse)
    Write-Host "  pages de runes en cache : $($runeFiles.Count)"
    if ($runeFiles.Count -lt 2) { Write-Host "ECHEC : moins de 2 jeux de pages cachés (Ahri + Dr. Mundo attendus)" -ForegroundColor Red; $realFailed = $true }
}

Write-Host "=== Vérification cache Data Dragon ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "verify-cache.ps1") -Champion Aatrox
if ($LASTEXITCODE -ne 0) { $cacheFailed = $true }

Write-Host ""
Write-Host "=== RÉSULTAT E2E V0.7 ==="
Write-Host "Rune Builder OP.GG (live) + non-régression : $(-not $realFailed)"
Write-Host "Cache Data Dragon : $(-not $cacheFailed)"
if ($realFailed -or $cacheFailed) { exit 1 }
Write-Host "E2E V0.7 terminé." -ForegroundColor Green
