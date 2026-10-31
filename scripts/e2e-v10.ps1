# E2E V1.0 — Esport Riot (ligues/équipes/joueurs/tournois/classements) + curseur + non-régression.
#
# Sources RÉELLES : Riot Esports API publique (aucune clé utilisateur) et cache local.
# Le curseur est local. Aucun mock n'est utilisé dans cette passe.
#
# Usage :
#   pwsh -File scripts/e2e-v10.ps1
#   pwsh -File scripts/e2e-v10.ps1 -SkipBuild

param(
    [switch]$SkipBuild,
    [int]$CdpPort = 9333
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$exe = Join-Path $root "src-tauri\target\debug\lol-bot.exe"
$cacheDir = Join-Path $env:APPDATA "LoL BOT\cache"
$failed = $false
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
    Write-Host "=== Build debug (frontend + Rust) ===" -ForegroundColor Cyan
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
    if ($LASTEXITCODE -ne 0) { $failed = $true }

    node scripts\ui-scenarios-esports.mjs --port $CdpPort --out-dir docs
    if ($LASTEXITCODE -ne 0) { $failed = $true }
} finally {
    if ($null -ne $app -and -not $app.HasExited) {
        $app.CloseMainWindow() | Out-Null
        Start-Sleep -Seconds 2
        if (-not $app.HasExited) { $app.Kill() }
    }
    Stop-App
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
}

Write-Host "=== Cache Esport ===" -ForegroundColor Cyan
$esportsCache = Join-Path $cacheDir "esports"
if (-not (Test-Path -LiteralPath $esportsCache)) {
    Write-Host "ECHEC : cache Esport absent" -ForegroundColor Red
    $failed = $true
} else {
    $files = @(Get-ChildItem -LiteralPath $esportsCache -File -Recurse -Filter *.json)
    Write-Host "  fichiers esport en cache : $($files.Count)"
    if ($files.Count -lt 2) { Write-Host "ECHEC : cache esport incomplet" -ForegroundColor Red; $failed = $true }
}

Write-Host "=== Vérification cache Data Dragon ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "verify-cache.ps1") -Champion Aatrox
if ($LASTEXITCODE -ne 0) { $cacheFailed = $true }

Write-Host ""
Write-Host "=== RÉSULTAT E2E V1.0 ==="
Write-Host "Esport + curseur + non-régression : $(-not $failed)"
Write-Host "Cache Data Dragon : $(-not $cacheFailed)"
if ($failed -or $cacheFailed) { exit 1 }
Write-Host "E2E V1.0 terminé." -ForegroundColor Green
