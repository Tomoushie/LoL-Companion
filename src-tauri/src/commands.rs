//! Commandes Tauri exposées au frontend.
//!
//! Contrat : voir `model.rs` (Rust) et `src/types.ts` (TypeScript). Sont
//! exposés : l'état/synchronisation Data Dragon, les listes champions/objets/
//! runes, la fiche champion, l'intégration Riot API (V0.5) et la méta OP.GG
//! (V0.6). Toute erreur est convertie en message lisible ; aucune donnée
//! inventée, aucune clé exposée.

use std::path::PathBuf;

use futures::StreamExt;
use tauri::Manager;

use crate::cache::{self, Cache, CacheMeta, CHAMPION_FILE, ITEM_FILE, RUNES_FILE};
use crate::ddragon::{self, DdragonClient};
use crate::error::{AppError, AppResult};
use crate::model::{
    Champion, ChampionDetail, ChampionSpell, DataStatus, Item, MetaBuild, MetaRunePages,
    MetaTierList, RiotKeyStatus, RiotMatchDetail, RiotPlatformInfo, RiotProfile, RiotProgression,
    RuneTree,
};
use crate::riot::{self, RiotClient};

/// Concurrence maximale des téléchargements d'assets (exigence : ≤ 8).
const MAX_ASSET_CONCURRENCY: usize = 8;

/// Tentatives pour un asset téléchargé pendant une synchronisation (arrière-plan).
const SYNC_ASSET_ATTEMPTS: u32 = 3;

/// Tentatives pour un asset demandé à la volée par une fiche champion.
///
/// Un seul essai : si le réseau est coupé alors que la fiche est en cache, la
/// commande doit répondre vite avec des chemins `None` plutôt que d'enchaîner
/// plusieurs timeouts. Un nouvel appel retentera.
const ON_DEMAND_ASSET_ATTEMPTS: u32 = 1;

/// Nature d'un asset, pour valider sa signature avant écriture.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AssetKind {
    Png,
    Jpeg,
}

impl AssetKind {
    /// Vérifie la signature du fichier téléchargé.
    fn matches(self, bytes: &[u8]) -> bool {
        match self {
            Self::Png => ddragon::is_png(bytes),
            Self::Jpeg => ddragon::is_jpeg(bytes),
        }
    }

    /// Nom lisible de la signature, pour les messages d'échec.
    fn label(self) -> &'static str {
        match self {
            Self::Png => "PNG",
            Self::Jpeg => "JPEG",
        }
    }
}

/// Construit un accès au cache à partir de l'AppHandle Tauri.
fn open_cache(app: &tauri::AppHandle) -> AppResult<Cache> {
    Ok(Cache::new(cache::resolve_cache_root(app)?))
}

/// Chemins utiles au module Riot : racine du cache et dossier de configuration.
fn riot_paths(app: &tauri::AppHandle) -> AppResult<(PathBuf, PathBuf)> {
    let cache_root = cache::resolve_cache_root(app)?;
    let data_dir = app
        .path()
        .data_dir()
        .map_err(|err| AppError::io("dossier de données de l'application", err))?;
    Ok((cache_root, data_dir.join("LoL BOT").join("config")))
}

/// Construit le client Riot (échoue avec un message clair sans clé API).
fn open_riot_client(app: &tauri::AppHandle) -> AppResult<RiotClient> {
    let (cache_root, config_dir) = riot_paths(app)?;
    RiotClient::new(cache_root, config_dir)
}

/// Convertit une erreur applicative en message destiné au frontend.
fn message(err: AppError) -> String {
    err.to_string()
}

/// État de la donnée en cache local (aucun réseau).
#[tauri::command]
pub fn get_data_status(app: tauri::AppHandle) -> Result<DataStatus, String> {
    let cache = open_cache(&app).map_err(message)?;
    cache::status_from_cache(&cache).map_err(message)
}

/// Télécharge/met à jour les données Data Dragon puis renvoie l'état à jour.
///
/// En cas de panne réseau, le cache valide existant est conservé et signalé en
/// mode hors ligne ; si aucun cache valide n'existe, l'erreur est remontée.
#[tauri::command]
pub async fn sync_ddragon(app: tauri::AppHandle) -> Result<DataStatus, String> {
    let cache = open_cache(&app).map_err(message)?;
    sync_ddragon_inner(&cache).await.map_err(message)
}

/// Version active requise pour les commandes de lecture.
fn require_active_version(cache: &Cache) -> AppResult<String> {
    match cache.active_version()? {
        Some(version) => Ok(version),
        None => Err(AppError::CacheAbsent(
            "aucune version Data Dragon en cache : lancez une synchronisation.".to_string(),
        )),
    }
}

/// Champions triés par nom (insensible à la casse), icônes locales résolues.
#[tauri::command]
pub fn get_champions(app: tauri::AppHandle) -> Result<Vec<Champion>, String> {
    let cache = open_cache(&app).map_err(message)?;
    champions_inner(&cache).map_err(message)
}

/// Objets réels triés par nom, avec icône locale et statistiques Riot.
#[tauri::command]
pub fn get_items(app: tauri::AppHandle) -> Result<Vec<Item>, String> {
    let cache = open_cache(&app).map_err(message)?;
    items_inner(&cache).map_err(message)
}

/// Arbres de runes dans l'ordre Data Dragon, runes aplaties par palier.
#[tauri::command]
pub fn get_rune_trees(app: tauri::AppHandle) -> Result<Vec<RuneTree>, String> {
    let cache = open_cache(&app).map_err(message)?;
    rune_trees_inner(&cache).map_err(message)
}

/// Fiche détaillée d'un champion (stats, sorts, passif, splash).
///
/// La fiche JSON et les assets sont téléchargés à la demande puis mis en cache ;
/// une fiche déjà en cache fonctionne hors ligne (les assets manquants restent
/// `None`).
#[tauri::command]
pub async fn get_champion_detail(
    app: tauri::AppHandle,
    id: String,
) -> Result<ChampionDetail, String> {
    let cache = open_cache(&app).map_err(message)?;
    champion_detail_inner(&cache, &id).await.map_err(message)
}

