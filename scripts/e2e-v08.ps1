# E2E V0.8 — Glossaire intégré (local, sans réseau) + non-régression.
#
# Ce que fait ce script :
#   1. build debug 0.8.0 (sauf -SkipBuild) ;
#   2. lance directement l'exécutable (plus besoin de script séparé) avec CDP ;
#   3. exécute la non-régression UI V0.1→V0.7 puis le scénario Glossaire :
#      133 termes, recherche FR/EN, alias, catégories, état vide, liens « Voir aussi »,
#      capture docs/v0.8-glossaire.png ;
#   4. vérifie le cache Data Dragon.
#
# Aucune clé Riot, aucun appel réseau : le glossaire est entièrement local.
#
# Usage :
#   pwsh -File scripts/e2e-v08.ps1
#   pwsh -File scripts/e2e-v08.ps1 -SkipBuild

param(
    [switch]$SkipBuild,
    [int]$CdpPort = 9333
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$exe = Join-Path $root "src-tauri\target\debug\lol-bot.exe"
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

Write-Host "=== Lancement direct de l'exe + scénarios ===" -ForegroundColor Cyan
$app = $null
try {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"
    $app = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
    if (-not (Wait-Cdp $CdpPort 90)) { throw "port CDP $CdpPort indisponible" }

    node scripts\ui-scenarios.mjs --port $CdpPort --out-dir docs
    if ($LASTEXITCODE -ne 0) { $realFailed = $true }

    node scripts\ui-scenarios-glossary.mjs --port $CdpPort --out-dir docs
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

Write-Host "=== Vérification cache Data Dragon ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "verify-cache.ps1") -Champion Aatrox
if ($LASTEXITCODE -ne 0) { $cacheFailed = $true }

Write-Host ""
Write-Host "=== RÉSULTAT E2E V0.8 ==="
Write-Host "Glossaire + non-régression : $(-not $realFailed)"
Write-Host "Cache Data Dragon : $(-not $cacheFailed)"
if ($realFailed -or $cacheFailed) { exit 1 }
Write-Host "E2E V0.8 terminé." -ForegroundColor Green
