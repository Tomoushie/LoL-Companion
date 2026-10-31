//! Intégration Riot API (V0.5).
//!
//! Trois responsabilités, isolées du reste du backend :
//! 1. **Clé API locale** : `RIOT_API_KEY` prioritaire, sinon
//!    `%APPDATA%\LoL BOT\config\riot_api_key`. La clé n'est jamais renvoyée au
//!    frontend, jamais journalisée et n'apparaît dans aucun message d'erreur.
//! 2. **HTTP + rate-limit strict** : client reqwest (rustls, en-tête
//!    `X-Riot-Token`), limiteur persistant 100 requêtes / 120 s et
//!    20 requêtes / 1 s (fichier `<cache>/riot/rate-limits.json`).
//! 3. **Cache Riot** : sous-dossier `<cache>/riot/` uniquement (le cache Data
//!    Dragon n'est jamais touché), écritures atomiques, TTL par ressource et
//!    repli sur un cache expiré avec `warning` quand l'API est indisponible.
//!
//! Aucune donnée n'est inventée : tout ce qui est renvoyé provient de l'API Riot
//! réelle ou d'un fichier de cache réel.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::cache;
use crate::error::{AppError, AppResult};
use crate::model::{
    RiotChampionProgress, RiotKeyStatus, RiotLeagueEntry, RiotMatchDetail, RiotMatchParticipant,
    RiotMatchSummary, RiotPlatformInfo, RiotProfile, RiotProgression, RiotProgressionOverall,
    RiotRoleProgress,
};

// ---------------------------------------------------------------------------
// Constantes.
// ---------------------------------------------------------------------------

/// Variable d'environnement prioritaire pour la clé API Riot.
pub const RIOT_API_KEY_ENV: &str = "RIOT_API_KEY";

/// Variable d'environnement de test : remplace les hôtes Riot par une base HTTP
/// locale (serveur mock). Ignorée si absente ou invalide.
pub const RIOT_API_BASE_ENV: &str = "RIOT_API_BASE";

/// Nom du fichier local de clé API.
pub const API_KEY_FILE: &str = "riot_api_key";

/// Taille maximale acceptée pour une clé API.
const MAX_API_KEY_LEN: usize = 200;

/// Timeout d'une requête HTTP Riot.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Limite Riot de production : 100 requêtes / 120 s.
const RATE_LONG_LIMIT: usize = 100;
const RATE_LONG_WINDOW_MS: i64 = 120_000;

/// Limite Riot de production : 20 requêtes / 1 s.
const RATE_SHORT_LIMIT: usize = 20;
const RATE_SHORT_WINDOW_MS: i64 = 1_000;

/// Attente maximale bloquante avant de renvoyer une erreur de limite.
const MAX_RATE_WAIT_MS: u64 = 20_000;

/// Sous-dossier du cache Riot (sous la racine de cache Data Dragon).
const RIOT_CACHE_SUBDIR: &str = "riot";

const ACCOUNT_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const LEAGUE_TTL_MS: i64 = 30 * 60 * 1_000;
const MATCHLIST_TTL_MS: i64 = 30 * 60 * 1_000;
const MATCH_TTL_MS: i64 = 24 * 60 * 60 * 1_000;

/// Nombre de matchs demandés à Riot (et exposés dans le profil).
const MATCH_COUNT: usize = 10;

/// Nombre de matchs analysés pour la progression personnelle.
const PROGRESSION_MATCH_COUNT: usize = 50;

/// TTL du cache dérivé de progression (30 min).
const PROGRESSION_TTL_MS: i64 = 30 * 60 * 1_000;

/// Files de classement exposées (les autres queues sont ignorées).
const RANKED_QUEUES: [&str; 2] = ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"];

// ---------------------------------------------------------------------------
// Plateformes et routing régional.
// ---------------------------------------------------------------------------

/// Définition statique d'une plateforme Riot.
struct PlatformDef {
    id: &'static str,
    label: &'static str,
    route: &'static str,
}

/// Plateformes prises en charge (identifiants et routages officiels Riot).
const PLATFORMS: [PlatformDef; 17] = [
    PlatformDef {
        id: "EUW1",
        label: "EU West",
        route: "europe",
    },
    PlatformDef {
        id: "EUNE1",
        label: "EU Nordic & East",
        route: "europe",
    },
    PlatformDef {
        id: "TR1",
        label: "Turkey",
        route: "europe",
    },
    PlatformDef {
        id: "RU",
        label: "Russia",
        route: "europe",
    },
    PlatformDef {
        id: "ME1",
        label: "Middle East",
        route: "europe",
    },
    PlatformDef {
        id: "NA1",
        label: "North America",
        route: "americas",
    },
    PlatformDef {
        id: "BR1",
        label: "Brazil",
        route: "americas",
    },
    PlatformDef {
        id: "LA1",
        label: "Latin America North",
        route: "americas",
    },
    PlatformDef {
        id: "LA2",
        label: "Latin America South",
        route: "americas",
    },
    PlatformDef {
        id: "KR",
        label: "Korea",
        route: "asia",
    },
    PlatformDef {
        id: "JP1",
        label: "Japan",
        route: "asia",
    },
    PlatformDef {
        id: "OC1",
        label: "Oceania",
        route: "sea",
    },
    PlatformDef {
        id: "PH2",
        label: "Philippines",
        route: "sea",
    },
    PlatformDef {
        id: "SG2",
        label: "Singapore",
        route: "sea",
    },
    PlatformDef {
        id: "TH2",
        label: "Thailand",
        route: "sea",
    },
    PlatformDef {
        id: "TW2",
        label: "Taiwan",
        route: "sea",
    },
    PlatformDef {
        id: "VN2",
        label: "Vietnam",
        route: "sea",
    },
];

/// Plateforme résolue (identifiant canonique, libellé, route régionale).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Platform {
    /// Identifiant canonique (`EUW1`, `NA1`, …).
    pub id: String,
    /// Libellé affichable du serveur.
    pub label: String,
    /// Route régionale Riot (`europe`, `americas`, `asia`, `sea`).
    pub route: String,
}

/// Liste des plateformes proposées à l'interface.
pub fn platforms() -> Vec<RiotPlatformInfo> {
    PLATFORMS
        .iter()
        .map(|def| RiotPlatformInfo {
            id: def.id.to_string(),
            label: def.label.to_string(),
        })
        .collect()
}

/// Résout une plateforme (validation stricte, casse normalisée).
pub fn resolve_platform(platform: &str) -> AppResult<Platform> {
    let normalized = platform.trim().to_ascii_uppercase();
    PLATFORMS
        .iter()
        .find(|def| def.id == normalized)
        .map(|def| Platform {
            id: def.id.to_string(),
            label: def.label.to_string(),
            route: def.route.to_string(),
        })
        .ok_or_else(|| {
            AppError::InvalidId(format!(
                "plateforme Riot inconnue : « {platform} » (valeurs acceptées : EUW1, EUNE1, TR1, RU, ME1, NA1, BR1, LA1, LA2, KR, JP1, OC1, PH2, SG2, TH2, TW2, VN2)."
            ))
        })
}

/// Route régionale déduite du préfixe d'un identifiant de match (`EUW1_…`).
fn route_for_match_id(match_id: &str) -> AppResult<String> {
    let prefix = match_id.split('_').next().unwrap_or_default();
    resolve_platform(prefix)
        .map(|platform| platform.route)
        .map_err(|_| {
            AppError::InvalidId(format!(
                "identifiant de match Riot invalide : « {match_id} »."
            ))
        })
}

// ---------------------------------------------------------------------------
// Riot ID.
// ---------------------------------------------------------------------------

/// Riot ID décomposé (`Nom#TAG`), casse conservée.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RiotId {
    pub game_name: String,
    pub tag_line: String,
}

/// Parse un Riot ID `Nom#TAG` (séparation au **dernier** `#`).
///
/// Les espaces de bord sont retirés, les espaces internes du nom sont conservés ;
/// les deux parties doivent être non vides et sans caractère de contrôle.
pub fn parse_riot_id(input: &str) -> AppResult<RiotId> {
    let trimmed = input.trim();
    let Some(separator) = trimmed.rfind('#') else {
        return Err(AppError::InvalidId(
            "Riot ID invalide : format attendu « Nom#TAG ».".to_string(),
        ));
    };
    let game_name = trimmed[..separator].trim();
    let tag_line = trimmed[separator + 1..].trim();

    if game_name.is_empty() || tag_line.is_empty() {
        return Err(AppError::InvalidId(
            "Riot ID invalide : le nom et le tag doivent être renseignés (« Nom#TAG »)."
                .to_string(),
        ));
    }
    if game_name.len() > 64 || tag_line.len() > 32 {
        return Err(AppError::InvalidId(
            "Riot ID invalide : nom ou tag trop long.".to_string(),
        ));
    }
    if game_name.chars().any(char::is_control) || tag_line.chars().any(char::is_control) {
        return Err(AppError::InvalidId(
            "Riot ID invalide : caractères de contrôle refusés.".to_string(),
        ));
    }

    Ok(RiotId {
        game_name: game_name.to_string(),
        tag_line: tag_line.to_string(),
    })
}

// ---------------------------------------------------------------------------
// Clé API locale.
// ---------------------------------------------------------------------------

/// Origine d'une clé API valide.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApiKeySource {
    Environment,
    Local,
}

impl ApiKeySource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Environment => "environment",
            Self::Local => "local",
        }
    }
}

/// Nettoie/valide une clé API brute. `None` si elle est inutilisable.
///
/// La valeur n'est jamais incluse dans un message d'erreur ni journalisée.
fn sanitize_api_key(raw: &str) -> Option<String> {
    let key = raw.trim();
    if key.is_empty() || key.len() > MAX_API_KEY_LEN {
        return None;
    }
    if key.chars().any(char::is_control) || key.chars().any(char::is_whitespace) {
        return None;
    }
    Some(key.to_string())
}

/// Valide une clé saisie par l'utilisateur, avec messages d'erreur non sensibles.
fn validate_api_key(raw: &str) -> AppResult<String> {
    let key = raw.trim();
    if key.is_empty() {
        return Err(AppError::Config(
            "Clé API Riot vide : renseignez une clé valide.".to_string(),
        ));
    }
    if key.len() > MAX_API_KEY_LEN {
        return Err(AppError::Config(format!(
            "Clé API Riot trop longue ({} caractères, maximum {MAX_API_KEY_LEN}).",
            key.len()
        )));
    }
    if key.chars().any(char::is_control) || key.chars().any(char::is_whitespace) {
        return Err(AppError::Config(
            "Clé API Riot invalide : espaces ou caractères de contrôle refusés.".to_string(),
        ));
    }
    Ok(key.to_string())
}

/// Chemin du fichier local de clé API (`<config>/riot_api_key`).
pub fn api_key_file(config_dir: &Path) -> PathBuf {
    config_dir.join(API_KEY_FILE)
}

/// Lit la clé locale si le fichier existe et est valide.
fn read_api_key_file(config_dir: &Path) -> Option<String> {
    std::fs::read_to_string(api_key_file(config_dir))
        .ok()
        .and_then(|contenu| sanitize_api_key(&contenu))
}

/// Résout la clé active : environnement prioritaire, sinon fichier local.
///
/// `env` est injectable pour les tests (aucune variable globale modifiée).
fn resolve_api_key_with(config_dir: &Path, env: Option<&str>) -> Option<(String, ApiKeySource)> {
    if let Some(raw) = env {
        if let Some(key) = sanitize_api_key(raw) {
            return Some((key, ApiKeySource::Environment));
        }
    }
    read_api_key_file(config_dir).map(|key| (key, ApiKeySource::Local))
}

/// Résout la clé active depuis l'environnement ou le fichier local.
pub fn resolve_api_key(config_dir: &Path) -> Option<(String, ApiKeySource)> {
    let env = std::env::var(RIOT_API_KEY_ENV).ok();
    resolve_api_key_with(config_dir, env.as_deref())
}

/// État de la clé API (sans jamais exposer la clé elle-même).
pub fn api_key_status(config_dir: &Path) -> RiotKeyStatus {
    match resolve_api_key(config_dir) {
        Some((_key, source)) => RiotKeyStatus {
            configured: true,
            source: Some(source.as_str().to_string()),
        },
        None => RiotKeyStatus {
            configured: false,
            source: None,
        },
    }
}