// ---------------------------------------------------------------------------
// Riot API (V0.5).
// ---------------------------------------------------------------------------

/// État de la clé API Riot (la clé elle-même n'est jamais renvoyée).
#[tauri::command]
pub fn get_riot_key_status(app: tauri::AppHandle) -> Result<RiotKeyStatus, String> {
    let (_cache_root, config_dir) = riot_paths(&app).map_err(message)?;
    Ok(riot::api_key_status(&config_dir))
}

/// Enregistre la clé API Riot locale (écriture atomique, clé non renvoyée).
#[tauri::command]
pub fn set_riot_api_key(app: tauri::AppHandle, key: String) -> Result<RiotKeyStatus, String> {
    let (_cache_root, config_dir) = riot_paths(&app).map_err(message)?;
    riot::set_api_key(&config_dir, &key).map_err(message)
}

/// Supprime la clé API Riot locale. Une clé d'environnement reste prioritaire.
#[tauri::command]
pub fn clear_riot_api_key(app: tauri::AppHandle) -> Result<RiotKeyStatus, String> {
    let (_cache_root, config_dir) = riot_paths(&app).map_err(message)?;
    riot::clear_api_key(&config_dir).map_err(message)
}

/// Plateformes Riot proposées à l'interface (identifiants et libellés réels).
#[tauri::command]
pub fn get_riot_platforms() -> Vec<RiotPlatformInfo> {
    riot::platforms()
}

/// Profil Riot d'un joueur : identité, classements et 10 derniers matchs.
///
/// `force_refresh` contourne le cache identité/classements/liste des matchs mais
/// passe toujours par le rate-limiter ; les détails de match frais restent en cache.
#[tauri::command]
pub async fn get_riot_profile(
    app: tauri::AppHandle,
    riot_id: String,
    platform: String,
    force_refresh: bool,
) -> Result<RiotProfile, String> {
    let client = open_riot_client(&app).map_err(message)?;
    client
        .profile(&riot_id, &platform, force_refresh)
        .await
        .map_err(message)
}

/// Détail d'un match Riot (10 participants), cache 24 h puis API.
#[tauri::command]
pub async fn get_riot_match(
    app: tauri::AppHandle,
    match_id: String,
) -> Result<RiotMatchDetail, String> {
    let client = open_riot_client(&app).map_err(message)?;
    client.match_detail(&match_id).await.map_err(message)
}

/// Progression personnelle sur les 50 derniers matchs (cache dérivé 30 min).
#[tauri::command]
pub async fn get_riot_progression(
    app: tauri::AppHandle,
    riot_id: String,
    platform: String,
    force_refresh: bool,
) -> Result<RiotProgression, String> {
    let client = open_riot_client(&app).map_err(message)?;
    client
        .progression(&riot_id, &platform, force_refresh)
        .await
        .map_err(message)
}

// ---------------------------------------------------------------------------
// Méta OP.GG (V0.6) — aucune clé, données externes mises en cache.
// ---------------------------------------------------------------------------

/// Tier list méta OP.GG pour une plateforme (cache 6 h).
#[tauri::command]
pub async fn get_meta_tier_list(
    app: tauri::AppHandle,
    platform: String,
) -> Result<MetaTierList, String> {
    let cache = open_cache(&app).map_err(message)?;
    crate::meta::tier_list(&cache, &platform)
        .await
        .map_err(message)
}

/// Build méta OP.GG d'un champion (cache 12 h).
#[tauri::command]
pub async fn get_meta_builds(
    app: tauri::AppHandle,
    champion: String,
    position: String,
    platform: String,
    tier: Option<String>,
) -> Result<MetaBuild, String> {
    let cache = open_cache(&app).map_err(message)?;
    crate::meta::builds(&cache, &champion, &position, &platform, tier.as_deref())
        .await
        .map_err(message)
}

/// Trois pages de runes réelles OP.GG (Challenger, Grandmaster, Tous niveaux).
#[tauri::command]
pub async fn get_meta_rune_pages(
    app: tauri::AppHandle,
    champion: String,
    position: String,
    platform: String,
) -> Result<MetaRunePages, String> {
    let cache = open_cache(&app).map_err(message)?;
    crate::meta::rune_pages(&cache, &champion, &position, &platform)
        .await
        .map_err(message)
}

// ---------------------------------------------------------------------------
// Implémentations testables sans AppHandle (et sans réseau pour la lecture).
// ---------------------------------------------------------------------------

fn champions_inner(cache: &Cache) -> AppResult<Vec<Champion>> {
    let version = require_active_version(cache)?;
    let bytes = cache.read_data_file(&version, CHAMPION_FILE)?;
    let bruts = ddragon::parse_champions(&bytes)?;

    let mut champions = Vec::with_capacity(bruts.len());
    for brut in bruts {
        let icon_path = ddragon::champion_icon_file(&brut)
            .filter(|image_file| cache.icon_exists(&version, image_file))
            .map(|image_file| cache.icon_path(&version, &image_file))
            .map(|path| path.to_string_lossy().into_owned());
        champions.push(ddragon::champion_from_raw(brut, icon_path));
    }

    champions.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(champions)
}

fn items_inner(cache: &Cache) -> AppResult<Vec<Item>> {
    let version = require_active_version(cache)?;
    let bytes = cache.read_data_file(&version, ITEM_FILE)?;
    ddragon::parse_items_with_icons(&bytes, |image_file| {
        let path = cache.item_icon_path(&version, image_file);
        cache
            .png_exists(&path)
            .then(|| path.to_string_lossy().into_owned())
    })
}

