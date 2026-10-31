# E2E V0.1 : build debug, premier lancement (téléchargement Data Dragon réel),
# vérification du cache, capture de la fenêtre.
#
# Usage :
#   pwsh -File scripts/e2e-run.ps1                # build + cache vierge + capture
#   pwsh -File scripts/e2e-run.ps1 -SkipBuild      # relance rapide sans rebuild
#   pwsh -File scripts/e2e-run.ps1 -KeepCache      # conserve le cache existant

param(
    [switch]$SkipBuild,
    [switch]$KeepCache,
    [string]$OutputPath = "docs\v0.1-champions.png",
    [int]$SyncTimeoutSeconds = 240
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$exe = Join-Path $root "src-tauri\target\debug\lol-bot.exe"
$cacheDir = Join-Path $env:APPDATA "LoL BOT\cache"

if (-not $SkipBuild) {
    Write-Host "=== Build debug Tauri (frontend + Rust) ===" -ForegroundColor Cyan
    pnpm tauri build --debug --no-bundle
    if ($LASTEXITCODE -ne 0) { throw "build échoué" }
}

if (-not (Test-Path -LiteralPath $exe)) {
    throw "exécutable introuvable : $exe"
}

# Ferme une éventuelle instance précédente.
Get-Process -Name "lol-bot" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500

if (-not $KeepCache) {
    Write-Host "=== Cache vierge (premier lancement) ===" -ForegroundColor Cyan
    if (Test-Path -LiteralPath $cacheDir) {
        Remove-Item -LiteralPath $cacheDir -Recurse -Force
    }
}

Write-Host "=== Lancement de l'application ===" -ForegroundColor Cyan
$process = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
Write-Host "PID : $($process.Id)"

# Attend la fin de la synchronisation : meta.json + toutes les icônes champions.
$deadline = (Get-Date).AddSeconds($SyncTimeoutSeconds)
$lastCount = -1
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { throw "l'application s'est arrêtée prématurément (code $($process.ExitCode))" }

    $metaPath = Join-Path $cacheDir "meta.json"
    if (Test-Path -LiteralPath $metaPath) {
        $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
        $version = [string]$meta.version
        $championJson = Join-Path $cacheDir "ddragon\$version\data\en_US\champion.json"
        if (-not (Test-Path -LiteralPath $championJson)) {
            $championJson = Join-Path $cacheDir "ddragon\$version\champion.json"
        }
        if (Test-Path -LiteralPath $championJson) {
            $data = (Get-Content -LiteralPath $championJson -Raw | ConvertFrom-Json).data
            $expected = @($data.PSObject.Properties).Count
            $iconDir = Join-Path $cacheDir "ddragon\$version\img\champion"
            $actual = 0
            if (Test-Path -LiteralPath $iconDir) {
                $actual = @(Get-ChildItem -LiteralPath $iconDir -Filter *.png -File).Count
            }
            if ($actual -ne $lastCount) {
                Write-Host "  icônes téléchargées : $actual / $expected"
                $lastCount = $actual
            }
            if ($expected -gt 0 -and $actual -ge $expected) {
                Write-Host "=== Synchronisation terminée ===" -ForegroundColor Green
                break
            }
        }
    }
    Start-Sleep -Milliseconds 750
}
if ($lastCount -le 0) {
    Write-Host "ATTENTION : synchronisation non confirmée dans le délai." -ForegroundColor Yellow
}

# Laisse la WebView charger les images puis capture la fenêtre.
Start-Sleep -Seconds 3
Write-Host "=== Capture de la fenêtre ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "capture-window.ps1") -OutputPath $OutputPath -WaitSeconds 20

Write-Host "=== Vérification du cache ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "verify-cache.ps1")
$cacheOk = ($LASTEXITCODE -eq 0)

Write-Host "=== Fermeture de l'application ===" -ForegroundColor Cyan
if (-not $process.HasExited) {
    $process.CloseMainWindow() | Out-Null
    Start-Sleep -Seconds 2
    if (-not $process.HasExited) { $process.Kill() }
}

if (-not $cacheOk) {
    Write-Host "E2E terminé AVEC ÉCHECS de vérification du cache." -ForegroundColor Red
    exit 1
}
Write-Host "E2E terminé : application lancée, cache réel vérifié, capture écrite." -ForegroundColor Green