/// Enregistre la clé API locale (écriture atomique) et renvoie l'état à jour.
///
/// L'environnement reste prioritaire : si `RIOT_API_KEY` est valide, le statut
/// renvoyé indique `environment` même après un enregistrement local.
pub fn set_api_key(config_dir: &Path, raw: &str) -> AppResult<RiotKeyStatus> {
    let key = validate_api_key(raw)?;
    std::fs::create_dir_all(config_dir)
        .map_err(|err| AppError::io("création du dossier de configuration", err))?;
    cache::write_bytes_atomic(&api_key_file(config_dir), key.as_bytes())?;
    Ok(api_key_status(config_dir))
}

/// Supprime la clé API locale. Une clé d'environnement reste active.
pub fn clear_api_key(config_dir: &Path) -> AppResult<RiotKeyStatus> {
    match std::fs::remove_file(api_key_file(config_dir)) {
        Ok(()) => {}
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {}
        Err(err) => {
            return Err(AppError::io(
                &format!("suppression de {}", api_key_file(config_dir).display()),
                err,
            ))
        }
    }
    Ok(api_key_status(config_dir))
}

/// Erreur claire quand aucune clé n'est configurée.
fn missing_api_key_error() -> AppError {
    AppError::Config(
        "Clé API Riot absente : configurez votre clé dans les paramètres (variable RIOT_API_KEY ou fichier local)."
            .to_string(),
    )
}

// ---------------------------------------------------------------------------
// Horloge injectable.
// ---------------------------------------------------------------------------

/// Horloge utilisée par le limiteur et le cache (injectable en test).
#[derive(Debug, Clone, Default)]
struct Clock {
    manual_ms: Option<Arc<AtomicI64>>,
}

impl Clock {
    fn system() -> Self {
        Self::default()
    }

    #[cfg(test)]
    fn manual(initial_ms: i64) -> (Self, Arc<AtomicI64>) {
        let valeur = Arc::new(AtomicI64::new(initial_ms));
        (
            Self {
                manual_ms: Some(Arc::clone(&valeur)),
            },
            valeur,
        )
    }

    fn now_ms(&self) -> i64 {
        match &self.manual_ms {
            Some(valeur) => valeur.load(Ordering::Relaxed),
            None => chrono::Utc::now().timestamp_millis(),
        }
    }
}

// ---------------------------------------------------------------------------
// Rate-limiter persistant.
// ---------------------------------------------------------------------------

/// État persistant du limiteur.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LimiterState {
    /// Timestamps (ms) des requêtes de la fenêtre longue (120 s).
    #[serde(default)]
    long: Vec<i64>,
    /// Timestamps (ms) des requêtes de la fenêtre courte (1 s).
    #[serde(default)]
    short: Vec<i64>,
    /// Fin d'un cooldown imposé par un HTTP 429 (ms epoch), si encore actif.
    #[serde(default)]
    retry_after_until_ms: Option<i64>,
}

/// Décision du limiteur pour un instant donné.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Reservation {
    /// Requête autorisée (comptabilisée).
    Allowed,
    /// Attente courte nécessaire avant de pouvoir réessayer.
    Wait(u64),
    /// Attente trop longue : erreur immédiate avec le délai en secondes.
    Exceeded(u64),
}

/// Limiteur de débit Riot, threadsafe et persistant.
struct RateLimiter {
    state: Mutex<LimiterState>,
    path: PathBuf,
    clock: Clock,
}

impl RateLimiter {
    fn new(path: PathBuf) -> Self {
        Self::with_clock(path, Clock::system())
    }

    fn with_clock(path: PathBuf, clock: Clock) -> Self {
        let state = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<LimiterState>(&bytes).ok())
            .unwrap_or_default();
        Self {
            state: Mutex::new(state),
            path,
            clock,
        }
    }

    /// Verrouille l'état sans jamais paniquer (mutex empoisonné toléré).
    fn lock_state(&self) -> std::sync::MutexGuard<'_, LimiterState> {
        self.state
            .lock()
            .unwrap_or_else(|empoisonne| empoisonne.into_inner())
    }

    /// Persiste l'état de façon atomique (au mieux : une erreur disque ne doit
    /// pas bloquer les appels API, la limite reste appliquée en mémoire).
    fn persist(&self, state: &LimiterState) {
        if let Ok(bytes) = serde_json::to_vec(state) {
            let _ = cache::write_bytes_atomic(&self.path, &bytes);
        }
    }

    /// Tente de réserver une requête à l'instant `now_ms`.
    fn reserve_at(&self, now_ms: i64) -> Reservation {
        let mut guard = self.lock_state();

        // Cooldown imposé par un HTTP 429.
        if let Some(until) = guard.retry_after_until_ms {
            if now_ms < until {
                let restant = (until - now_ms).max(1) as u64;
                return if restant <= MAX_RATE_WAIT_MS {
                    Reservation::Wait(restant)
                } else {
                    Reservation::Exceeded(restant.div_ceil(1_000))
                };
            }
            guard.retry_after_until_ms = None;
        }

        guard.long.retain(|t| now_ms - *t < RATE_LONG_WINDOW_MS);
        guard.short.retain(|t| now_ms - *t < RATE_SHORT_WINDOW_MS);

        if guard.short.len() >= RATE_SHORT_LIMIT {
            let plus_ancien = *guard.short.first().unwrap_or(&now_ms);
            let attente = (plus_ancien + RATE_SHORT_WINDOW_MS - now_ms).max(1) as u64;
            return if attente <= MAX_RATE_WAIT_MS {
                Reservation::Wait(attente)
            } else {
                Reservation::Exceeded(attente.div_ceil(1_000))
            };
        }

        if guard.long.len() >= RATE_LONG_LIMIT {
            let plus_ancien = *guard.long.first().unwrap_or(&now_ms);
            let attente = (plus_ancien + RATE_LONG_WINDOW_MS - now_ms).max(1) as u64;
            return if attente <= MAX_RATE_WAIT_MS {
                Reservation::Wait(attente)
            } else {
                Reservation::Exceeded(attente.div_ceil(1_000))
            };
        }

        guard.short.push(now_ms);
        guard.long.push(now_ms);
        let snapshot = guard.clone();
        drop(guard);
        self.persist(&snapshot);
        Reservation::Allowed
    }

    /// Réserve une requête, en attendant si le délai est raisonnable (≤ 20 s).
    async fn acquire(&self) -> AppResult<()> {
        loop {
            match self.reserve_at(self.clock.now_ms()) {
                Reservation::Allowed => return Ok(()),
                Reservation::Wait(millisecondes) => {
                    tokio::time::sleep(Duration::from_millis(millisecondes.max(1))).await;
                }
                Reservation::Exceeded(secondes) => {
                    return Err(AppError::Riot(format!(
                        "Limite Riot atteinte (100 requêtes / 2 min) — réessayez dans {secondes} s."
                    )))
                }
            }
        }
    }

    /// Enregistre un cooldown `Retry-After` après un HTTP 429.
    fn register_retry_after(&self, secondes: u64) {
        let secondes = secondes.max(1);
        let maintenant = self.clock.now_ms();
        let mut guard = self.lock_state();
        guard.retry_after_until_ms = Some(maintenant.saturating_add((secondes as i64) * 1_000));
        let snapshot = guard.clone();
        drop(guard);
        self.persist(&snapshot);
    }
}

/// Registre des limiteurs partagés (un par racine de cache).
fn shared_rate_limiter(path: PathBuf) -> Arc<RateLimiter> {
    static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Arc<RateLimiter>>>> = OnceLock::new();
    let registry = REGISTRY.get_or_init(|| Mutex::new(HashMap::new()));
    let mut guard = registry
        .lock()
        .unwrap_or_else(|empoisonne| empoisonne.into_inner());
    Arc::clone(
        guard
            .entry(path.clone())
            .or_insert_with(|| Arc::new(RateLimiter::new(path))),
    )
}

// ---------------------------------------------------------------------------
// Cache Riot isolé.
// ---------------------------------------------------------------------------

/// Entrée de cache : horodatage (ms epoch) + données réelles.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEntry<T> {
    fetched_at_ms: i64,
    data: T,
}

fn riot_cache_root(cache_root: &Path) -> PathBuf {
    cache_root.join(RIOT_CACHE_SUBDIR)
}

/// Encode un composant de chemin de façon injective et sûre sur disque.
fn encode_path_component(value: &str) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut sortie = String::with_capacity(value.len());
    for &byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                sortie.push(byte as char);
            }
            _ => {
                sortie.push('%');
                sortie.push(HEX[(byte >> 4) as usize] as char);
                sortie.push(HEX[(byte & 0x0F) as usize] as char);
            }
        }
    }
    sortie
}

fn account_cache_path(cache_root: &Path, route: &str, id: &RiotId) -> PathBuf {
    riot_cache_root(cache_root)
        .join("account")
        .join(route)
        .join(format!(
            "{}_{}.json",
            encode_path_component(&id.game_name),
            encode_path_component(&id.tag_line)
        ))
}

fn league_cache_path(cache_root: &Path, platform: &str, puuid: &str) -> PathBuf {
    riot_cache_root(cache_root)
        .join("league")
        .join(platform.to_ascii_lowercase())
        .join(format!("{}.json", encode_path_component(puuid)))
}

fn matchlist_cache_path(cache_root: &Path, route: &str, puuid: &str, count: usize) -> PathBuf {
    riot_cache_root(cache_root)
        .join("matches")
        .join(route)
        .join(format!("{}-{count}.json", encode_path_component(puuid)))
}

/// Cache dérivé de la progression (une entrée par plateforme et PUUID).
fn progression_cache_path(cache_root: &Path, platform: &str, puuid: &str) -> PathBuf {
    riot_cache_root(cache_root)
        .join("progression")
        .join(platform.to_ascii_uppercase())
        .join(format!("{}.json", encode_path_component(puuid)))
}

fn match_cache_path(cache_root: &Path, match_id: &str) -> PathBuf {
    riot_cache_root(cache_root)
        .join("match")
        .join(format!("{}.json", encode_path_component(match_id)))
}

fn rate_limits_path(cache_root: &Path) -> PathBuf {
    riot_cache_root(cache_root).join("rate-limits.json")
}

fn read_cache_entry<T: DeserializeOwned>(path: &Path) -> Option<CacheEntry<T>> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_cache_entry<T: Serialize>(path: &Path, entry: &CacheEntry<T>) -> AppResult<()> {
    let bytes =
        serde_json::to_vec(entry).map_err(|err| AppError::parse("encodage du cache Riot", err))?;
    cache::write_bytes_atomic(path, &bytes)
}

fn entry_is_fresh(fetched_at_ms: i64, ttl_ms: i64, now_ms: i64) -> bool {
    fetched_at_ms >= now_ms || now_ms.saturating_sub(fetched_at_ms) <= ttl_ms
}

/// Convertit un timestamp ms en RFC 3339 UTC (ou « date inconnue »).
fn rfc3339_from_ms(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| "date inconnue".to_string())
}

/// Résultat d'un chargement cache/API avec éventuel repli.
struct Cached<T> {
    data: T,
    /// Vrai si un appel réseau a réellement été effectué.
    network: bool,
    /// Message réel (repli sur cache expiré, écriture de cache impossible…).
    warning: Option<String>,
}

