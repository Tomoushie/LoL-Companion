# E2E V0.3 : build debug, premier lancement (JSON + icônes champions, objets,
# runes), scénarios UI via CDP (grille, fiche Aatrox, onglet Objets, onglet
# Runes avec Précision/Conquérant, recherche de rune), captures docs/v0.3-*.png
# et vérification complète du cache (dont 67 icônes de runes + fr_FR).
#
# Usage :
#   pwsh -File scripts/e2e-v03.ps1                  # build + cache vierge + scénarios
#   pwsh -File scripts/e2e-v03.ps1 -SkipBuild -KeepCache

param(
    [switch]$SkipBuild,
    [switch]$KeepCache,
    [int]$SyncTimeoutSeconds = 300,
    [int]$CdpPort = 9333
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

if (-not (Test-Path -LiteralPath $exe)) { throw "exécutable introuvable : $exe" }

Get-Process -Name "lol-bot" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 600

if (-not $KeepCache) {
    Write-Host "=== Cache vierge (premier lancement) ===" -ForegroundColor Cyan
    if (Test-Path -LiteralPath $cacheDir) { Remove-Item -LiteralPath $cacheDir -Recurse -Force }
}

# Port CDP dédié : WebView2 l'ouvre au démarrage de l'app.
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$CdpPort"

Write-Host "=== Lancement de l'application ===" -ForegroundColor Cyan
$process = Start-Process -FilePath $exe -WorkingDirectory $root -PassThru
Write-Host "PID : $($process.Id)"

# Attend la fin de la synchronisation : JSON + icônes champions + objets + runes.
$deadline = (Get-Date).AddSeconds($SyncTimeoutSeconds)
$lastSummary = ""
while ((Get-Date) -lt $deadline) {
    if ($process.HasExited) { throw "l'application s'est arrêtée prématurément (code $($process.ExitCode))" }

    $metaPath = Join-Path $cacheDir "meta.json"
    if (Test-Path -LiteralPath $metaPath) {
        try {
            $meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
            $version = [string]$meta.version
            $versionDir = Join-Path $cacheDir "ddragon\$version"
            $championJson = Join-Path $versionDir "champion.json"
            $itemJson = Join-Path $versionDir "item.json"
            $runesJson = Join-Path $versionDir "runesReforged.json"
            if ((Test-Path -LiteralPath $championJson) -and (Test-Path -LiteralPath $itemJson) -and (Test-Path -LiteralPath $runesJson)) {
                $champions = (Get-Content -LiteralPath $championJson -Raw | ConvertFrom-Json).data
                $items = (Get-Content -LiteralPath $itemJson -Raw | ConvertFrom-Json).data
                $runeTrees = @(Get-Content -LiteralPath $runesJson -Raw | ConvertFrom-Json)
                $championCount = @($champions.PSObject.Properties).Count
                $itemCount = @($items.PSObject.Properties | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.Value.name) }).Count

                $championIcons = 0
                $championIconDir = Join-Path $versionDir "img\champion"
                if (Test-Path -LiteralPath $championIconDir) {
                    $championIcons = @(Get-ChildItem -LiteralPath $championIconDir -Filter *.png -File).Count
                }
                $itemIcons = 0
                $itemIconDir = Join-Path $versionDir "img\item"
                if (Test-Path -LiteralPath $itemIconDir) {
                    $itemIcons = @(Get-ChildItem -LiteralPath $itemIconDir -Filter *.png -File).Count
                }

                # Icônes de runes : chemins relatifs listés par le JSON, vérifiés sur disque.
                $runeIconPaths = New-Object System.Collections.Generic.List[string]
                foreach ($tree in $runeTrees) {
                    if (-not [string]::IsNullOrWhiteSpace([string]$tree.icon)) { $runeIconPaths.Add([string]$tree.icon) }
                    foreach ($slot in $tree.slots) {
                        foreach ($rune in $slot.runes) {
                            if (-not [string]::IsNullOrWhiteSpace([string]$rune.icon)) { $runeIconPaths.Add([string]$rune.icon) }
                        }
                    }
                }
                $runeIcons = 0
                foreach ($relative in $runeIconPaths) {
                    $local = Join-Path (Join-Path $versionDir "img") ($relative -replace '/', '\')
                    if (Test-Path -LiteralPath $local) { $runeIcons++ }
                }
                $frRunes = Test-Path -LiteralPath (Join-Path (Join-Path $versionDir "fr_FR") "runesReforged.json")

                $summary = "icônes champions $championIcons/$championCount, objets $itemIcons/$itemCount, runes $runeIcons/$($runeIconPaths.Count), fr_FR=$frRunes"
                if ($summary -ne $lastSummary) {
                    Write-Host "  $summary"
                    $lastSummary = $summary
                }
                if ($championIcons -ge $championCount -and $itemIcons -ge $itemCount -and $runeIcons -ge $runeIconPaths.Count -and $frRunes) {
                    Write-Host "=== Synchronisation terminée ===" -ForegroundColor Green
                    break
                }
            }
        } catch {
            # Cache en cours d'écriture : on réessaie.
        }
    }
    Start-Sleep -Milliseconds 800
}
if ($lastSummary -eq "") { throw "synchronisation non confirmée dans le délai imparti" }

# Attend que le port CDP expose la page WebView.
$cdpDeadline = (Get-Date).AddSeconds(60)
$cdpReady = $false
while ((Get-Date) -lt $cdpDeadline) {
    try {
        $targets = Invoke-RestMethod -Uri "http://127.0.0.1:$CdpPort/json/list" -TimeoutSec 3
        if (@($targets | Where-Object { $_.type -eq "page" }).Count -gt 0) { $cdpReady = $true; break }
    } catch {
        Start-Sleep -Milliseconds 400
    }
}
if (-not $cdpReady) { throw "port CDP $CdpPort indisponible" }

Write-Host "=== Scénarios UI (CDP) ===" -ForegroundColor Cyan
node scripts\ui-scenarios.mjs --port $CdpPort --out-dir docs
$uiOk = ($LASTEXITCODE -eq 0)

Write-Host "=== Vérification du cache ===" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "verify-cache.ps1") -Champion Aatrox
$cacheOk = ($LASTEXITCODE -eq 0)

Write-Host "=== Fermeture de l'application ===" -ForegroundColor Cyan
if (-not $process.HasExited) {
    $process.CloseMainWindow() | Out-Null
    Start-Sleep -Seconds 2
    if (-not $process.HasExited) { $process.Kill() }
}

if (-not $uiOk) { Write-Host "E2E : scénarios UI en échec." -ForegroundColor Red; exit 1 }
if (-not $cacheOk) { Write-Host "E2E : vérification du cache en échec." -ForegroundColor Red; exit 1 }
Write-Host "E2E V0.3 terminé : onglet Runes + fiche Aatrox + onglet Objets + cache vérifiés." -ForegroundColor Green