fn rune_trees_inner(cache: &Cache) -> AppResult<Vec<RuneTree>> {
    let version = require_active_version(cache)?;
    let bytes = cache.read_data_file(&version, RUNES_FILE)?;
    let mut arbres = ddragon::parse_rune_trees(&bytes)?;

    // Localisation officielle fr_FR fusionnée par id ; absente ou illisible → None.
    if let Ok(fr_path) = cache.localized_runes_file(&version) {
        let localisation = cache
            .read_bytes(&fr_path)
            .ok()
            .and_then(|fr_bytes| ddragon::parse_runes_localization(&fr_bytes).ok());
        if let Some(localisation) = localisation {
            ddragon::apply_rune_localization(&mut arbres, &localisation);
        }
    }

    // Chemins locaux uniquement si le PNG est réellement présent et valide.
    for arbre in &mut arbres {
        arbre.icon_path = cache.rune_icon_local_path(&version, &arbre.icon);
        for rune in &mut arbre.runes {
            rune.icon_path = cache.rune_icon_local_path(&version, &rune.icon);
        }
    }
    Ok(arbres)
}

// ---------------------------------------------------------------------------
// Synchronisation.
// ---------------------------------------------------------------------------

async fn sync_ddragon_inner(cache: &Cache) -> AppResult<DataStatus> {
    cache.ensure_root()?;
    let client = DdragonClient::new()?;

    // 1. Résolution de la version (réseau).
    let version = match client.latest_version().await {
        Ok(version) => version,
        Err(err) => return repli_hors_ligne(cache, &err),
    };

    // 2. Fichiers de données critiques : téléchargés s'ils sont absents ou invalides.
    for file in [CHAMPION_FILE, ITEM_FILE, RUNES_FILE] {
        let path = cache.data_file(&version, file)?;
        let deja_valide = cache
            .read_bytes(&path)
            .ok()
            .map(|bytes| cache::dataset_is_valid(file, &bytes))
            .unwrap_or(false);
        if deja_valide {
            continue;
        }

        let url = ddragon::data_url(&version, file);
        let bytes = match client.get_bytes(&url).await {
            Ok(bytes) => bytes,
            Err(err) => return repli_hors_ligne(cache, &err),
        };
        if !cache::dataset_is_valid(file, &bytes) {
            return Err(AppError::Parse(format!(
                "{file} téléchargé depuis Data Dragon est illisible (contenu inattendu)"
            )));
        }
        cache.write_bytes(&path, &bytes)?;
    }

    // 3. Icônes des champions (échecs non bloquants, concurrence ≤ 8).
    let champions_bytes = cache.read_data_file(&version, CHAMPION_FILE)?;
    let champions = ddragon::parse_champions(&champions_bytes)?;
    let mut cibles_champions: Vec<(PathBuf, String, AssetKind)> = Vec::new();
    for champion in &champions {
        let Some(image_file) = ddragon::champion_icon_file(champion) else {
            continue;
        };
        let path = cache.icon_path(&version, &image_file);
        if !cache.png_exists(&path) {
            cibles_champions.push((
                path,
                ddragon::champion_icon_url(&version, &image_file),
                AssetKind::Png,
            ));
        }
    }
    let nombre_icones_champions = cibles_champions.len();
    let echecs_champions =
        telecharger_assets(&client, cache, cibles_champions, SYNC_ASSET_ATTEMPTS).await;

    // 4. Icônes d'objets : tous les objets de `get_items`, noms `image.full` uniques.
    let items_bytes = cache.read_data_file(&version, ITEM_FILE)?;
    let fichiers_objets = ddragon::item_icon_files(&items_bytes)?;
    let mut cibles_objets: Vec<(PathBuf, String, AssetKind)> = Vec::new();
    for image_file in &fichiers_objets {
        let path = cache.item_icon_path(&version, image_file);
        if !cache.png_exists(&path) {
            cibles_objets.push((
                path,
                ddragon::item_icon_url(&version, image_file),
                AssetKind::Png,
            ));
        }
    }
    let echecs_objets =
        telecharger_assets(&client, cache, cibles_objets, SYNC_ASSET_ATTEMPTS).await;

    // 5. Localisation fr_FR des runes (non bloquante : warning si indisponible).
    let mut alertes_loc = Vec::new();
    let fr_path = cache.localized_runes_file(&version)?;
    let fr_valide = cache
        .read_bytes(&fr_path)
        .ok()
        .map(|bytes| ddragon::parse_runes_localization(&bytes).is_ok())
        .unwrap_or(false);
    if !fr_valide {
        let url = ddragon::localized_data_url(&version, "fr_FR", RUNES_FILE);
        match client.get_bytes(&url).await {
            Ok(bytes) => match ddragon::parse_runes_localization(&bytes) {
                Ok(_) => cache.write_bytes(&fr_path, &bytes)?,
                Err(err) => alertes_loc.push(format!(
                    "localisation fr_FR des runes illisible (contenu inattendu) : {err}"
                )),
            },
            Err(err) => {
                alertes_loc.push(format!("localisation fr_FR des runes indisponible : {err}"))
            }
        }
    }

    // 6. Icônes de runes/arbres : URL sans version (la versionnée renvoie 403).
    let runes_bytes = cache.read_data_file(&version, RUNES_FILE)?;
    let icones_runes = ddragon::rune_icon_files(&runes_bytes)?;
    let mut cibles_runes: Vec<(PathBuf, String, AssetKind)> = Vec::new();
    for icone in &icones_runes.files {
        if let Some(path) = cache.rune_icon_path(&version, icone) {
            if !cache.png_exists(&path) {
                cibles_runes.push((path, ddragon::rune_icon_url(icone), AssetKind::Png));
            }
        }
    }
    if icones_runes.rejected > 0 {
        alertes_loc.push(format!(
            "{} chemin(s) d'icône de rune refusé(s) (hors cache)",
            icones_runes.rejected
        ));
    }
    let echecs_runes = telecharger_assets(&client, cache, cibles_runes, SYNC_ASSET_ATTEMPTS).await;

    // 7. Méta écrite en dernier : la synchronisation est considérée réussie.
    let meta = CacheMeta {
        version: Some(version.clone()),
        updated_at: Some(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)),
        last_sync_error: None,
    };
    cache.write_meta(&meta)?;

    // 8. Purge des anciennes versions (au mieux, sans invalider la synchro).
    let purge_echecs = cache.purge_other_versions(&version);

    let mut alertes = Vec::new();
    if let Some(alerte) = resume_echecs(
        "icône(s) de champion",
        nombre_icones_champions,
        &echecs_champions,
    ) {
        alertes.push(alerte);
    }
    if let Some(alerte) = resume_echecs("icône(s) d'objet", fichiers_objets.len(), &echecs_objets)
    {
        alertes.push(alerte);
    }
    if let Some(alerte) = resume_echecs("icône(s) de rune", icones_runes.files.len(), &echecs_runes)
    {
        alertes.push(alerte);
    }
    alertes.extend(alertes_loc);
    alertes.extend(purge_echecs);

    let mut status = cache::status_from_cache(cache)?;
    status.offline = false;
    status.warning = if alertes.is_empty() {
        None
    } else {
        Some(alertes.join(" ; "))
    };
    Ok(status)
}

