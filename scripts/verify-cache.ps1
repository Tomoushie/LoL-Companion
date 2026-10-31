# Vérifie l'authenticité et l'intégrité du cache Data Dragon de LoL BOT.
#
# Contrôles :
#   1. présence et version de meta.json ;
#   2. JSON critiques (champion.json, item.json, runesReforged.json) lisibles ;
#   3. empreinte SHA-256 comparée au CDN Data Dragon (preuve de données réelles) ;
#   4. icônes PNG champions + icônes PNG objets : nombre, signature, taille ;
#   5. comptage champions / items / arbres de runes ;
#   6. optionnellement (`-Champion Aatrox`) : fiche champion en cache, splash
#      JPEG, icônes de sorts et de passif.
#
# Usage :
#   pwsh -File scripts/verify-cache.ps1
#   pwsh -File scripts/verify-cache.ps1 -Champion Aatrox
#   pwsh -File scripts/verify-cache.ps1 -CacheDir "D:\tmp\cache" -Offline

param(
    [string]$CacheDir = (Join-Path $env:APPDATA "LoL BOT\cache"),
    [string]$Champion = "",
    [switch]$Offline
)

$ErrorActionPreference = "Stop"
$failures = New-Object System.Collections.Generic.List[string]
$report = [ordered]@{}

function Fail([string]$message) {
    $failures.Add($message) | Out-Null
    Write-Host "ECHEC : $message" -ForegroundColor Red
}

function Ok([string]$message) {
    Write-Host "OK    : $message" -ForegroundColor Green
}

Write-Host "Cache vérifié : $CacheDir"
if (-not (Test-Path -LiteralPath $CacheDir)) {
    Fail "dossier de cache absent"
    exit 1
}

$metaPath = Join-Path $CacheDir "meta.json"
if (-not (Test-Path -LiteralPath $metaPath)) {
    Fail "meta.json absent (aucune synchronisation réussie)"
    exit 1
}

$meta = Get-Content -LiteralPath $metaPath -Raw | ConvertFrom-Json
$version = [string]$meta.version
if ([string]::IsNullOrWhiteSpace($version)) {
    Fail "meta.json sans version"
    exit 1
}
if ($version -notmatch '^[0-9A-Za-z._-]+$') {
    Fail "version invalide : $version"
    exit 1
}
$report.version = $version
$report.updatedAt = $meta.updatedAt
$report.lastSyncError = $meta.lastSyncError
Ok "version Data Dragon : $version"

$versionDir = Join-Path (Join-Path $CacheDir "ddragon") $version
$cdn = "https://ddragon.leagueoflegends.com/cdn/$version"
$httpClient = [System.Net.Http.HttpClient]::new()
$httpClient.Timeout = [TimeSpan]::FromSeconds(30)

# --- JSON critiques ---
$jsonFiles = @(
    @{ Name = "champion.json"; Url = "$cdn/data/en_US/champion.json" },
    @{ Name = "item.json"; Url = "$cdn/data/en_US/item.json" },
    @{ Name = "runesReforged.json"; Url = "$cdn/data/en_US/runesReforged.json" }
)

$champions = $null
$items = $null
$runeTrees = $null