// ---------------------------------------------------------------------------
// DTO Riot (parsing défensif : tous les champs sont optionnels côté JSON).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct AccountDto {
    #[serde(default)]
    puuid: String,
    #[serde(default, rename = "gameName")]
    game_name: String,
    #[serde(default, rename = "tagLine")]
    tag_line: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LeagueEntryDto {
    #[serde(default, rename = "queueType")]
    queue_type: String,
    #[serde(default)]
    tier: String,
    #[serde(default)]
    rank: String,
    #[serde(default, rename = "leaguePoints")]
    league_points: u32,
    #[serde(default)]
    wins: u32,
    #[serde(default)]
    losses: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ParticipantDto {
    #[serde(default)]
    puuid: String,
    #[serde(default, rename = "riotIdGameName")]
    riot_id_game_name: String,
    #[serde(default, rename = "riotIdTagline")]
    riot_id_tagline: String,
    #[serde(default, rename = "summonerName")]
    summoner_name: String,
    #[serde(default, rename = "championName")]
    champion_name: String,
    #[serde(default, rename = "teamId")]
    team_id: u32,
    #[serde(default)]
    kills: u32,
    #[serde(default)]
    deaths: u32,
    #[serde(default)]
    assists: u32,
    #[serde(default, rename = "totalMinionsKilled")]
    total_minions_killed: u32,
    #[serde(default, rename = "neutralMinionsKilled")]
    neutral_minions_killed: u32,
    #[serde(default, rename = "visionScore")]
    vision_score: u32,
    #[serde(default, rename = "teamPosition")]
    team_position: String,
    #[serde(default, rename = "individualPosition")]
    individual_position: String,
    #[serde(default)]
    win: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TeamDto {
    #[serde(default, rename = "teamId")]
    team_id: u32,
    #[serde(default)]
    win: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MatchMetadataDto {
    #[serde(default, rename = "matchId")]
    match_id: String,
    #[serde(default)]
    participants: Vec<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MatchInfoDto {
    #[serde(default, rename = "gameDuration")]
    game_duration: u32,
    #[serde(default, rename = "gameMode")]
    game_mode: String,
    #[serde(default, rename = "queueId")]
    queue_id: u32,
    #[serde(default, rename = "gameCreation")]
    game_creation: i64,
    #[serde(default)]
    participants: Vec<ParticipantDto>,
    #[serde(default)]
    teams: Vec<TeamDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct MatchDto {
    #[serde(default)]
    metadata: MatchMetadataDto,
    #[serde(default)]
    info: MatchInfoDto,
}

fn participant_display_name(participant: &ParticipantDto) -> String {
    let nom = participant.riot_id_game_name.trim();
    let tag = participant.riot_id_tagline.trim();
    if !nom.is_empty() && !tag.is_empty() {
        format!("{nom}#{tag}")
    } else if !nom.is_empty() {
        nom.to_string()
    } else {
        participant.summoner_name.trim().to_string()
    }
}

fn participant_position(participant: &ParticipantDto) -> String {
    let position = participant.team_position.trim();
    if position.is_empty() {
        participant.individual_position.trim().to_string()
    } else {
        position.to_string()
    }
}

fn participant_cs(participant: &ParticipantDto) -> u32 {
    participant
        .total_minions_killed
        .saturating_add(participant.neutral_minions_killed)
}

fn match_participant_from_dto(participant: &ParticipantDto) -> RiotMatchParticipant {
    RiotMatchParticipant {
        puuid: participant.puuid.clone(),
        display_name: participant_display_name(participant),
        champion_name: participant.champion_name.clone(),
        team_id: participant.team_id,
        kills: participant.kills,
        deaths: participant.deaths,
        assists: participant.assists,
        cs: participant_cs(participant),
        vision_score: participant.vision_score,
        position: participant_position(participant),
        win: participant.win,
    }
}

fn match_detail_from_dto(
    dto: &MatchDto,
    match_id_demande: &str,
    fetched_at_ms: i64,
    from_cache: bool,
) -> RiotMatchDetail {
    let match_id = if dto.metadata.match_id.trim().is_empty() {
        match_id_demande.to_string()
    } else {
        dto.metadata.match_id.clone()
    };
    let winning_team = dto
        .info
        .teams
        .iter()
        .find(|team| team.win)
        .map(|team| team.team_id);
    RiotMatchDetail {
        match_id,
        game_duration_secs: dto.info.game_duration,
        game_mode: dto.info.game_mode.clone(),
        queue_id: dto.info.queue_id,
        game_creation_ms: dto.info.game_creation,
        winning_team,
        participants: dto
            .info
            .participants
            .iter()
            .map(match_participant_from_dto)
            .collect(),
        fetched_at: rfc3339_from_ms(fetched_at_ms),
        from_cache,
    }
}

fn match_summary_from_dto(dto: &MatchDto, puuid: &str) -> Option<RiotMatchSummary> {
    let participant = dto
        .info
        .participants
        .iter()
        .find(|participant| participant.puuid == puuid)?;
    Some(RiotMatchSummary {
        match_id: dto.metadata.match_id.clone(),
        champion_name: participant.champion_name.clone(),
        kills: participant.kills,
        deaths: participant.deaths,
        assists: participant.assists,
        cs: participant_cs(participant),
        vision_score: participant.vision_score,
        duration_secs: dto.info.game_duration,
        win: participant.win,
        queue_id: dto.info.queue_id,
        game_creation_ms: dto.info.game_creation,
        position: participant_position(participant),
    })
}

fn league_entries_from_dto(entries: Vec<LeagueEntryDto>) -> Vec<RiotLeagueEntry> {
    entries
        .into_iter()
        .filter(|entry| RANKED_QUEUES.contains(&entry.queue_type.as_str()))
        .filter(|entry| !entry.tier.trim().is_empty() && !entry.rank.trim().is_empty())
        .map(|entry| RiotLeagueEntry {
            queue_type: entry.queue_type,
            tier: entry.tier,
            rank: entry.rank,
            league_points: entry.league_points,
            wins: entry.wins,
            losses: entry.losses,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Progression personnelle (50 derniers matchs).
// ---------------------------------------------------------------------------

/// Accumulateur d'agrégats (par joueur, par champion ou par rôle).
#[derive(Debug, Clone, Default)]
struct ProgressAcc {
    games: u32,
    wins: u32,
    kills: u64,
    deaths: u64,
    assists: u64,
    cs: u64,
    vision: u64,
}

impl ProgressAcc {
    fn add(&mut self, resume: &RiotMatchSummary) {
        self.games += 1;
        if resume.win {
            self.wins += 1;
        }
        self.kills += u64::from(resume.kills);
        self.deaths += u64::from(resume.deaths);
        self.assists += u64::from(resume.assists);
        self.cs += u64::from(resume.cs);
        self.vision += u64::from(resume.vision_score);
    }

    fn win_rate(&self) -> f64 {
        if self.games == 0 {
            0.0
        } else {
            f64::from(self.wins) / f64::from(self.games)
        }
    }

    fn average(&self, total: u64) -> f64 {
        if self.games == 0 {
            0.0
        } else {
            total as f64 / f64::from(self.games)
        }
    }

    fn kda(&self) -> f64 {
        let participations = (self.kills + self.assists) as f64;
        if self.deaths == 0 {
            participations
        } else {
            participations / self.deaths as f64
        }
    }
}

/// Données de progression stockées en cache dérivé (sans flags de réponse).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProgressionData {
    game_name: String,
    tag_line: String,
    puuid: String,
    platform: String,
    matches_requested: u32,
    matches_analyzed: u32,
    overall: RiotProgressionOverall,
    by_champion: Vec<RiotChampionProgress>,
    by_role: Vec<RiotRoleProgress>,
    server_win_rate: f64,
    server_games: u32,
    fetched_at: String,
}

impl ProgressionData {
    fn into_model(self, from_cache: bool, warning: Option<String>) -> RiotProgression {
        RiotProgression {
            game_name: self.game_name,
            tag_line: self.tag_line,
            puuid: self.puuid,
            platform: self.platform,
            matches_requested: self.matches_requested,
            matches_analyzed: self.matches_analyzed,
            overall: self.overall,
            by_champion: self.by_champion,
            by_role: self.by_role,
            server_win_rate: self.server_win_rate,
            server_games: self.server_games,
            fetched_at: self.fetched_at,
            from_cache,
            warning,
        }
    }
}

/// Plateforme portée par un identifiant de match (`EUW1_…` → `EUW1`).
fn platform_from_match_id(match_id: &str) -> Option<String> {
    match_id
        .split('_')
        .next()
        .filter(|prefixe| !prefixe.is_empty())
        .map(|prefixe| prefixe.to_ascii_uppercase())
}

/// Agrège les résumés réels des matchs analysés (uniquement le joueur ciblé).
fn aggregate_progression(
    game_name: &str,
    tag_line: &str,
    puuid: &str,
    platform: &str,
    entries: Vec<(String, RiotMatchSummary)>,
    echecs: Vec<String>,
    fetched_at_ms: i64,
    mut alertes: Vec<String>,
) -> AppResult<(ProgressionData, Vec<String>)> {
    if entries.is_empty() {
        return Err(AppError::Riot(format!(
            "Aucun match récent n'a pu être analysé pour ce joueur ({PROGRESSION_MATCH_COUNT} match(s) demandé(s))."
        )));
    }

    let mut overall = ProgressAcc::default();
    let mut par_champion: BTreeMap<String, ProgressAcc> = BTreeMap::new();
    let mut par_role: BTreeMap<String, ProgressAcc> = BTreeMap::new();
    let mut serveur = ProgressAcc::default();

    for (match_id, resume) in &entries {
        overall.add(resume);
        par_champion
            .entry(resume.champion_name.clone())
            .or_default()
            .add(resume);
        let role = resume.position.trim().to_string();
        par_role.entry(role).or_default().add(resume);
        if platform_from_match_id(match_id).as_deref() == Some(platform) {
            serveur.add(resume);
        }
    }

    let mut by_champion: Vec<RiotChampionProgress> = par_champion
        .into_iter()
        .map(|(champion_name, acc)| RiotChampionProgress {
            champion_name,
            games: acc.games,
            wins: acc.wins,
            win_rate: acc.win_rate(),
            kills: acc.average(acc.kills),
            deaths: acc.average(acc.deaths),
            assists: acc.average(acc.assists),
            kda: acc.kda(),
            cs_per_game: acc.average(acc.cs),
            vision_per_game: acc.average(acc.vision),
        })
        .collect();
    by_champion.sort_by(|a, b| {
        b.games
            .cmp(&a.games)
            .then_with(|| b.win_rate.total_cmp(&a.win_rate))
            .then_with(|| a.champion_name.cmp(&b.champion_name))
    });

    let mut by_role: Vec<RiotRoleProgress> = par_role
        .into_iter()
        .map(|(position, acc)| RiotRoleProgress {
            position,
            games: acc.games,
            wins: acc.wins,
            win_rate: acc.win_rate(),
            kda: acc.kda(),
        })
        .collect();
    by_role.sort_by(|a, b| {
        b.games
            .cmp(&a.games)
            .then_with(|| a.position.cmp(&b.position))
    });

    if !echecs.is_empty() {
        let premiere = echecs
            .first()
            .cloned()
            .unwrap_or_else(|| "erreur inconnue".to_string());
        alertes.push(format!(
            "{} match(s) n'ont pas pu être analysés (premier échec : {premiere})",
            echecs.len()
        ));
    }

    let wins = overall.wins;
    let games = overall.games;
    let data = ProgressionData {
        game_name: game_name.to_string(),
        tag_line: tag_line.to_string(),
        puuid: puuid.to_string(),
        platform: platform.to_string(),
        matches_requested: PROGRESSION_MATCH_COUNT as u32,
        matches_analyzed: games,
        overall: RiotProgressionOverall {
            games,
            wins,
            losses: games.saturating_sub(wins),
            win_rate: overall.win_rate(),
            kills: overall.average(overall.kills),
            deaths: overall.average(overall.deaths),
            assists: overall.average(overall.assists),
            kda: overall.kda(),
            cs_per_game: overall.average(overall.cs),
            vision_per_game: overall.average(overall.vision),
        },
        by_champion,
        by_role,
        server_win_rate: serveur.win_rate(),
        server_games: serveur.games,
        fetched_at: rfc3339_from_ms(fetched_at_ms),
    };
    Ok((data, alertes))
}

// ---------------------------------------------------------------------------
// Client Riot.
// ---------------------------------------------------------------------------

/// Client Riot API : clé locale, rate-limit partagé et cache isolé.
///
/// `Debug` masque volontairement la clé API.
#[derive(Clone)]
pub struct RiotClient {
    api_key: String,
    http: reqwest::Client,
    cache_root: PathBuf,
    config_dir: PathBuf,
    limiter: Arc<RateLimiter>,
    base_override: Option<Url>,
    clock: Clock,
}

impl std::fmt::Debug for RiotClient {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RiotClient")
            .field("cache_root", &self.cache_root)
            .field("config_dir", &self.config_dir)
            .field("api_key", &"<clé masquée>")
            .finish()
    }
}

impl RiotClient {
    /// Construit un client avec la clé résolue (environnement puis fichier).
    ///
    /// Échoue avec un message clair si aucune clé n'est configurée.
    pub fn new(cache_root: impl Into<PathBuf>, config_dir: impl Into<PathBuf>) -> AppResult<Self> {
        let cache_root = cache_root.into();
        let config_dir = config_dir.into();
        let Some((api_key, _source)) = resolve_api_key(&config_dir) else {
            return Err(missing_api_key_error());
        };
        Self::assemble(cache_root, config_dir, api_key, Clock::system())
    }

    /// Construit un client avec une clé explicite (tests/e2e).
    pub fn with_api_key(
        cache_root: impl Into<PathBuf>,
        config_dir: impl Into<PathBuf>,
        api_key: impl Into<String>,
    ) -> AppResult<Self> {
        let api_key = validate_api_key(&api_key.into())?;
        Self::assemble(
            cache_root.into(),
            config_dir.into(),
            api_key,
            Clock::system(),
        )
    }

    fn assemble(
        cache_root: PathBuf,
        config_dir: PathBuf,
        api_key: String,
        clock: Clock,
    ) -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent(concat!(
                "LoL BOT/",
                env!("CARGO_PKG_VERSION"),
                " (application locale, intégration Riot API)"
            ))
            .build()
            .map_err(|err| AppError::network("création du client HTTP Riot", err))?;

        let base_override = std::env::var(RIOT_API_BASE_ENV)
            .ok()
            .and_then(|valeur| Url::parse(valeur.trim()).ok())
            .filter(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some());

        let limiter = shared_rate_limiter(rate_limits_path(&cache_root));
        Ok(Self {
            api_key,
            http,
            cache_root,
            config_dir,
            limiter,
            base_override,
            clock,
        })
    }

    /// Racine du cache Riot (diagnostic/tests).
    pub fn cache_root(&self) -> &Path {
        &self.cache_root
    }

    /// Dossier de configuration local (clé API).
    pub fn config_dir(&self) -> &Path {
        &self.config_dir
    }

    // -- Construction d'URLs ------------------------------------------------

    fn endpoint(&self, host: &str, path: &str) -> AppResult<Url> {
        let mut url = Url::parse(&format!("https://{host}{path}"))
            .map_err(|err| AppError::Config(format!("URL Riot invalide : {err}")))?;
        if let Some(base) = &self.base_override {
            if let Some(hote) = base.host_str() {
                let _ = url.set_scheme(base.scheme());
                let _ = url.set_host(Some(hote));
                let _ = url.set_port(base.port());
            }
        }
        Ok(url)
    }

    fn account_url(&self, route: &str, id: &RiotId) -> AppResult<Url> {
        let host = format!("{route}.api.riotgames.com");
        let mut url = self.endpoint(&host, "/riot/account/v1/accounts/by-riot-id")?;
        url.path_segments_mut()
            .map_err(|_| AppError::Config("URL account Riot invalide.".to_string()))?
            .push(&id.game_name)
            .push(&id.tag_line);
        Ok(url)
    }

    fn league_url(&self, platform: &str, puuid: &str) -> AppResult<Url> {
        let host = format!("{platform}.api.riotgames.com");
        let mut url = self.endpoint(&host, "/lol/league/v4/entries/by-puuid")?;
        url.path_segments_mut()
            .map_err(|_| AppError::Config("URL league Riot invalide.".to_string()))?
            .push(puuid);
        Ok(url)
    }

    fn matchlist_url(&self, route: &str, puuid: &str, count: usize) -> AppResult<Url> {
        let host = format!("{route}.api.riotgames.com");
        let mut url = self.endpoint(&host, "/lol/match/v5/matches/by-puuid")?;
        url.path_segments_mut()
            .map_err(|_| AppError::Config("URL matchlist Riot invalide.".to_string()))?
            .push(puuid)
            .push("ids");
        url.query_pairs_mut()
            .append_pair("start", "0")
            .append_pair("count", &count.to_string());
        Ok(url)
    }

    fn match_url(&self, route: &str, match_id: &str) -> AppResult<Url> {
        let host = format!("{route}.api.riotgames.com");
        let mut url = self.endpoint(&host, "/lol/match/v5/matches")?;
        url.path_segments_mut()
            .map_err(|_| AppError::Config("URL match Riot invalide.".to_string()))?
            .push(match_id);
        Ok(url)
    }

    // -- HTTP ---------------------------------------------------------------

    async fn get_json<T: DeserializeOwned>(&self, url: Url, introuvable: &str) -> AppResult<T> {
        self.limiter.acquire().await?;
        let response = self
            .http
            .get(url)
            .header("X-Riot-Token", &self.api_key)
            .send()
            .await
            .map_err(|err| AppError::Network(format!("requête Riot impossible : {err}")))?;

        let status = response.status();
        if status.is_success() {
            let bytes = response.bytes().await.map_err(|err| {
                AppError::Network(format!("lecture de la réponse Riot impossible : {err}"))
            })?;
            return serde_json::from_slice(&bytes)
                .map_err(|err| AppError::parse("réponse Riot illisible", err));
        }

        let retry_after = retry_after_secs(response.headers());
        if status.as_u16() == 429 {
            self.limiter
                .register_retry_after(retry_after.unwrap_or(1).max(1));
        }
        Err(http_error(status.as_u16(), introuvable, retry_after))
    }

    // -- Chargements avec cache (repli sur cache expiré) --------------------

    async fn fetch_with_cache<T, F, Fut>(
        &self,
        path: PathBuf,
        ttl_ms: i64,
        force_refresh: bool,
        fetch: F,
    ) -> AppResult<Cached<T>>
    where
        T: Clone + Serialize + DeserializeOwned,
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = AppResult<T>>,
    {
        let maintenant = self.clock.now_ms();
        let cached = read_cache_entry::<T>(&path);
        if !force_refresh {
            if let Some(entry) = &cached {
                if entry_is_fresh(entry.fetched_at_ms, ttl_ms, maintenant) {
                    return Ok(Cached {
                        data: entry.data.clone(),
                        network: false,
                        warning: None,
                    });
                }
            }
        }

        match fetch().await {
            Ok(data) => {
                let entry = CacheEntry {
                    fetched_at_ms: maintenant,
                    data: data.clone(),
                };
                let mut warning = None;
                if let Err(err) = write_cache_entry(&path, &entry) {
                    warning = Some(format!(
                        "cache Riot non enregistré ({}) : {err}",
                        path.display()
                    ));
                }
                Ok(Cached {
                    data,
                    network: true,
                    warning,
                })
            }
            Err(err) => match cached {
                Some(entry) => Ok(Cached {
                    data: entry.data,
                    network: true,
                    warning: Some(format!(
                        "API Riot indisponible, données en cache datant de {} — {err}",
                        rfc3339_from_ms(entry.fetched_at_ms)
                    )),
                }),
                None => Err(err),
            },
        }
    }

    async fn fetch_account(&self, route: &str, id: &RiotId) -> AppResult<AccountDto> {
        let url = self.account_url(route, id)?;
        self.get_json::<AccountDto>(url, "Joueur introuvable (Riot ID inconnu).")
            .await
    }

    /// Compte Riot depuis le cache (TTL 24 h) ou l'API, avec repli cache.
    async fn load_account(
        &self,
        route: &str,
        id: &RiotId,
        force_refresh: bool,
    ) -> AppResult<Cached<AccountDto>> {
        let path = account_cache_path(&self.cache_root, route, id);
        self.fetch_with_cache(path, ACCOUNT_TTL_MS, force_refresh, || {
            self.fetch_account(route, id)
        })
        .await
    }

    async fn fetch_league(&self, platform: &str, puuid: &str) -> AppResult<Vec<LeagueEntryDto>> {
        let url = self.league_url(platform, puuid)?;
        self.get_json::<Vec<LeagueEntryDto>>(url, "Joueur introuvable.")
            .await
    }

    async fn fetch_matchlist(
        &self,
        route: &str,
        puuid: &str,
        count: usize,
    ) -> AppResult<Vec<String>> {
        let url = self.matchlist_url(route, puuid, count)?;
        self.get_json::<Vec<String>>(url, "Joueur introuvable.")
            .await
    }

    async fn fetch_match(&self, route: &str, match_id: &str) -> AppResult<MatchDto> {
        let url = self.match_url(route, match_id)?;
        self.get_json::<MatchDto>(url, "Match introuvable.").await
    }

    // -- API publique -------------------------------------------------------

    /// Profil complet d'un joueur : identité, classements et 10 derniers matchs.
    ///
    /// `force_refresh` contourne le cache de l'identité, des classements et de la
    /// liste des matchs (en passant par le limiteur) ; les détails de match déjà
    /// frais en cache ne sont jamais re-téléchargés.
    pub async fn profile(
        &self,
        riot_id: &str,
        platform: &str,
        force_refresh: bool,
    ) -> AppResult<RiotProfile> {
        let id = parse_riot_id(riot_id)?;
        let plateforme = resolve_platform(platform)?;
        let route = plateforme.route.clone();
        let maintenant = self.clock.now_ms();
        let mut reseau = false;
        let mut alertes: Vec<String> = Vec::new();

        // 1. Compte Riot (PUUID stable, TTL 24 h).
        let mut compte = self.load_account(&route, &id, force_refresh).await?;
        reseau |= compte.network;
        if let Some(warning) = compte.warning.take() {
            alertes.push(warning);
        }
        if compte.data.puuid.trim().is_empty() {
            return Err(AppError::Parse(
                "réponse Riot inattendue : PUUID absent pour ce Riot ID.".to_string(),
            ));
        }
        let puuid = compte.data.puuid;
        let game_name = if compte.data.game_name.trim().is_empty() {
            id.game_name.clone()
        } else {
            compte.data.game_name.clone()
        };
        let tag_line = if compte.data.tag_line.trim().is_empty() {
            id.tag_line.clone()
        } else {
            compte.data.tag_line.clone()
        };

        // 2. Classements (TTL 30 min) : échec non bloquant → warning réel.
        let league_path = league_cache_path(&self.cache_root, &plateforme.id, &puuid);
        let ranks = match self
            .fetch_with_cache(league_path, LEAGUE_TTL_MS, force_refresh, || {
                self.fetch_league(&plateforme.id, &puuid)
            })
            .await
        {
            Ok(cached) => {
                reseau |= cached.network;
                if let Some(warning) = cached.warning {
                    alertes.push(warning);
                }
                league_entries_from_dto(cached.data)
            }
            Err(err) => {
                alertes.push(format!("classements Riot indisponibles : {err}"));
                Vec::new()
            }
        };

        // 3. Liste des derniers matchs (TTL 30 min).
        let matchlist_path = matchlist_cache_path(&self.cache_root, &route, &puuid, MATCH_COUNT);
        let match_ids = match self
            .fetch_with_cache(matchlist_path, MATCHLIST_TTL_MS, force_refresh, || {
                self.fetch_matchlist(&route, &puuid, MATCH_COUNT)
            })
            .await
        {
            Ok(cached) => {
                reseau |= cached.network;
                if let Some(warning) = cached.warning {
                    alertes.push(warning);
                }
                cached.data
            }
            Err(err) => {
                alertes.push(format!("liste des matchs Riot indisponible : {err}"));
                Vec::new()
            }
        };
        let match_ids: Vec<String> = match_ids.into_iter().take(MATCH_COUNT).collect();
        let total_matchs = match_ids.len();

        // 4. Détails des matchs (TTL 24 h, jamais re-téléchargés si frais).
        let mut matches = Vec::with_capacity(total_matchs);
        let mut echecs = 0usize;
        let mut premiere_erreur: Option<String> = None;
        for match_id in &match_ids {
            let path = match_cache_path(&self.cache_root, match_id);
            match self
                .fetch_with_cache(path, MATCH_TTL_MS, false, || {
                    self.fetch_match(&route, match_id)
                })
                .await
            {
                Ok(cached) => {
                    reseau |= cached.network;
                    if let Some(warning) = cached.warning {
                        alertes.push(warning);
                    }
                    match match_summary_from_dto(&cached.data, &puuid) {
                        Some(resume) => matches.push(resume),
                        None => {
                            echecs += 1;
                            if premiere_erreur.is_none() {
                                premiere_erreur =
                                    Some("participant absent du match récupéré".to_string());
                            }
                        }
                    }
                }
                Err(err) => {
                    echecs += 1;
                    if premiere_erreur.is_none() {
                        premiere_erreur = Some(err.to_string());
                    }
                }
            }
        }
        if echecs > 0 {
            let detail = premiere_erreur.unwrap_or_else(|| "erreur inconnue".to_string());
            alertes.push(format!(
                "{echecs} match(s) sur {total_matchs} n'ont pas pu être récupérés (premier échec : {detail})"
            ));
        }

        Ok(RiotProfile {
            game_name,
            tag_line,
            puuid,
            platform: plateforme.id,
            ranks,
            matches,
            fetched_at: rfc3339_from_ms(maintenant),
            from_cache: !reseau,
            warning: join_warnings(alertes),
        })
    }

    /// Progression personnelle sur les 50 derniers matchs.
    ///
    /// Cache dérivé de 30 min (`<cache>/riot/progression/<plateforme>/<puuid>.json`).
    /// `force_refresh` contourne ce cache dérivé **et** la liste des 50 matchs
    /// (toujours via le rate-limiter) ; les détails de match frais en cache ne
    /// sont jamais re-téléchargés.
    pub async fn progression(
        &self,
        riot_id: &str,
        platform: &str,
        force_refresh: bool,
    ) -> AppResult<RiotProgression> {
        let id = parse_riot_id(riot_id)?;
        let plateforme = resolve_platform(platform)?;
        let route = plateforme.route.clone();
        let maintenant = self.clock.now_ms();
        let mut reseau = false;
        let mut alertes: Vec<String> = Vec::new();

        // 1. Compte Riot (cache 24 h, jamais forcé ici).
        let mut compte = self.load_account(&route, &id, false).await?;
        reseau |= compte.network;
        if let Some(warning) = compte.warning.take() {
            alertes.push(warning);
        }
        if compte.data.puuid.trim().is_empty() {
            return Err(AppError::Parse(
                "réponse Riot inattendue : PUUID absent pour ce Riot ID.".to_string(),
            ));
        }
        let puuid = compte.data.puuid;
        let game_name = if compte.data.game_name.trim().is_empty() {
            id.game_name.clone()
        } else {
            compte.data.game_name.clone()
        };
        let tag_line = if compte.data.tag_line.trim().is_empty() {
            id.tag_line.clone()
        } else {
            compte.data.tag_line.clone()
        };

        // 2. Cache dérivé (TTL 30 min) — contient les agrégats réels.
        let derive_path = progression_cache_path(&self.cache_root, &plateforme.id, &puuid);
        if !force_refresh {
            if let Some(entry) = read_cache_entry::<ProgressionData>(&derive_path) {
                if entry_is_fresh(entry.fetched_at_ms, PROGRESSION_TTL_MS, maintenant) {
                    return Ok(entry.data.into_model(!reseau, join_warnings(alertes)));
                }
            }
        }

        // 3. Liste des 50 derniers matchs (cache 30 min, contournée si forcé).
        let matchlist_path =
            matchlist_cache_path(&self.cache_root, &route, &puuid, PROGRESSION_MATCH_COUNT);
        let liste = self
            .fetch_with_cache(matchlist_path, MATCHLIST_TTL_MS, force_refresh, || {
                self.fetch_matchlist(&route, &puuid, PROGRESSION_MATCH_COUNT)
            })
            .await?;
        reseau |= liste.network;
        let liste = {
            let mut liste = liste;
            if let Some(warning) = liste.warning.take() {
                alertes.push(warning);
            }
            liste.data
        };
        let match_ids: Vec<String> = liste.into_iter().take(PROGRESSION_MATCH_COUNT).collect();

        // 4. Détails (cache 24 h, jamais re-téléchargés s'ils sont frais).
        let mut entries: Vec<(String, RiotMatchSummary)> = Vec::with_capacity(match_ids.len());
        let mut echecs: Vec<String> = Vec::new();
        for match_id in &match_ids {
            let path = match_cache_path(&self.cache_root, match_id);
            match self
                .fetch_with_cache(path, MATCH_TTL_MS, false, || {
                    self.fetch_match(&route, match_id)
                })
                .await
            {
                Ok(mut cached) => {
                    reseau |= cached.network;
                    if let Some(warning) = cached.warning.take() {
                        alertes.push(warning);
                    }
                    match match_summary_from_dto(&cached.data, &puuid) {
                        Some(resume) => entries.push((match_id.clone(), resume)),
                        None => echecs.push("participant absent du match récupéré".to_string()),
                    }
                }
                Err(err) => echecs.push(err.to_string()),
            }
        }

        // 5. Agrégation + cache dérivé.
        let (data, mut alertes) = aggregate_progression(
            &game_name,
            &tag_line,
            &puuid,
            &plateforme.id,
            entries,
            echecs,
            maintenant,
            alertes,
        )?;
        if let Err(err) = write_cache_entry(
            &derive_path,
            &CacheEntry {
                fetched_at_ms: maintenant,
                data: data.clone(),
            },
        ) {
            alertes.push(format!("cache de progression non enregistré : {err}"));
        }

        Ok(data.into_model(!reseau, join_warnings(alertes)))
    }

    /// Détail d'un match (10 participants), depuis le cache frais ou l'API.
    ///
    /// En cas d'indisponibilité de l'API, un cache expiré réel est servi (le
    /// contrat `RiotMatchDetail` n'a pas de champ `warning`).
    pub async fn match_detail(&self, match_id: &str) -> AppResult<RiotMatchDetail> {
        let match_id = validate_match_id(match_id)?;
        let route = route_for_match_id(&match_id)?;
        let maintenant = self.clock.now_ms();
        let path = match_cache_path(&self.cache_root, &match_id);
        let cached = read_cache_entry::<MatchDto>(&path);

        if let Some(entry) = &cached {
            if entry_is_fresh(entry.fetched_at_ms, MATCH_TTL_MS, maintenant) {
                return Ok(match_detail_from_dto(
                    &entry.data,
                    &match_id,
                    entry.fetched_at_ms,
                    true,
                ));
            }
        }

        match self.fetch_match(&route, &match_id).await {
            Ok(dto) => {
                let entry = CacheEntry {
                    fetched_at_ms: maintenant,
                    data: dto.clone(),
                };
                let _ = write_cache_entry(&path, &entry);
                Ok(match_detail_from_dto(&dto, &match_id, maintenant, false))
            }
            Err(err) => match cached {
                Some(entry) => Ok(match_detail_from_dto(
                    &entry.data,
                    &match_id,
                    entry.fetched_at_ms,
                    true,
                )),
                None => Err(err),
            },
        }
    }
}

/// Valide un identifiant de match Riot (`EUW1_1234567890`).
fn validate_match_id(raw: &str) -> AppResult<String> {
    let match_id = raw.trim();
    if match_id.is_empty() || match_id.len() > 128 {
        return Err(AppError::InvalidId(
            "identifiant de match Riot invalide.".to_string(),
        ));
    }
    if !match_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return Err(AppError::InvalidId(
            "identifiant de match Riot invalide (caractères refusés).".to_string(),
        ));
    }
    Ok(match_id.to_string())
}

fn retry_after_secs(headers: &reqwest::header::HeaderMap) -> Option<u64> {
    headers
        .get(reqwest::header::RETRY_AFTER)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.trim().parse::<u64>().ok())
}

fn join_warnings(alertes: Vec<String>) -> Option<String> {
    if alertes.is_empty() {
        None
    } else {
        Some(alertes.join(" ; "))
    }
}

/// Convertit un statut HTTP Riot en erreur lisible (la clé n'y figure jamais).
fn http_error(status: u16, introuvable: &str, retry_after: Option<u64>) -> AppError {
    match status {
        401 => AppError::Riot(
            "Clé API Riot invalide ou expirée (HTTP 401). Vérifiez votre clé dans les paramètres."
                .to_string(),
        ),
        403 => AppError::Riot("Accès refusé par l'API Riot (HTTP 403).".to_string()),
        404 => AppError::Riot(introuvable.to_string()),
        429 => {
            let secondes = retry_after.unwrap_or(1).max(1);
            AppError::Riot(format!(
                "Limite Riot atteinte (HTTP 429) : réessayez dans {secondes} s."
            ))
        }
        code if (500..=599).contains(&code) => AppError::Network(format!(
            "Erreur du serveur Riot (HTTP {code}) : réessayez plus tard."
        )),
        code => AppError::Network(format!("Réponse Riot inattendue (HTTP {code}).")),
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::atomic::Ordering;

    use serde_json::json;

    use super::*;
    use crate::cache::test_support::temp_dir;

    const PUUID: &str = "abcd-1234_PUUID-test";

    fn test_clock(now_ms: i64) -> (Clock, Arc<AtomicI64>) {
        Clock::manual(now_ms)
    }

    fn test_client(
        cache_root: &Path,
        config_dir: &Path,
        clock: Clock,
        base: Option<Url>,
    ) -> RiotClient {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(2))
            .build()
            .expect("client HTTP de test");
        RiotClient {
            api_key: "cle-de-test-non-sensible".to_string(),
            http,
            cache_root: cache_root.to_path_buf(),
            config_dir: config_dir.to_path_buf(),
            limiter: Arc::new(RateLimiter::with_clock(
                rate_limits_path(cache_root),
                clock.clone(),
            )),
            base_override: base,
            clock,
        }
    }

    fn unreachable_base() -> Option<Url> {
        Url::parse("http://127.0.0.1:1").ok()
    }

    // -- Plateformes / routing ---------------------------------------------

    #[test]
    fn plateformes_et_routage_regional() {
        let liste = platforms();
        assert_eq!(liste.len(), 17);
        let ids: Vec<&str> = liste.iter().map(|platform| platform.id.as_str()).collect();
        for attendu in [
            "EUW1", "EUNE1", "TR1", "RU", "ME1", "NA1", "BR1", "LA1", "LA2", "KR", "JP1", "OC1",
            "PH2", "SG2", "TH2", "TW2", "VN2",
        ] {
            assert!(ids.contains(&attendu), "plateforme manquante : {attendu}");
        }
        assert!(liste.iter().all(|platform| !platform.label.is_empty()));

        assert_eq!(resolve_platform("euw1").expect("EUW1").route, "europe");
        assert_eq!(resolve_platform("EUNE1").expect("EUNE1").route, "europe");
        assert_eq!(resolve_platform("TR1").expect("TR1").route, "europe");
        assert_eq!(resolve_platform("RU").expect("RU").route, "europe");
        assert_eq!(resolve_platform("ME1").expect("ME1").route, "europe");
        assert_eq!(resolve_platform("na1").expect("NA1").route, "americas");
        assert_eq!(resolve_platform("BR1").expect("BR1").route, "americas");
        assert_eq!(resolve_platform("LA1").expect("LA1").route, "americas");
        assert_eq!(resolve_platform("LA2").expect("LA2").route, "americas");
        assert_eq!(resolve_platform("kr").expect("KR").route, "asia");
        assert_eq!(resolve_platform("JP1").expect("JP1").route, "asia");
        for plateforme_sea in ["OC1", "PH2", "SG2", "TH2", "TW2", "VN2"] {
            assert_eq!(
                resolve_platform(plateforme_sea)
                    .expect("plateforme sea")
                    .route,
                "sea"
            );
        }

        for invalide in ["", "EUW", "EUW2", "euw 1", "../EUW1", "NA"] {
            assert!(
                matches!(resolve_platform(invalide), Err(AppError::InvalidId(_))),
                "plateforme « {invalide} » aurait dû être refusée"
            );
        }
    }

    // -- Riot ID ------------------------------------------------------------

    #[test]
    fn parsing_riot_id() {
        let simple = parse_riot_id("Test#EUW").expect("Riot ID simple");
        assert_eq!(simple.game_name, "Test");
        assert_eq!(simple.tag_line, "EUW");

        let espace = parse_riot_id("  Some Name#EUW  ").expect("espace dans le nom");
        assert_eq!(espace.game_name, "Some Name");
        assert_eq!(espace.tag_line, "EUW");

        let tag_espace = parse_riot_id("Name #TAG 1").expect("espace dans le tag");
        assert_eq!(tag_espace.game_name, "Name");
        assert_eq!(tag_espace.tag_line, "TAG 1");

        let dernier = parse_riot_id("A#B#C").expect("dernier #");
        assert_eq!(dernier.game_name, "A#B");
        assert_eq!(dernier.tag_line, "C");

        let casse = parse_riot_id("CaseSensitive#tAg").expect("casse conservée");
        assert_eq!(casse.game_name, "CaseSensitive");
        assert_eq!(casse.tag_line, "tAg");

        for invalide in ["", "SansTag", "#TAG", "Nom#", "  #  ", "Nom#   "] {
            assert!(
                matches!(parse_riot_id(invalide), Err(AppError::InvalidId(_))),
                "Riot ID « {invalide} » aurait dû être refusé"
            );
        }
    }

    // -- URLs / RIOT_API_BASE ----------------------------------------------

    #[test]
    fn urls_riot_et_override_de_base() {
        let dir = temp_dir("riot-urls");
        let config = dir.path().join("config");
        let clock = Clock::system();
        let id = parse_riot_id("Some Name#EUW").expect("Riot ID");
        let client = test_client(dir.path(), &config, clock.clone(), None);

        let account = client.account_url("europe", &id).expect("URL account");
        assert_eq!(account.scheme(), "https");
        assert_eq!(account.host_str(), Some("europe.api.riotgames.com"));
        assert!(account
            .path()
            .starts_with("/riot/account/v1/accounts/by-riot-id/"));
        assert!(
            account.path().contains("Some%20Name"),
            "nom encodé : {}",
            account.path()
        );

        let league = client.league_url("EUW1", PUUID).expect("URL league");
        // Les hôtes URLs sont normalisés en minuscules par le parseur.
        assert_eq!(league.host_str(), Some("euw1.api.riotgames.com"));
        assert!(league
            .path()
            .ends_with(&format!("/entries/by-puuid/{PUUID}")));

        let matchlist = client
            .matchlist_url("europe", PUUID, MATCH_COUNT)
            .expect("URL matchlist");
        assert_eq!(matchlist.host_str(), Some("europe.api.riotgames.com"));
        assert!(matchlist
            .path()
            .ends_with(&format!("/by-puuid/{PUUID}/ids")));
        assert!(matchlist.query().unwrap_or_default().contains("count=10"));
        assert!(matchlist.query().unwrap_or_default().contains("start=0"));

        let match_url = client.match_url("asia", "KR_42").expect("URL match");
        assert_eq!(match_url.host_str(), Some("asia.api.riotgames.com"));
        assert!(match_url.path().ends_with("/matches/KR_42"));

        // Override test-only : tous les hôtes sont remplacés.
        let base = Url::parse("http://127.0.0.1:12345").expect("base");
        let client = test_client(dir.path(), &config, clock, Some(base));
        let account = client.account_url("europe", &id).expect("URL account");
        assert_eq!(account.scheme(), "http");
        assert_eq!(account.host_str(), Some("127.0.0.1"));
        assert_eq!(account.port(), Some(12345));
        assert!(account
            .path()
            .starts_with("/riot/account/v1/accounts/by-riot-id/"));
        let matchlist = client
            .matchlist_url("europe", PUUID, MATCH_COUNT)
            .expect("URL matchlist");
        assert_eq!(matchlist.host_str(), Some("127.0.0.1"));
        assert_eq!(matchlist.port(), Some(12345));
        assert_eq!(
            matchlist.path(),
            format!("/lol/match/v5/matches/by-puuid/{PUUID}/ids")
        );
    }

    // -- Identifiants de match ----------------------------------------------

    #[test]
    fn validation_match_id_et_route() {
        assert_eq!(
            route_for_match_id("EUW1_123").expect("route EUW1"),
            "europe"
        );
        assert_eq!(
            route_for_match_id("NA1_456").expect("route NA1"),
            "americas"
        );
        assert_eq!(route_for_match_id("KR_789").expect("route KR"), "asia");
        assert_eq!(route_for_match_id("OC1_1").expect("route OC1"), "sea");

        for invalide in ["", "../x", "EUW1/../../x", "EUW1_abc;", "EUW1_1 x"] {
            assert!(
                matches!(validate_match_id(invalide), Err(AppError::InvalidId(_))),
                "match id « {invalide} » aurait dû être refusé"
            );
        }
        assert_eq!(
            validate_match_id(" EUW1_123 ").expect("id valide"),
            "EUW1_123"
        );
        assert!(route_for_match_id("ZZZ_1").is_err());
    }

    // -- Clé API locale -----------------------------------------------------

    #[test]
    fn cle_api_fichier_et_environnement() {
        let dir = temp_dir("riot-cles");
        let config = dir.path().join("config");

        assert!(!api_key_status(&config).configured);
        assert_eq!(resolve_api_key(&config), None);

        // Écriture locale.
        let statut = set_api_key(&config, "  cle-locale-de-test  ").expect("set clé");
        assert!(statut.configured);
        assert_eq!(statut.source.as_deref(), Some("local"));
        let fichier = api_key_file(&config);
        assert!(fichier.is_file());
        let contenu = std::fs::read_to_string(&fichier).expect("lecture clé");
        assert_eq!(contenu, "cle-locale-de-test", "clé trimmée");

        // L'environnement est prioritaire.
        let resolu =
            resolve_api_key_with(&config, Some(" cle-env-test ")).expect("clé d'environnement");
        assert_eq!(resolu.0, "cle-env-test");
        assert_eq!(resolu.1, ApiKeySource::Environment);
        assert_eq!(resolu.1.as_str(), "environment");

        // Clé locale invalide ou vide.
        for invalide in ["", "   ", "a\nb", "a b", &"x".repeat(MAX_API_KEY_LEN + 1)] {
            let resultat = set_api_key(&config, invalide);
            assert!(
                matches!(resultat, Err(AppError::Config(_))),
                "clé invalide acceptée : {invalide:?}"
            );
            // Le message ne doit jamais contenir la clé saisie.
            if !invalide.trim().is_empty() {
                let message = resultat.expect_err("erreur attendue").to_string();
                assert!(!message.contains(invalide.trim()));
            }
        }

        // Fichier local corrompu/invalide → ignoré.
        std::fs::write(&fichier, "a\nb").expect("écriture invalide");
        assert_eq!(resolve_api_key(&config), None);

        // Effacement.
        std::fs::write(&fichier, "cle-autre").expect("écriture clé");
        let statut = clear_api_key(&config).expect("clear");
        assert!(!statut.configured);
        assert_eq!(statut.source, None);
        assert!(!fichier.exists());

        // L'erreur « clé absente » est explicite et ne contient aucun secret.
        let message = missing_api_key_error().to_string();
        assert!(message.contains("absente"), "{message}");
        assert!(message.contains("RIOT_API_KEY"), "{message}");
    }

    // -- Rate-limiter -------------------------------------------------------

    #[test]
    fn rate_limiter_fenetre_courte_et_persistance() {
        let dir = temp_dir("riot-limiter-court");
        let path = dir.path().join("rate-limits.json");
        let (clock, temps) = test_clock(0);
        let limiter = RateLimiter::with_clock(path.clone(), clock);

        for index in 0..RATE_SHORT_LIMIT {
            assert_eq!(
                limiter.reserve_at(0),
                Reservation::Allowed,
                "requête {index} refusée"
            );
        }
        assert_eq!(limiter.reserve_at(0), Reservation::Wait(1_000));
        assert!(path.is_file(), "état du limiteur persisté");

        // Un nouveau limiteur recharge l'état persisté (survit au redémarrage).
        let (clock_recharge, _) = test_clock(0);
        let recharge = RateLimiter::with_clock(path.clone(), clock_recharge);
        assert_eq!(recharge.reserve_at(0), Reservation::Wait(1_000));

        // La fenêtre courte se libère après 1 s.
        temps.store(500, Ordering::Relaxed);
        assert_eq!(limiter.reserve_at(500), Reservation::Wait(500));
        temps.store(1_000, Ordering::Relaxed);
        assert_eq!(limiter.reserve_at(1_000), Reservation::Allowed);
    }

    #[test]
    fn rate_limiter_fenetre_longue_refus_immediat() {
        let dir = temp_dir("riot-limiter-long");
        let path = dir.path().join("rate-limits.json");
        let (clock, temps) = test_clock(0);
        let limiter = RateLimiter::with_clock(path, clock);

        let mut total = 0usize;
        for seconde in 0..5 {
            let instant = seconde * 1_000;
            temps.store(instant, Ordering::Relaxed);
            for _ in 0..RATE_SHORT_LIMIT {
                assert_eq!(limiter.reserve_at(instant), Reservation::Allowed);
                total += 1;
            }
        }
        assert_eq!(total, RATE_LONG_LIMIT);

        // 100 requêtes consommées : l'attente (115 s) dépasse le plafond de 20 s.
        temps.store(5_000, Ordering::Relaxed);
        assert_eq!(limiter.reserve_at(5_000), Reservation::Exceeded(115));

        // Après la fenêtre de 120 s, tout est de nouveau possible.
        temps.store(125_000, Ordering::Relaxed);
        assert_eq!(limiter.reserve_at(125_000), Reservation::Allowed);
    }

    #[test]
    fn rate_limiter_retry_after_429() {
        let dir = temp_dir("riot-limiter-429");
        let path = dir.path().join("rate-limits.json");
        let (clock, temps) = test_clock(0);
        let limiter = RateLimiter::with_clock(path, clock);

        limiter.register_retry_after(30);
        assert_eq!(limiter.reserve_at(0), Reservation::Exceeded(30));
        // 20 s restantes : attente autorisée (plafond inclus).
        temps.store(10_000, Ordering::Relaxed);
        assert_eq!(limiter.reserve_at(10_000), Reservation::Wait(20_000));
        temps.store(11_000, Ordering::Relaxed);
        assert_eq!(limiter.reserve_at(11_000), Reservation::Wait(19_000));
        // Cooldown terminé : la requête passe de nouveau.
        temps.store(30_000, Ordering::Relaxed);
        assert_eq!(limiter.reserve_at(30_000), Reservation::Allowed);
    }

    // -- Cache / TTL --------------------------------------------------------

    #[test]
    fn cache_ttl_atomique_et_corruption() {
        let dir = temp_dir("riot-cache");
        let id = parse_riot_id("Test#EUW").expect("Riot ID");
        let path = account_cache_path(dir.path(), "europe", &id);
        assert!(path.ends_with("riot/account/europe/Test_EUW.json"));

        let donnees = AccountDto {
            puuid: PUUID.to_string(),
            game_name: "Test".to_string(),
            tag_line: "EUW".to_string(),
        };
        write_cache_entry(
            &path,
            &CacheEntry {
                fetched_at_ms: 1_000,
                data: donnees.clone(),
            },
        )
        .expect("écriture du cache");

        let relu = read_cache_entry::<AccountDto>(&path).expect("cache relu");
        assert_eq!(relu.fetched_at_ms, 1_000);
        assert_eq!(relu.data.puuid, PUUID);

        assert!(entry_is_fresh(1_000, ACCOUNT_TTL_MS, 2_000));
        assert!(entry_is_fresh(
            1_000,
            ACCOUNT_TTL_MS,
            1_000 + ACCOUNT_TTL_MS
        ));
        assert!(!entry_is_fresh(
            1_000,
            ACCOUNT_TTL_MS,
            1_001 + ACCOUNT_TTL_MS
        ));
        // Horodatage futur (horloge reculée) : considéré frais.
        assert!(entry_is_fresh(10_000, ACCOUNT_TTL_MS, 1_000));

        // Aucun fichier temporaire résiduel.
        let mut restes = Vec::new();
        for entry in std::fs::read_dir(path.parent().expect("dossier"))
            .expect("lecture dossier")
            .flatten()
        {
            let nom = entry.file_name().to_string_lossy().into_owned();
            if nom.contains(".tmp-") {
                restes.push(nom);
            }
        }
        assert!(restes.is_empty(), "temporaires : {restes:?}");

        // Cache corrompu ignoré (re-fetch possible, aucune panique).
        std::fs::write(&path, b"{ pas du json").expect("corruption");
        assert!(read_cache_entry::<AccountDto>(&path).is_none());
    }

    #[test]
    fn chemins_de_cache_encodes_et_surs() {
        let root = Path::new("C:/cache-test");
        let id = parse_riot_id("Nom Avec Espace#EUW").expect("Riot ID");
        let account = account_cache_path(root, "europe", &id);
        assert_eq!(
            account,
            root.join("riot")
                .join("account")
                .join("europe")
                .join("Nom%20Avec%20Espace_EUW.json")
        );

        // Un PUUID ou un match id ne peut pas sortir du cache (encodage injectif).
        let league = league_cache_path(root, "EUW1", "../../evil");
        assert!(league.starts_with(root.join("riot").join("league").join("euw1")));
        assert!(league
            .file_name()
            .map(|nom| nom.to_string_lossy() == "..%2F..%2Fevil.json")
            .unwrap_or(false));

        let match_path = match_cache_path(root, "EUW1_123");
        assert_eq!(
            match_path,
            root.join("riot").join("match").join("EUW1_123.json")
        );
        assert_eq!(
            rate_limits_path(root),
            root.join("riot").join("rate-limits.json")
        );
    }

    // -- Parsing des réponses Riot -----------------------------------------

    #[test]
    fn parsing_compte_league_et_matchlist() {
        let compte: AccountDto =
            serde_json::from_slice(br#"{"puuid":"abc","gameName":"Test","tagLine":"EUW"}"#)
                .expect("compte");
        assert_eq!(compte.puuid, "abc");
        assert_eq!(compte.game_name, "Test");
        assert_eq!(compte.tag_line, "EUW");

        let entries: Vec<LeagueEntryDto> = serde_json::from_slice(
            br#"[
                {"queueType":"RANKED_SOLO_5x5","tier":"GOLD","rank":"II","leaguePoints":42,"wins":10,"losses":5},
                {"queueType":"RANKED_FLEX_SR","tier":"SILVER","rank":"IV","leaguePoints":7,"wins":3,"losses":2},
                {"queueType":"RANKED_TFT","tier":"MASTER","rank":"I","leaguePoints":99,"wins":1,"losses":0},
                {"queueType":"RANKED_SOLO_5x5"}
            ]"#,
        )
        .expect("classements");
        let convertis = league_entries_from_dto(entries);
        assert_eq!(convertis.len(), 2, "queues non classées filtrées");
        assert_eq!(convertis[0].queue_type, "RANKED_SOLO_5x5");
        assert_eq!(convertis[0].tier, "GOLD");
        assert_eq!(convertis[0].rank, "II");
        assert_eq!(convertis[0].league_points, 42);
        assert_eq!(convertis[1].queue_type, "RANKED_FLEX_SR");
        assert!(league_entries_from_dto(Vec::new()).is_empty());

        let ids: Vec<String> =
            serde_json::from_slice(br#"["EUW1_1","EUW1_2","EUW1_3"]"#).expect("matchlist");
        assert_eq!(ids.len(), 3);
    }

    fn match_json_dix_participants() -> serde_json::Value {
        let mut participants = Vec::new();
        for index in 0..10 {
            let puuid = if index == 0 {
                PUUID.to_string()
            } else {
                format!("autre-{index}")
            };
            let mut participant = json!({
                "puuid": puuid,
                "riotIdGameName": if index == 0 { "Test" } else { "Autre" },
                "riotIdTagline": if index == 0 { "EUW" } else { "EUW" },
                "championName": if index == 0 { "Aatrox" } else { "Ahri" },
                "teamId": if index < 5 { 100 } else { 200 },
                "kills": index,
                "deaths": 2,
                "assists": 3,
                "totalMinionsKilled": 100 + index,
                "neutralMinionsKilled": 10,
                "visionScore": 20 + index,
                "teamPosition": "TOP",
                "win": index < 5
            });
            // Deux cas de repli : nom d'affichage et position.
            if index == 1 {
                participant = json!({
                    "puuid": puuid,
                    "riotIdGameName": "",
                    "riotIdTagline": "",
                    "summonerName": "SummonerFallback",
                    "championName": "Ahri",
                    "teamId": 100,
                    "kills": 1,
                    "deaths": 1,
                    "assists": 1,
                    "totalMinionsKilled": 5,
                    "neutralMinionsKilled": 2,
                    "visionScore": 8,
                    "teamPosition": "",
                    "individualPosition": "MIDDLE",
                    "win": true
                });
            }
            participants.push(participant);
        }
        json!({
            "metadata": { "matchId": "EUW1_1234567890", "participants": [] },
            "info": {
                "gameDuration": 1800,
                "gameMode": "CLASSIC",
                "queueId": 420,
                "gameCreation": 1_700_000_000_000i64,
                "participants": participants,
                "teams": [
                    { "teamId": 100, "win": true },
                    { "teamId": 200, "win": false }
                ]
            }
        })
    }

    #[test]
    fn parsing_match_detail_et_resumes() {
        let dto: MatchDto =
            serde_json::from_value(match_json_dix_participants()).expect("match détail");
        let detail = match_detail_from_dto(&dto, "EUW1_1234567890", 1_000, false);

        assert_eq!(detail.match_id, "EUW1_1234567890");
        assert_eq!(detail.game_duration_secs, 1800);
        assert_eq!(detail.game_mode, "CLASSIC");
        assert_eq!(detail.queue_id, 420);
        assert_eq!(detail.game_creation_ms, 1_700_000_000_000);
        assert_eq!(detail.winning_team, Some(100));
        assert_eq!(detail.participants.len(), 10);
        assert_eq!(detail.fetched_at, rfc3339_from_ms(1_000));
        assert!(!detail.from_cache);

        let premier = &detail.participants[0];
        assert_eq!(premier.display_name, "Test#EUW");
        assert_eq!(premier.champion_name, "Aatrox");
        assert_eq!(premier.cs, 110, "sbires + monstres neutres");
        assert_eq!(premier.vision_score, 20);
        assert_eq!(premier.position, "TOP");
        assert!(premier.win);

        // Repli nom de summoner + position individuelle.
        let repli = &detail.participants[1];
        assert_eq!(repli.display_name, "SummonerFallback");
        assert_eq!(repli.position, "MIDDLE");

        // Résumé pour le PUUID cible.
        let resume = match_summary_from_dto(&dto, PUUID).expect("résumé");
        assert_eq!(resume.match_id, "EUW1_1234567890");
        assert_eq!(resume.champion_name, "Aatrox");
        assert_eq!(resume.kills, 0);
        assert_eq!(resume.deaths, 2);
        assert_eq!(resume.assists, 3);
        assert_eq!(resume.cs, 110);
        assert_eq!(resume.vision_score, 20);
        assert_eq!(resume.duration_secs, 1800);
        assert_eq!(resume.queue_id, 420);
        assert_eq!(resume.game_creation_ms, 1_700_000_000_000);
        assert!(resume.win);

        assert!(match_summary_from_dto(&dto, "puuid-absent").is_none());
    }

    // -- Erreurs HTTP -------------------------------------------------------

    #[test]
    fn erreurs_http_lisibles_et_sans_secret() {
        for (statut, attendu) in [
            (401, "invalide ou expirée"),
            (403, "Accès refusé"),
            (404, "Joueur introuvable"),
        ] {
            let erreur = http_error(statut, "Joueur introuvable", None);
            let message = erreur.to_string();
            assert!(message.contains(attendu), "{statut} → {message}");
            assert!(
                !message.contains("cle-locale"),
                "aucune clé dans le message"
            );
        }

        let erreur = http_error(429, "peu importe", Some(17));
        let message = erreur.to_string();
        assert!(message.contains("429"), "{message}");
        assert!(message.contains("17 s"), "{message}");

        let erreur = http_error(500, "peu importe", None);
        assert!(erreur.to_string().contains("500"));

        let erreur = http_error(418, "peu importe", None);
        assert!(erreur.to_string().contains("418"));
    }

    // -- Intégration sans réseau (caches réels, base injoignable) ----------

    /// Prépare un cache Riot complet et frais pour le Riot ID « Test#EUW ».
    fn preparer_cache_profil(racine: &Path, maintenant: i64) {
        let id = parse_riot_id("Test#EUW").expect("Riot ID");
        let account = AccountDto {
            puuid: PUUID.to_string(),
            game_name: "Test".to_string(),
            tag_line: "EUW".to_string(),
        };
        write_cache_entry(
            &account_cache_path(racine, "europe", &id),
            &CacheEntry {
                fetched_at_ms: maintenant,
                data: account,
            },
        )
        .expect("cache compte");

        let league = vec![
            LeagueEntryDto {
                queue_type: "RANKED_SOLO_5x5".to_string(),
                tier: "GOLD".to_string(),
                rank: "II".to_string(),
                league_points: 42,
                wins: 10,
                losses: 5,
            },
            LeagueEntryDto {
                queue_type: "RANKED_FLEX_SR".to_string(),
                tier: "SILVER".to_string(),
                rank: "IV".to_string(),
                league_points: 7,
                wins: 3,
                losses: 2,
            },
        ];
        write_cache_entry(
            &league_cache_path(racine, "EUW1", PUUID),
            &CacheEntry {
                fetched_at_ms: maintenant,
                data: league,
            },
        )
        .expect("cache classements");

        let ids: Vec<String> = (0..MATCH_COUNT)
            .map(|index| format!("EUW1_{}", 1_000 + index))
            .collect();
        write_cache_entry(
            &matchlist_cache_path(racine, "europe", PUUID, MATCH_COUNT),
            &CacheEntry {
                fetched_at_ms: maintenant,
                data: ids.clone(),
            },
        )
        .expect("cache matchlist");

        for match_id in ids {
            let dto: MatchDto =
                serde_json::from_value(match_json_dix_participants()).expect("match");
            let mut dto = dto;
            dto.metadata.match_id = match_id.clone();
            write_cache_entry(
                &match_cache_path(racine, &match_id),
                &CacheEntry {
                    fetched_at_ms: maintenant,
                    data: dto,
                },
            )
            .expect("cache match");
        }
    }

    #[test]
    fn integration_cache_sans_reseau_et_repli() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("riot-integration");
            let config = dir.path().join("config");
            let maintenant = 1_700_000_000_000i64;
            preparer_cache_profil(dir.path(), maintenant);

            // 1. Tout est frais : aucun appel réseau, from_cache = true.
            let (clock, temps) = test_clock(maintenant);
            let client = test_client(dir.path(), &config, clock, unreachable_base());
            let profil = client
                .profile("Test#EUW", "EUW1", false)
                .await
                .expect("profil depuis le cache");
            assert!(profil.from_cache, "aucun réseau attendu");
            assert_eq!(profil.warning, None);
            assert_eq!(profil.game_name, "Test");
            assert_eq!(profil.tag_line, "EUW");
            assert_eq!(profil.puuid, PUUID);
            assert_eq!(profil.platform, "EUW1");
            assert_eq!(profil.ranks.len(), 2);
            assert_eq!(profil.ranks[0].tier, "GOLD");
            assert_eq!(profil.matches.len(), MATCH_COUNT);
            assert_eq!(profil.matches[0].match_id, "EUW1_1000");
            assert_eq!(profil.matches[0].champion_name, "Aatrox");
            assert_eq!(profil.fetched_at, rfc3339_from_ms(maintenant));

            // 2. Détail de match depuis le cache frais.
            let detail = client
                .match_detail("EUW1_1000")
                .await
                .expect("match depuis le cache");
            assert!(detail.from_cache);
            assert_eq!(detail.match_id, "EUW1_1000");
            assert_eq!(detail.participants.len(), 10);
            assert_eq!(detail.winning_team, Some(100));
            assert_eq!(detail.fetched_at, rfc3339_from_ms(maintenant));

            // 3. force_refresh + API injoignable → repli sur cache expiré + warning.
            temps.store(maintenant + 2 * LEAGUE_TTL_MS, Ordering::Relaxed);
            let profil = client
                .profile("Test#EUW", "EUW1", true)
                .await
                .expect("profil en repli");
            assert!(!profil.from_cache, "des appels réseau ont eu lieu");
            assert_eq!(profil.ranks.len(), 2, "classements réels en cache");
            assert_eq!(profil.matches.len(), MATCH_COUNT, "matchs frais conservés");
            let warning = profil.warning.unwrap_or_default();
            assert!(
                warning.contains("API Riot indisponible"),
                "warning réel attendu : {warning}"
            );
            assert!(
                !warning.contains("cle-locale"),
                "aucune clé dans le warning"
            );

            // 4. Match expiré + API injoignable → cache réel servi (from_cache).
            temps.store(maintenant + 2 * MATCH_TTL_MS, Ordering::Relaxed);
            let detail = client
                .match_detail("EUW1_1000")
                .await
                .expect("match en repli");
            assert!(detail.from_cache);
            assert_eq!(detail.match_id, "EUW1_1000");
            assert_eq!(detail.participants.len(), 10);

            // 5. Un Riot ID invalide est refusé avant tout cache/réseau.
            let invalide = client.profile("SansTag", "EUW1", false).await;
            assert!(matches!(invalide, Err(AppError::InvalidId(_))));

            // 6. Plateforme inconnue refusée.
            let invalide = client.profile("Test#EUW", "EUW9", false).await;
            assert!(matches!(invalide, Err(AppError::InvalidId(_))));

            // 7. Match id invalide refusé.
            let invalide = client.match_detail("../EUW1_1").await;
            assert!(matches!(invalide, Err(AppError::InvalidId(_))));
        });
    }
    // -- Progression personnelle (V0.6) ------------------------------------

    fn synthese_progression(
        match_id: &str,
        champion: &str,
        win: bool,
        position: &str,
        kills: u32,
        deaths: u32,
        assists: u32,
        cs: u32,
        vision: u32,
    ) -> RiotMatchSummary {
        RiotMatchSummary {
            match_id: match_id.to_string(),
            champion_name: champion.to_string(),
            kills,
            deaths,
            assists,
            cs,
            vision_score: vision,
            duration_secs: 1_800,
            win,
            queue_id: 420,
            game_creation_ms: 1_700_000_000_000,
            position: position.to_string(),
        }
    }

    #[test]
    fn agregation_progression_et_echecs() {
        let entries = vec![
            (
                "EUW1_1".to_string(),
                synthese_progression("EUW1_1", "Ahri", true, "MIDDLE", 10, 2, 5, 200, 20),
            ),
            (
                "EUW1_2".to_string(),
                synthese_progression("EUW1_2", "Ahri", false, "MIDDLE", 5, 5, 10, 150, 10),
            ),
            (
                "EUNE1_3".to_string(),
                synthese_progression("EUNE1_3", "Zed", true, "TOP", 3, 1, 2, 100, 5),
            ),
        ];
        let (data, alertes) = aggregate_progression(
            "Test",
            "EUW",
            PUUID,
            "EUW1",
            entries,
            Vec::new(),
            1_700_000_000_000,
            Vec::new(),
        )
        .expect("agrégation");
        assert!(alertes.is_empty());

        assert_eq!(data.matches_requested, 50);
        assert_eq!(data.matches_analyzed, 3);
        assert_eq!(data.overall.games, 3);
        assert_eq!(data.overall.wins, 2);
        assert_eq!(data.overall.losses, 1);
        assert!((data.overall.win_rate - 2.0 / 3.0).abs() < 1e-9);
        assert!((data.overall.kills - 6.0).abs() < 1e-9);
        assert!((data.overall.deaths - 8.0 / 3.0).abs() < 1e-9);
        assert!((data.overall.assists - 17.0 / 3.0).abs() < 1e-9);
        assert!((data.overall.kda - 35.0 / 8.0).abs() < 1e-9);
        assert!((data.overall.cs_per_game - 150.0).abs() < 1e-9);
        assert!((data.overall.vision_per_game - 35.0 / 3.0).abs() < 1e-9);

        // by_champion : tri games desc puis win_rate desc.
        assert_eq!(data.by_champion.len(), 2);
        assert_eq!(data.by_champion[0].champion_name, "Ahri");
        assert_eq!(data.by_champion[0].games, 2);
        assert_eq!(data.by_champion[0].wins, 1);
        assert!((data.by_champion[0].win_rate - 0.5).abs() < 1e-9);
        assert!((data.by_champion[0].cs_per_game - 175.0).abs() < 1e-9);
        assert_eq!(data.by_champion[1].champion_name, "Zed");
        assert_eq!(data.by_champion[1].games, 1);
        assert_eq!(data.by_champion[1].wins, 1);

        // by_role : position « » conservée si absente.
        assert_eq!(data.by_role.len(), 2);
        assert_eq!(data.by_role[0].position, "MIDDLE");
        assert_eq!(data.by_role[0].games, 2);
        assert_eq!(data.by_role[1].position, "TOP");

        // Statistiques serveur : uniquement les matchs de la plateforme demandée.
        assert_eq!(data.server_games, 2);
        assert!((data.server_win_rate - 0.5).abs() < 1e-9);
        assert_eq!(data.platform, "EUW1");
        assert_eq!(
            data.fetched_at,
            rfc3339_from_ms(1_700_000_000_000),
            "horodatage RFC 3339"
        );

        // Positions vides conservées telles quelles.
        let entries = vec![(
            "EUW1_1".to_string(),
            synthese_progression("EUW1_1", "Ahri", true, "", 1, 0, 1, 10, 2),
        )];
        let (data, _) = aggregate_progression(
            "Test",
            "EUW",
            PUUID,
            "EUW1",
            entries,
            Vec::new(),
            0,
            Vec::new(),
        )
        .expect("agrégation rôle vide");
        assert_eq!(data.by_role[0].position, "");
        assert_eq!(data.by_role[0].kda, 2.0, "0 mort → K+A");

        // Échecs partiels : warning réel, aucune donnée inventée.
        let entries = vec![(
            "EUW1_1".to_string(),
            synthese_progression("EUW1_1", "Ahri", true, "MIDDLE", 1, 0, 1, 10, 2),
        )];
        let (_, alertes) = aggregate_progression(
            "Test",
            "EUW",
            PUUID,
            "EUW1",
            entries,
            vec!["réseau indisponible".to_string()],
            0,
            Vec::new(),
        )
        .expect("agrégation partielle");
        let warning = join_warnings(alertes).expect("warning");
        assert!(warning.contains("1 match(s)"), "{warning}");
        assert!(warning.contains("réseau indisponible"), "{warning}");

        // Aucun match analysable → Err claire.
        let vide = aggregate_progression(
            "Test",
            "EUW",
            PUUID,
            "EUW1",
            Vec::new(),
            Vec::new(),
            0,
            Vec::new(),
        );
        match vide {
            Err(AppError::Riot(message)) => {
                assert!(message.contains("Aucun match récent"), "{message}");
            }
            autre => panic!("erreur attendue, reçu : {autre:?}"),
        }
    }

    fn match_dto_progression(
        match_id: &str,
        win: bool,
        champion: &str,
        position: &str,
    ) -> MatchDto {
        let mut dto: MatchDto =
            serde_json::from_value(match_json_dix_participants()).expect("match fixture");
        dto.metadata.match_id = match_id.to_string();
        if let Some(participant) = dto.info.participants.first_mut() {
            participant.win = win;
            participant.team_position = position.to_string();
            participant.champion_name = champion.to_string();
            participant.kills = 5;
            participant.deaths = 2;
            participant.assists = 8;
            participant.total_minions_killed = 150;
            participant.neutral_minions_killed = 10;
            participant.vision_score = 20;
        }
        dto
    }

    /// Prépare cache compte + liste de 50 matchs + 50 détails frais.
    fn preparer_cache_progression(racine: &Path, maintenant: i64) {
        let id = parse_riot_id("Test#EUW").expect("Riot ID");
        write_cache_entry(
            &account_cache_path(racine, "europe", &id),
            &CacheEntry {
                fetched_at_ms: maintenant,
                data: AccountDto {
                    puuid: PUUID.to_string(),
                    game_name: "Test".to_string(),
                    tag_line: "EUW".to_string(),
                },
            },
        )
        .expect("cache compte");

        let ids: Vec<String> = (0..PROGRESSION_MATCH_COUNT)
            .map(|index| format!("EUW1_{}", 1_000 + index))
            .collect();
        write_cache_entry(
            &matchlist_cache_path(racine, "europe", PUUID, PROGRESSION_MATCH_COUNT),
            &CacheEntry {
                fetched_at_ms: maintenant,
                data: ids.clone(),
            },
        )
        .expect("cache matchlist 50");

        for (index, match_id) in ids.iter().enumerate() {
            let win = index % 2 == 0;
            let champion = if index % 2 == 0 { "Ahri" } else { "Zed" };
            let position = if index % 2 == 0 { "MIDDLE" } else { "TOP" };
            write_cache_entry(
                &match_cache_path(racine, match_id),
                &CacheEntry {
                    fetched_at_ms: maintenant,
                    data: match_dto_progression(match_id, win, champion, position),
                },
            )
            .expect("cache match");
        }
    }

    #[test]
    fn progression_depuis_cache_sans_reseau_et_force_refresh() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("riot-progression");
            let config = dir.path().join("config");
            let maintenant = 1_700_000_000_000i64;
            preparer_cache_progression(dir.path(), maintenant);

            let (clock, temps) = test_clock(maintenant);
            let client = test_client(dir.path(), &config, clock, unreachable_base());

            // 1. Tout est frais (sauf le cache dérivé) : aucun appel réseau.
            let progression = client
                .progression("Test#EUW", "EUW1", false)
                .await
                .expect("progression depuis le cache");
            assert!(progression.from_cache, "aucun réseau attendu");
            assert_eq!(progression.warning, None);
            assert_eq!(progression.matches_requested, 50);
            assert_eq!(progression.matches_analyzed, 50);
            assert_eq!(progression.overall.games, 50);
            assert_eq!(progression.overall.wins, 25);
            assert_eq!(progression.overall.losses, 25);
            assert!((progression.overall.win_rate - 0.5).abs() < 1e-9);
            assert_eq!(progression.server_games, 50, "tous les matchs EUW1");
            assert!((progression.server_win_rate - 0.5).abs() < 1e-9);
            assert_eq!(progression.by_champion.len(), 2);
            assert_eq!(progression.by_champion[0].games, 25);
            assert_eq!(progression.by_role.len(), 2);
            assert_eq!(progression.puuid, PUUID);
            assert_eq!(progression.fetched_at, rfc3339_from_ms(maintenant));
            let derive_path = progression_cache_path(dir.path(), "EUW1", PUUID);
            assert!(
                derive_path.is_file(),
                "cache dérivé écrit de façon atomique"
            );

            // 2. force_refresh + API injoignable : cache dérivé contourné, liste
            //    des 50 re-tentée (échec) → repli cache réel + warning.
            temps.store(maintenant + 2 * LEAGUE_TTL_MS, Ordering::Relaxed);
            let progression = client
                .progression("Test#EUW", "EUW1", true)
                .await
                .expect("progression en repli");
            assert!(!progression.from_cache, "des appels réseau ont eu lieu");
            assert_eq!(progression.matches_analyzed, 50);
            let warning = progression.warning.unwrap_or_default();
            assert!(
                warning.contains("API Riot indisponible"),
                "warning réel attendu : {warning}"
            );
            assert!(
                !warning.contains("cle-de-test"),
                "aucune clé dans le warning"
            );

            // 3. Aucun match analysable → Err claire (aucun appel réseau nécessaire).
            let dir_vide = temp_dir("riot-progression-vide");
            let config_vide = dir_vide.path().join("config");
            let id = parse_riot_id("Test#EUW").expect("Riot ID");
            write_cache_entry(
                &account_cache_path(dir_vide.path(), "europe", &id),
                &CacheEntry {
                    fetched_at_ms: maintenant,
                    data: AccountDto {
                        puuid: PUUID.to_string(),
                        game_name: "Test".to_string(),
                        tag_line: "EUW".to_string(),
                    },
                },
            )
            .expect("cache compte vide");
            write_cache_entry(
                &matchlist_cache_path(dir_vide.path(), "europe", PUUID, PROGRESSION_MATCH_COUNT),
                &CacheEntry {
                    fetched_at_ms: maintenant,
                    data: Vec::<String>::new(),
                },
            )
            .expect("cache matchlist vide");
            let (clock_vide, _) = test_clock(maintenant);
            let client_vide = test_client(
                dir_vide.path(),
                &config_vide,
                clock_vide,
                unreachable_base(),
            );
            let resultat = client_vide.progression("Test#EUW", "EUW1", false).await;
            match resultat {
                Err(AppError::Riot(message)) => {
                    assert!(message.contains("Aucun match récent"), "{message}");
                }
                autre => panic!("erreur attendue, reçu : {autre:?}"),
            }

            // 4. Riot ID / plateforme invalides refusés avant tout réseau.
            assert!(matches!(
                client.progression("SansTag", "EUW1", false).await,
                Err(AppError::InvalidId(_))
            ));
            assert!(matches!(
                client.progression("Test#EUW", "EUW9", false).await,
                Err(AppError::InvalidId(_))
            ));
        });
    }
}