/// Résume les échecs de téléchargement d'assets en une alerte lisible.
fn resume_echecs(categorie: &str, total: usize, echecs: &[String]) -> Option<String> {
    if echecs.is_empty() {
        return None;
    }
    Some(format!(
        "{} {categorie} sur {total} n'ont pas pu être téléchargées (première erreur : {})",
        echecs.len(),
        echecs[0]
    ))
}

/// Télécharge des assets avec une concurrence bornée (≤ 8).
///
/// Renvoie les messages d'échec : un échec d'asset ne fait jamais échouer la
/// synchronisation ni la fiche champion (le chemin correspondant sera `None`).
async fn telecharger_assets(
    client: &DdragonClient,
    cache: &Cache,
    cibles: Vec<(PathBuf, String, AssetKind)>,
    attempts: u32,
) -> Vec<String> {
    let client = client.clone();
    let cache = cache.clone();

    let travaux = cibles.into_iter().map(move |(path, url, kind)| {
        let client = client.clone();
        let cache = cache.clone();
        async move {
            let bytes = client
                .get_bytes_with_attempts(&url, attempts)
                .await
                .map_err(|err| format!("{url} : {err}"))?;
            if !kind.matches(&bytes) {
                return Err(format!(
                    "{url} : contenu inattendu ({} attendu)",
                    kind.label()
                ));
            }
            cache
                .write_bytes(&path, &bytes)
                .map_err(|err| format!("{} : {err}", path.display()))?;
            Ok(())
        }
    });

    let resultats: Vec<Result<(), String>> = futures::stream::iter(travaux)
        .buffer_unordered(MAX_ASSET_CONCURRENCY)
        .collect()
        .await;

    resultats
        .into_iter()
        .filter_map(|resultat| resultat.err())
        .collect()
}

// ---------------------------------------------------------------------------
// Fiche champion détaillée.
// ---------------------------------------------------------------------------

/// Construit la fiche d'un champion : validation d'identifiant, fiche JSON en
/// cache (ou téléchargée), puis assets à la demande.
async fn champion_detail_inner(cache: &Cache, champion_id: &str) -> AppResult<ChampionDetail> {
    let version = require_active_version(cache)?;

    // 1. Validation stricte : identifiant sain ET présent dans champion.json.
    let champions_bytes = cache.read_data_file(&version, CHAMPION_FILE)?;
    let champions = ddragon::parse_champions(&champions_bytes)?;
    if !ddragon::is_valid_champion_id(champion_id) || !champions.iter().any(|c| c.id == champion_id)
    {
        return Err(AppError::InvalidId(format!(
            "champion inconnu ou identifiant invalide : « {champion_id} »"
        )));
    }

    // 2. Fiche JSON : cache local sinon téléchargement (écriture atomique).
    let detail_file = cache.champion_detail_file(&version, champion_id)?;
    let fiche_cachee = cache
        .read_bytes(&detail_file)
        .ok()
        .filter(|bytes| ddragon::parse_champion_detail(bytes, champion_id).is_ok());
    let detail_bytes = match fiche_cachee {
        Some(bytes) => bytes,
        None => {
            let client = DdragonClient::new()?;
            let url = ddragon::champion_detail_url(&version, champion_id);
            let bytes = client.get_bytes(&url).await.map_err(|err| {
                AppError::Network(format!(
                    "fiche de {champion_id} absente du cache local et réseau Data Dragon indisponible : {err}"
                ))
            })?;
            if ddragon::parse_champion_detail(&bytes, champion_id).is_err() {
                return Err(AppError::Parse(format!(
                    "fiche Data Dragon de {champion_id} illisible (contenu inattendu)"
                )));
            }
            cache.write_bytes(&detail_file, &bytes)?;
            bytes
        }
    };
    let detail = ddragon::parse_champion_detail(&detail_bytes, champion_id)?;

    // 3. Assets : splash, icônes des sorts et du passif, téléchargés à la demande.
    let client = DdragonClient::new()?;
    let splash_path = cache.splash_path(&version, champion_id);
    let fichiers_sorts: Vec<Option<String>> =
        detail.spells.iter().map(ddragon::spell_icon_file).collect();
    let fichier_passif = detail.passive.as_ref().and_then(ddragon::passive_icon_file);

    let mut cibles: Vec<(PathBuf, String, AssetKind)> = Vec::new();
    if !cache.jpeg_exists(&splash_path) {
        cibles.push((
            splash_path.clone(),
            ddragon::splash_url(champion_id),
            AssetKind::Jpeg,
        ));
    }
    for fichier in fichiers_sorts.iter().flatten() {
        let path = cache.spell_icon_path(&version, fichier);
        if !cache.png_exists(&path) {
            cibles.push((
                path,
                ddragon::spell_icon_url(&version, fichier),
                AssetKind::Png,
            ));
        }
    }
    if let Some(fichier) = &fichier_passif {
        let path = cache.passive_icon_path(&version, fichier);
        if !cache.png_exists(&path) {
            cibles.push((
                path,
                ddragon::passive_icon_url(&version, fichier),
                AssetKind::Png,
            ));
        }
    }

    // Échecs non bloquants : les chemins des assets absents resteront `None`.
    let _ = telecharger_assets(&client, cache, cibles, ON_DEMAND_ASSET_ATTEMPTS).await;

    // 4. Assemblage du contrat, uniquement depuis les fichiers réellement présents.
    let splash_local = cache
        .jpeg_exists(&splash_path)
        .then(|| splash_path.to_string_lossy().into_owned());

    let spells: Vec<ChampionSpell> = detail
        .spells
        .iter()
        .zip(fichiers_sorts.iter())
        .map(|(sort, fichier)| {
            let icon_path = match fichier {
                Some(image_file)
                    if cache.png_exists(&cache.spell_icon_path(&version, image_file)) =>
                {
                    Some(
                        cache
                            .spell_icon_path(&version, image_file)
                            .to_string_lossy()
                            .into_owned(),
                    )
                }
                _ => None,
            };
            ddragon::champion_spell_from_raw(sort, icon_path)
        })
        .collect();

    let passive = detail.passive.as_ref().map(|passif| {
        let icon_path = match &fichier_passif {
            Some(image_file)
                if cache.png_exists(&cache.passive_icon_path(&version, image_file)) =>
            {
                Some(
                    cache
                        .passive_icon_path(&version, image_file)
                        .to_string_lossy()
                        .into_owned(),
                )
            }
            _ => None,
        };
        ddragon::champion_passive_from_raw(passif, icon_path)
    });

    Ok(ChampionDetail {
        id: detail.id,
        key: detail.key,
        name: detail.name,
        title: detail.title,
        tags: detail.tags,
        blurb: detail.blurb,
        splash_path: splash_local,
        stats: ddragon::champion_stats_from_raw(&detail.stats),
        spells,
        passive,
    })
}