foreach ($file in $jsonFiles) {
    $path = Join-Path $versionDir $file.Name
    if (-not (Test-Path -LiteralPath $path)) {
        Fail "$($file.Name) absent"
        continue
    }
    try {
        $raw = Get-Content -LiteralPath $path -Raw
        $parsed = $raw | ConvertFrom-Json
    } catch {
        Fail "$($file.Name) illisible : $($_.Exception.Message)"
        continue
    }
    switch ($file.Name) {
        "champion.json" { $champions = $parsed.data }
        "item.json" { $items = $parsed.data }
        "runesReforged.json" { $runeTrees = $parsed }
    }

    $localHash = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash
    if (-not $Offline) {
        try {
            # Octets bruts (pas la chaîne décodée) pour une empreinte identique au CDN.
            $remoteBytes = $httpClient.GetByteArrayAsync($file.Url).GetAwaiter().GetResult()
            $remoteHash = [System.Security.Cryptography.SHA256]::HashData($remoteBytes)
            $remoteHex = [System.Convert]::ToHexString($remoteHash)
            if ($remoteHex -ne $localHash) {
                Fail "$($file.Name) : empreinte différente du CDN (fichier local modifié ou version remplacée)"
            } else {
                Ok "$($file.Name) : empreinte SHA-256 identique au CDN ($($localHash.Substring(0, 12))…)"
            }
        } catch {
            Write-Host "INFO  : comparaison CDN impossible pour $($file.Name) : $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }
}

# --- Comptages ---
$championCount = 0
if ($null -ne $champions) {
    $championCount = @($champions.PSObject.Properties).Count
}
$itemCount = 0
if ($null -ne $items) {
    foreach ($prop in $items.PSObject.Properties) {
        $item = $prop.Value
        if (-not [string]::IsNullOrWhiteSpace([string]$item.name) -and $item.gold) {
            $itemCount++
        }
    }
}
$runeTreeCount = 0
if ($null -ne $runeTrees) {
    $runeTreeCount = @($runeTrees).Count
}
$report.counts = [ordered]@{ champions = $championCount; items = $itemCount; runeTrees = $runeTreeCount }

if ($championCount -eq 0) { Fail "aucun champion dans le cache" } else { Ok "$championCount champions" }
if ($itemCount -eq 0) { Fail "aucun objet dans le cache" } else { Ok "$itemCount objets" }
if ($runeTreeCount -eq 0) { Fail "aucun arbre de runes dans le cache" } else { Ok "$runeTreeCount arbres de runes" }

# --- Icônes PNG ---
$iconDir = Join-Path $versionDir "img\champion"
$pngSignature = [byte[]](0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
$icons = @()
if (Test-Path -LiteralPath $iconDir) {
    $icons = @(Get-ChildItem -LiteralPath $iconDir -Filter *.png -File)
}
$invalid = 0
$valid = 0
foreach ($icon in $icons) {
    if ($icon.Length -lt 128) { $invalid++; continue }
    $bytes = [System.IO.File]::ReadAllBytes($icon.FullName)[0..7]
    $match = $true
    for ($i = 0; $i -lt 8; $i++) { if ($bytes[$i] -ne $pngSignature[$i]) { $match = $false; break } }
    if ($match) { $valid++ } else { $invalid++ }
}
$report.counts.iconsCached = $valid
if ($invalid -gt 0) { Fail "$invalid icône(s) PNG corrompue(s)" }
if ($valid -eq 0) { Fail "aucune icône champion en cache" } else { Ok "$valid icônes PNG valides (signature vérifiée)" }
if ($championCount -gt 0 -and $valid -lt $championCount) {
    Write-Host "INFO  : $($championCount - $valid) icône(s) champion manquante(s) (téléchargement partiel possible)" -ForegroundColor Yellow
}

# --- Icônes PNG des objets (V0.2) ---
$itemIconDir = Join-Path $versionDir "img\item"
$itemIcons = @()
if (Test-Path -LiteralPath $itemIconDir) {
    $itemIcons = @(Get-ChildItem -LiteralPath $itemIconDir -Filter *.png -File)
}
$invalidItemIcons = 0
$validItemIcons = 0
foreach ($icon in $itemIcons) {
    if ($icon.Length -lt 128) { $invalidItemIcons++; continue }
    $bytes = [System.IO.File]::ReadAllBytes($icon.FullName)[0..7]
    $match = $true
    for ($i = 0; $i -lt 8; $i++) { if ($bytes[$i] -ne $pngSignature[$i]) { $match = $false; break } }
    if ($match) { $validItemIcons++ } else { $invalidItemIcons++ }
}
$report.counts.itemIconsCached = $validItemIcons
if ($invalidItemIcons -gt 0) { Fail "$invalidItemIcons icône(s) d'objet corrompue(s)" }
if ($validItemIcons -eq 0) {
    Fail "aucune icône d'objet en cache"
} else {
    Ok "$validItemIcons icônes PNG d'objets valides (signature vérifiée)"
}
if ($itemCount -gt 0 -and $validItemIcons -lt $itemCount) {
    Fail "$($itemCount - $validItemIcons) icône(s) d'objet manquante(s) sur $itemCount objets"
}

# --- Fiche champion détaillée (V0.2, optionnel) ---
if (-not [string]::IsNullOrWhiteSpace($Champion)) {
    $detailPath = Join-Path (Join-Path $versionDir "champion") "$Champion.json"
    $detail = $null
    if (-not (Test-Path -LiteralPath $detailPath)) {
        Fail "fiche champion « $Champion » absente du cache ($detailPath)"
    } else {
        try {
            $detailFile = Get-Content -LiteralPath $detailPath -Raw | ConvertFrom-Json
            $detailProp = $detailFile.data.PSObject.Properties[$Champion]
            if ($detailProp) { $detail = $detailProp.Value }
        } catch {
            Fail "fiche champion « $Champion » illisible : $($_.Exception.Message)"
        }
        if ($null -eq $detail) {
            Fail "fiche champion « $Champion » sans données dans $detailPath"
        }
    }

    if ($null -ne $detail) {
        $spells = @($detail.spells)
        if ($spells.Count -lt 4) {
            Fail "fiche $Champion : $($spells.Count) sort(s) au lieu de 4"
        } else {
            Ok "fiche $Champion : $($spells.Count) sorts"
        }

        $spellIconCount = 0
        foreach ($spell in $spells) {
            $iconName = [string]$spell.image.full
            if ([string]::IsNullOrWhiteSpace($iconName)) { continue }
            $spellIconPath = Join-Path (Join-Path $versionDir "img\spell") $iconName
            if (Test-Path -LiteralPath $spellIconPath) {
                $spellIconCount++
            } else {
                Fail "icône du sort « $($spell.name) » absente ($iconName)"
            }
        }
        if ($spells.Count -gt 0 -and $spellIconCount -eq $spells.Count) {
            Ok "$spellIconCount icônes de sorts présentes"
        }

        $splashPath = Join-Path (Join-Path (Join-Path $versionDir "img\champion") "splash") "${Champion}_0.jpg"
        $splashBytes = 0
        if (-not (Test-Path -LiteralPath $splashPath)) {
            Fail "splash art de $Champion absent ($splashPath)"
        } else {
            $splashBytes = (Get-Item -LiteralPath $splashPath).Length
            $jpegHead = [System.IO.File]::ReadAllBytes($splashPath)[0..2]
            if ($splashBytes -lt 1024 -or $jpegHead[0] -ne 0xFF -or $jpegHead[1] -ne 0xD8 -or $jpegHead[2] -ne 0xFF) {
                Fail "splash art de $Champion invalide (signature JPEG / taille)"
            } else {
                Ok "splash art de $Champion valide ($([math]::Round($splashBytes / 1KB, 1)) Ko, JPEG)"
            }
        }

        $passiveOk = $false
        if ($null -ne $detail.passive) {
            $passiveIcon = [string]$detail.passive.image.full
            if (-not [string]::IsNullOrWhiteSpace($passiveIcon)) {
                $passivePath = Join-Path (Join-Path $versionDir "img\passive") $passiveIcon
                $passiveOk = Test-Path -LiteralPath $passivePath
                if ($passiveOk) { Ok "icône du passif présente ($passiveIcon)" } else { Fail "icône du passif absente ($passiveIcon)" }
            }
        }

        $report.championDetail = [ordered]@{
            id          = $Champion
            spells      = $spells.Count
            spellIcons  = $spellIconCount
            splashBytes = $splashBytes
            passiveIcon = $passiveOk
        }
    }
}

# --- Runes : localisation fr_FR + icônes (V0.3) ---
$runeIconPaths = New-Object System.Collections.Generic.HashSet[string]
foreach ($tree in $runeTrees) {
    if (-not [string]::IsNullOrWhiteSpace([string]$tree.icon)) {
        $runeIconPaths.Add([string]$tree.icon) | Out-Null
    }
    foreach ($slot in $tree.slots) {
        foreach ($rune in $slot.runes) {
            if (-not [string]::IsNullOrWhiteSpace([string]$rune.icon)) {
                $runeIconPaths.Add([string]$rune.icon) | Out-Null
            }
        }
    }
}
$validRuneIcons = 0
$missingRuneIcons = 0
foreach ($relative in $runeIconPaths) {
    $localPath = Join-Path (Join-Path $versionDir "img") ($relative -replace '/', '\')
    if (-not (Test-Path -LiteralPath $localPath)) {
        $missingRuneIcons++
        continue
    }
    $bytes = [System.IO.File]::ReadAllBytes($localPath)
    if ($bytes.Length -lt 128) { $missingRuneIcons++; continue }
    $match = $true
    for ($i = 0; $i -lt 8; $i++) { if ($bytes[$i] -ne $pngSignature[$i]) { $match = $false; break } }
    if ($match) { $validRuneIcons++ } else { $missingRuneIcons++ }
}
$report.counts.runeIconsCached = $validRuneIcons
if ($validRuneIcons -eq 0) {
    Fail "aucune icône de rune en cache"
} else {
    Ok "$validRuneIcons icônes PNG de runes/arbres valides (signature vérifiée, $($runeIconPaths.Count) attendues)"
}
if ($missingRuneIcons -gt 0) {
    Fail "$missingRuneIcons icône(s) de rune manquante(s) ou corrompue(s) sur $($runeIconPaths.Count)"
}

$frRunesPath = Join-Path (Join-Path $versionDir "fr_FR") "runesReforged.json"
$frRunesOk = $false
$frPrecisionName = $null
$frConquerorName = $null
if (-not (Test-Path -LiteralPath $frRunesPath)) {
    Fail "localisation fr_FR des runes absente ($frRunesPath)"
} else {
    try {
        $frRunes = @(Get-Content -LiteralPath $frRunesPath -Raw | ConvertFrom-Json)
        $frPrecision = $frRunes | Where-Object { $_.id -eq 8000 } | Select-Object -First 1
        if ($null -ne $frPrecision) { $frPrecisionName = [string]$frPrecision.name }
        foreach ($slot in $frPrecision.slots) {
            foreach ($rune in $slot.runes) {
                if ($rune.id -eq 8010) { $frConquerorName = [string]$rune.name }
            }
        }
        $frRunesOk = ($frRunes.Count -eq 5 -and $frPrecisionName -eq "Précision" -and $frConquerorName -eq "Conquérant")
    } catch {
        Fail "localisation fr_FR des runes illisible : $($_.Exception.Message)"
    }
}
if ($frRunesOk) {
    Ok "localisation fr_FR : 5 arbres, Précision = « $frPrecisionName », 8010 = « $frConquerorName »"
} elseif (Test-Path -LiteralPath $frRunesPath) {
    Fail "localisation fr_FR incohérente (Précision = « $frPrecisionName », 8010 = « $frConquerorName »)"
}
$report.runes = [ordered]@{
    trees             = $runeTreeCount
    runeIcons         = $validRuneIcons
    runeIconsExpected = $runeIconPaths.Count
    frFile            = $frRunesOk
    frPrecisionName   = $frPrecisionName
    frConquerorName   = $frConquerorName
}

# --- Fichiers inattendus dans le cache (aucune donnée personnelle attendue) ---
# Les sous-dossiers `riot/` (clé, rate-limits, matchs) et `meta/` (tier list/builds
# OP.GG) sont des caches distincts, ignorés par cette vérification Data Dragon.
$riotCacheDir = Join-Path $CacheDir "riot"
$metaCacheDir = Join-Path $CacheDir "meta"
$unexpected = @(Get-ChildItem -LiteralPath $CacheDir -File -Recurse | Where-Object {
        $_.FullName -notlike "$riotCacheDir\*" -and
        $_.FullName -notlike "$metaCacheDir\*" -and
        $_.Name -notin @("meta.json", "champion.json", "item.json", "runesReforged.json") -and
        $_.Extension -notin @(".png", ".jpg") -and
        $_.Name -notlike "*.tmp*" -and
        -not ($_.Extension -eq ".json" -and $_.DirectoryName -eq (Join-Path $versionDir "champion")) -and
        -not ($_.Extension -eq ".json" -and $_.DirectoryName -eq (Join-Path $versionDir "fr_FR"))
    })
if ($unexpected.Count -gt 0) {
    Fail "fichiers inattendus dans le cache : $(($unexpected | Select-Object -First 5 -ExpandProperty Name) -join ', ')"
} else {
    Ok "aucun fichier inattendu dans le cache"
}

$report.failures = $failures
$report.success = ($failures.Count -eq 0)

$json = $report | ConvertTo-Json -Depth 6
$jsonPath = Join-Path (Split-Path -Parent $PSScriptRoot) "docs\cache-verification.json"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $jsonPath) | Out-Null
Set-Content -LiteralPath $jsonPath -Value $json -Encoding UTF8
Write-Host ""
Write-Host "Rapport JSON : $jsonPath"
Write-Host "Résultat : $($report.success) ($($failures.Count) échec(s))"
if ($failures.Count -gt 0) { exit 1 }
exit 0