// ---------------------------------------------------------------------------
// Repli hors ligne.
// ---------------------------------------------------------------------------

/// Panne réseau : conserve le cache valide existant en mode hors ligne.
///
/// Si aucun cache valide n'existe, l'erreur réseau est renvoyée avec un message
/// explicite (aucune donnée n'est inventée pour masquer l'absence de cache).
fn repli_hors_ligne(cache: &Cache, erreur: &AppError) -> AppResult<DataStatus> {
    let message = erreur.to_string();
    if !cache.has_valid_dataset() {
        return Err(AppError::Network(format!(
            "réseau Data Dragon indisponible et aucun cache local valide : {message}"
        )));
    }

    let mut meta = cache.read_meta()?.unwrap_or_default();
    meta.last_sync_error = Some(message.clone());
    cache.write_meta(&meta)?;

    let mut status = cache::status_from_cache(cache)?;
    status.offline = true;
    status.warning = Some(message);
    Ok(status)
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use super::*;
    use crate::cache::test_support::temp_dir;

    const VERSION: &str = "16.21.1";

    const CHAMPIONS_JSON: &str = r#"{
        "data": {
            "Zed": {
                "id": "Zed",
                "key": "238",
                "name": "Zed",
                "title": "le Maître des ombres",
                "tags": ["Assassin"],
                "image": { "full": "Zed.png" }
            },
            "Ahri": {
                "id": "Ahri",
                "key": "103",
                "name": "Ahri",
                "title": "la Renarde à neuf queues",
                "tags": ["Mage", "Assassin"],
                "image": { "full": "Ahri.png" }
            }
        }
    }"#;

    const AATROX_CHAMPIONS_JSON: &str = r#"{
        "data": {
            "Aatrox": {
                "id": "Aatrox",
                "key": "266",
                "name": "Aatrox",
                "title": "l'Épée des Darkin",
                "tags": ["Fighter", "Tank"],
                "image": { "full": "Aatrox.png" }
            }
        }
    }"#;

    const CHAMPION_DETAIL_JSON: &str = r#"{
        "type": "champion",
        "format": "full",
        "version": "16.21.1",
        "data": {
            "Aatrox": {
                "id": "Aatrox",
                "key": "266",
                "name": "Aatrox",
                "title": "l'Épée des Darkin",
                "tags": ["Fighter", "Tank"],
                "blurb": "Autrefois, Aatrox était un héros respecté…",
                "stats": {
                    "hp": 650,
                    "hpperlevel": 114,
                    "mp": 0,
                    "mpperlevel": 0,
                    "movespeed": 345,
                    "armor": 38,
                    "armorperlevel": 4.45,
                    "spellblock": 32,
                    "spellblockperlevel": 2.05,
                    "attackrange": 175,
                    "hpregen": 3,
                    "mpregen": 0,
                    "attackdamage": 60,
                    "attackdamageperlevel": 5,
                    "attackspeed": 0.651,
                    "attackspeedperlevel": 2.5
                },
                "spells": [
                    {
                        "id": "AatroxQ",
                        "name": "Épée des Darkin",
                        "description": "<mainText>Premier coup : <physicalDamage>10/25/40/55/70</physicalDamage></mainText>",
                        "cooldownBurn": "14/12/10/8/6",
                        "costBurn": "0",
                        "costType": "Aucun coût",
                        "rangeBurn": "650",
                        "image": { "full": "AatroxQ.png" }
                    },
                    {
                        "id": "AatroxW",
                        "name": "Chaînes infernales",
                        "description": "<mainText>Inflige <magicDamage>30/40/50/60/70</magicDamage> dégâts magiques.</mainText>",
                        "cooldownBurn": "22/20/18/16/14",
                        "costBurn": "0",
                        "costType": "Aucun coût",
                        "rangeBurn": "900",
                        "image": { "full": "AatroxW.png" }
                    },
                    {
                        "id": "AatroxE",
                        "name": "Pas de l'ombre",
                        "description": "<mainText>Dash &amp; soin.</mainText>",
                        "cooldownBurn": "9/8/7/6/5",
                        "costBurn": "0",
                        "costType": "Aucun coût",
                        "rangeBurn": "250",
                        "image": { "full": "AatroxE.png" }
                    },
                    {
                        "id": "AatroxR",
                        "name": "Épée des Darkin fracassée",
                        "description": "<mainText>Transforme Aatrox.<br>Gagne de la vitesse.</mainText>",
                        "cooldownBurn": "120/100/80",
                        "costBurn": "0",
                        "costType": "Aucun coût",
                        "rangeBurn": "0",
                        "image": { "full": "AatroxR.png" }
                    }
                ],
                "passive": {
                    "name": "Posture du seigneur de guerre",
                    "description": "<mainText>Les attaques infligent <physicalDamage>5/8/11</physicalDamage> % des PV max.</mainText>",
                    "image": { "full": "Aatrox_Passive.png" }
                }
            }
        }
    }"#;

    const ITEMS_JSON: &str = r#"{
        "data": {
            "1001": {
                "name": "Bottes de vitesse",
                "plaintext": "Vitesse de déplacement",
                "description": "<mainText>+<speed>25</speed> vitesse</mainText>",
                "gold": { "total": 300 },
                "purchasable": true,
                "tags": ["Boots"],
                "maps": { "11": true },
                "image": { "full": "1001.png" },
                "stats": { "FlatMovementSpeedMod": 25, "PercentMovementSpeedMod": 0, "FlatHPPoolMod": 150.5 }
            },
            "1003": {
                "name": "Épée longue",
                "plaintext": "Dégâts",
                "description": "<mainText>+10 dégâts</mainText>",
                "gold": { "total": 350 },
                "purchasable": true,
                "tags": ["Damage"],
                "maps": { "11": true },
                "image": { "full": "1003.png" },
                "stats": { "FlatPhysicalDamageMod": 10 }
            },
            "EPIC": {
                "name": "Objet épique",
                "description": "id non numérique",
                "maps": { "11": true }
            }
        }
    }"#;

    const RUNES_JSON: &str = r#"[
        {
            "id": 8000,
            "key": "Precision",
            "name": "Precision",
            "icon": "perk-images/Styles/7201_Precision.png",
            "slots": [
                {
                    "runes": [
                        {
                            "id": 8005,
                            "key": "PressTheAttack",
                            "name": "Press the Attack",
                            "shortDesc": "Basic attacks mark the target.",
                            "icon": "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png"
                        },
                        {
                            "id": 8006,
                            "key": "PresenceOfMind",
                            "name": "Presence of Mind",
                            "shortDesc": "Takedowns restore mana.",
                            "icon": "perk-images/Styles/Precision/PresenceOfMind/PresenceOfMind.png"
                        }
                    ]
                }
            ]
        }
    ]"#;

    /// Localisation fr_FR de test : l'arbre 8000 et la rune 8005 seulement.
    /// La rune 8006 est volontairement absente pour vérifier le repli `None`.
    const RUNES_FR_JSON: &str = r#"[
        {
            "id": 8000,
            "key": "Precision",
            "name": "Précision",
            "icon": "perk-images/Styles/7201_Precision.png",
            "slots": [
                {
                    "runes": [
                        {
                            "id": 8005,
                            "key": "PressTheAttack",
                            "name": "Attaque soutenue",
                            "shortDesc": "<mainText>FR : <physicalDamage>dégâts</physicalDamage> &amp; détails</mainText>",
                            "icon": "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png"
                        }
                    ]
                }
            ]
        }
    ]"#;

    const PNG: &[u8] = b"\x89PNG\r\n\x1a\nfake";
    const JPEG: &[u8] = b"\xFF\xD8\xFF\xE0fake";

    fn preparer_cache(cache: &Cache) {
        cache.ensure_root().expect("création du cache");
        for (file, json) in [
            (CHAMPION_FILE, CHAMPIONS_JSON),
            (ITEM_FILE, ITEMS_JSON),
            (RUNES_FILE, RUNES_JSON),
        ] {
            let path = cache.data_file(VERSION, file).expect("chemin");
            cache
                .write_bytes(&path, json.as_bytes())
                .expect("écriture du jeu de données");
        }
        for image_file in ["1001.png", "1003.png"] {
            cache
                .write_bytes(&cache.item_icon_path(VERSION, image_file), PNG)
                .expect("icône d'objet");
        }
        cache
            .write_meta(&CacheMeta {
                version: Some(VERSION.to_string()),
                updated_at: Some("2026-10-30T10:00:00Z".to_string()),
                last_sync_error: None,
            })
            .expect("écriture de la méta");
    }

    #[test]
    fn champions_tries_et_icones_resolues() {
        let dir = temp_dir("commandes-champions");
        let cache = dir.cache();
        preparer_cache(&cache);

        // Seule l'icône d'Ahri existe dans le cache.
        let icone = cache.icon_path(VERSION, "Ahri.png");
        cache.write_bytes(&icone, PNG).expect("icône Ahri");

        let champions = champions_inner(&cache).expect("champions");
        assert_eq!(champions.len(), 2);
        assert_eq!(
            champions[0].name, "Ahri",
            "tri par nom insensible à la casse"
        );
        assert_eq!(champions[1].name, "Zed");

        let ahri = &champions[0];
        let chemin = ahri.icon_path.as_deref().expect("icône Ahri présente");
        assert!(chemin.ends_with("Ahri.png"));
        assert!(Path::new(chemin).is_absolute());
        assert_eq!(ahri.key, "103");

        assert_eq!(champions[1].icon_path, None, "icône absente → null");
    }

    #[test]
    fn lectures_sans_cache_renvoient_une_erreur_explicite() {
        let dir = temp_dir("commandes-sans-cache");
        let cache = dir.cache();

        let erreur = champions_inner(&cache).expect_err("cache absent");
        assert!(matches!(erreur, AppError::CacheAbsent(_)));
        assert!(items_inner(&cache).is_err());
        assert!(rune_trees_inner(&cache).is_err());
    }

    #[test]
    fn objets_avec_icones_et_stats() {
        let dir = temp_dir("commandes-items");
        let cache = dir.cache();
        preparer_cache(&cache);

        let items = items_inner(&cache).expect("objets");
        assert_eq!(items.len(), 2);

        let bottes = items
            .iter()
            .find(|item| item.id == "1001")
            .expect("Bottes de vitesse");
        assert_eq!(bottes.name, "Bottes de vitesse");
        assert_eq!(bottes.description, "+25 vitesse");
        assert!(bottes.on_summoners_rift);
        let icone = bottes.icon_path.as_deref().expect("icône d'objet présente");
        assert!(icone.ends_with("1001.png"));
        assert!(Path::new(icone).is_absolute());
        assert_eq!(bottes.stats.len(), 2, "valeurs nulles exclues");
        assert_eq!(bottes.stats[0].key, "FlatMovementSpeedMod");
        assert_eq!(bottes.stats[0].value, 25.0);
        assert_eq!(bottes.stats[1].key, "FlatHPPoolMod");
        assert_eq!(bottes.stats[1].value, 150.5);

        let epee = items
            .iter()
            .find(|item| item.id == "1003")
            .expect("Épée longue");
        assert_eq!(epee.stats.len(), 1);
        assert_eq!(epee.stats[0].key, "FlatPhysicalDamageMod");
        assert_eq!(epee.stats[0].value, 10.0);
    }

    #[test]
    fn runes_sans_localisation_gardent_les_champs_en_us() {
        let dir = temp_dir("commandes-runes-en");
        let cache = dir.cache();
        preparer_cache(&cache);

        // Aucun fichier fr_FR et aucune icône locale dans ce cache de test.
        let arbres = rune_trees_inner(&cache).expect("runes");
        assert_eq!(arbres.len(), 1);
        assert_eq!(arbres[0].runes.len(), 2);
        assert_eq!(arbres[0].name, "Precision");
        assert_eq!(arbres[0].localized_name, None);
        assert_eq!(arbres[0].icon_path, None);
        assert_eq!(arbres[0].runes[0].slot, 0);
        assert_eq!(arbres[0].runes[0].name, "Press the Attack");
        assert_eq!(
            arbres[0].runes[0].short_desc,
            "Basic attacks mark the target."
        );
        assert_eq!(arbres[0].runes[0].localized_name, None);
        assert_eq!(arbres[0].runes[0].localized_short_desc, None);
        assert_eq!(arbres[0].runes[0].localized_long_desc, None);
        assert_eq!(arbres[0].runes[0].icon_path, None);
        assert_eq!(
            arbres[0].runes[0].long_desc, "",
            "longDesc absent → chaîne vide"
        );

        // Fichier fr_FR illisible : ignoré (repli None), aucune erreur remontée.
        let fr_path = cache.localized_runes_file(VERSION).expect("chemin fr_FR");
        cache
            .write_bytes(&fr_path, b"{ pas du json")
            .expect("fr_FR corrompu");
        let arbres = rune_trees_inner(&cache).expect("runes malgré fr_FR corrompu");
        assert_eq!(arbres[0].localized_name, None);
        assert_eq!(arbres[0].runes[0].localized_name, None);
        assert_eq!(arbres[0].name, "Precision", "en_US toujours présent");
    }

    #[test]
    fn runes_localisees_fr_et_icones_resolues() {
        let dir = temp_dir("commandes-runes-fr");
        let cache = dir.cache();
        preparer_cache(&cache);

        let fr_path = cache.localized_runes_file(VERSION).expect("chemin fr_FR");
        cache
            .write_bytes(&fr_path, RUNES_FR_JSON.as_bytes())
            .expect("runes fr_FR");

        // Icône d'arbre + icône de la rune 8005 présentes ; celle de 8006 absente.
        for icone in [
            "perk-images/Styles/7201_Precision.png",
            "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png",
        ] {
            let path = cache
                .rune_icon_path(VERSION, icone)
                .expect("chemin d'icône valide");
            cache.write_bytes(&path, PNG).expect("icône de rune");
        }

        let arbres = rune_trees_inner(&cache).expect("runes");
        assert_eq!(arbres.len(), 1);
        let arbre = &arbres[0];

        // en_US conservé, fr_FR fusionné par id.
        assert_eq!(arbre.name, "Precision");
        assert_eq!(arbre.localized_name.as_deref(), Some("Précision"));
        assert_eq!(arbre.icon, "perk-images/Styles/7201_Precision.png");
        assert!(arbre
            .icon_path
            .as_deref()
            .unwrap_or_default()
            .ends_with("7201_Precision.png"));
        assert!(Path::new(arbre.icon_path.as_deref().unwrap_or_default()).is_absolute());

        let soutenue = arbre
            .runes
            .iter()
            .find(|rune| rune.id == 8005)
            .expect("rune 8005");
        assert_eq!(soutenue.name, "Press the Attack", "en_US conservé");
        assert_eq!(soutenue.localized_name.as_deref(), Some("Attaque soutenue"));
        assert_eq!(
            soutenue.localized_short_desc.as_deref(),
            Some("FR : dégâts & détails"),
            "description FR nettoyée du HTML"
        );
        assert_eq!(
            soutenue.localized_long_desc, None,
            "longDesc fr_FR absent → None"
        );
        assert_eq!(soutenue.short_desc, "Basic attacks mark the target.");
        assert!(soutenue
            .icon_path
            .as_deref()
            .unwrap_or_default()
            .ends_with("PressTheAttack.png"));

        // Rune absente de la localisation : repli None, champs en_US intacts.
        let sans_fr = arbre
            .runes
            .iter()
            .find(|rune| rune.id == 8006)
            .expect("rune 8006");
        assert_eq!(sans_fr.name, "Presence of Mind");
        assert_eq!(sans_fr.short_desc, "Takedowns restore mana.");
        assert_eq!(sans_fr.localized_name, None);
        assert_eq!(sans_fr.localized_short_desc, None);
        assert_eq!(sans_fr.icon_path, None, "icône absente → null");
    }

    #[test]
    fn panne_reseau_conserve_le_cache_et_passe_hors_ligne() {
        let dir = temp_dir("commandes-repli");
        let cache = dir.cache();
        preparer_cache(&cache);

        let erreur = AppError::Network("timeout simulé (test)".to_string());
        let status = repli_hors_ligne(&cache, &erreur).expect("repli hors ligne");

        assert!(status.offline);
        assert_eq!(status.version.as_deref(), Some(VERSION));
        assert_eq!(status.updated_at.as_deref(), Some("2026-10-30T10:00:00Z"));
        assert!(
            status
                .warning
                .as_deref()
                .unwrap_or_default()
                .contains("timeout simulé"),
            "le message réseau réel doit être reporté : {:?}",
            status.warning
        );
        assert_eq!(status.counts.champions, 2);
        assert_eq!(status.counts.items, 2);
        assert_eq!(status.counts.item_icons_cached, 2);

        // L'état hors ligne doit persister pour les appels suivants.
        let meta = cache.read_meta().expect("méta").expect("méta présente");
        assert!(meta.last_sync_error.is_some());
        let relu = cache::status_from_cache(&cache).expect("statut relu");
        assert!(relu.offline);
    }

    #[test]
    fn panne_reseau_sans_cache_est_une_erreur_claire() {
        let dir = temp_dir("commandes-repli-vide");
        let cache = dir.cache();

        let erreur = AppError::Network("dns introuvable (test)".to_string());
        let resultat = repli_hors_ligne(&cache, &erreur);
        match resultat {
            Err(AppError::Network(message)) => {
                assert!(message.contains("aucun cache local valide"), "{message}");
                assert!(message.contains("dns introuvable"), "{message}");
            }
            autre => panic!("erreur réseau attendue, reçu : {autre:?}"),
        }
        assert!(cache.read_meta().expect("méta lisible").is_none());
    }

    fn preparer_fiche_aatrox(cache: &Cache) {
        preparer_cache(cache);
        // Le cache de test ne contient qu'Aatrox dans cette variante.
        let champion_path = cache.data_file(VERSION, CHAMPION_FILE).expect("chemin");
        cache
            .write_bytes(&champion_path, AATROX_CHAMPIONS_JSON.as_bytes())
            .expect("champion.json Aatrox");

        let detail_path = cache
            .champion_detail_file(VERSION, "Aatrox")
            .expect("chemin de fiche");
        cache
            .write_bytes(&detail_path, CHAMPION_DETAIL_JSON.as_bytes())
            .expect("fiche Aatrox");

        // Assets réels déjà en cache (signatures valides).
        cache
            .write_bytes(&cache.splash_path(VERSION, "Aatrox"), JPEG)
            .expect("splash Aatrox");
        for image_file in [
            "AatroxQ.png",
            "AatroxW.png",
            "AatroxE.png",
            "AatroxR.png",
            "Aatrox_Passive.png",
        ] {
            let path = if image_file == "Aatrox_Passive.png" {
                cache.passive_icon_path(VERSION, image_file)
            } else {
                cache.spell_icon_path(VERSION, image_file)
            };
            cache.write_bytes(&path, PNG).expect("icône Aatrox");
        }
    }

    #[test]
    fn fiche_champion_depuis_le_cache_et_identifiants_refuses() {
        let dir = temp_dir("commandes-fiche");
        let cache = dir.cache();
        preparer_fiche_aatrox(&cache);

        let fiche = tauri::async_runtime::block_on(champion_detail_inner(&cache, "Aatrox"))
            .expect("fiche Aatrox");

        assert_eq!(fiche.id, "Aatrox");
        assert_eq!(fiche.key, "266");
        assert_eq!(fiche.title, "l'Épée des Darkin");
        assert_eq!(fiche.tags, vec!["Fighter".to_string(), "Tank".to_string()]);
        assert!(fiche.blurb.contains("Aatrox"));

        // Stats exactes Data Dragon, spellblock exposé en magicResist.
        assert_eq!(fiche.stats.hp, 650.0);
        assert_eq!(fiche.stats.hp_per_level, 114.0);
        assert_eq!(fiche.stats.magic_resist, 32.0);
        assert_eq!(fiche.stats.magic_resist_per_level, 2.05);
        assert_eq!(fiche.stats.attack_damage, 60.0);
        assert_eq!(fiche.stats.attack_speed, 0.651);
        assert_eq!(fiche.stats.move_speed, 345.0);
        assert_eq!(fiche.stats.attack_range, 175.0);
        assert_eq!(fiche.stats.hp_regen, 3.0);
        assert_eq!(fiche.stats.mp, 0.0);

        // Splash et 4 sorts, ordre Q/W/E/R conservé.
        let splash = fiche.splash_path.as_deref().expect("splash en cache");
        assert!(splash.ends_with("Aatrox_0.jpg"));
        assert!(Path::new(splash).is_absolute());
        assert_eq!(fiche.spells.len(), 4);
        assert_eq!(fiche.spells[0].id, "AatroxQ");
        assert_eq!(fiche.spells[0].cooldown, "14/12/10/8/6");
        assert_eq!(fiche.spells[0].cost, "0");
        assert_eq!(fiche.spells[0].cost_type, "Aucun coût");
        assert_eq!(fiche.spells[0].range, "650");
        assert_eq!(fiche.spells[0].description, "Premier coup : 10/25/40/55/70");
        assert!(fiche.spells[0]
            .icon_path
            .as_deref()
            .unwrap_or_default()
            .ends_with("AatroxQ.png"));
        assert_eq!(fiche.spells[3].id, "AatroxR");
        assert_eq!(fiche.spells[3].range, "0");
        assert!(fiche.spells.iter().all(|sort| sort.icon_path.is_some()));

        // Passif présent avec icône.
        let passif = fiche.passive.as_ref().expect("passif présent");
        assert_eq!(passif.name, "Posture du seigneur de guerre");
        assert!(passif.description.contains("5/8/11"));
        assert!(passif
            .icon_path
            .as_deref()
            .unwrap_or_default()
            .ends_with("Aatrox_Passive.png"));

        // Identifiants inconnus ou tentatives de traversal : refus explicites.
        for id in ["Ahri", "", "../Aatrox", "Aatrox/../../etc", "a\\b"] {
            let resultat = tauri::async_runtime::block_on(champion_detail_inner(&cache, id));
            match resultat {
                Err(AppError::InvalidId(message)) => {
                    assert!(
                        message.contains("inconnu ou identifiant invalide"),
                        "{message}"
                    );
                }
                autre => panic!("id « {id} » aurait dû être refusé : {autre:?}"),
            }
        }
    }
}
