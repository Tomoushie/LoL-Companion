//! Esport : ligues, équipes, joueurs, tournois et classements (Riot Esports API).
//!
//! Source : API publique de LoL Esports (`esports-api.lolesports.com`). La clé
//! envoyée dans l'en-tête `x-api-key` est la **clé publique client LoL Esports**
//! (la même que celle utilisée par le site officiel) : ce n'est PAS un secret
//! utilisateur et elle ne doit pas être présentée comme telle. Aucun token n'est
//! journalisé.
//!
//! Les données externes sont mises en cache sous `<cache>/esports/` avec des TTL
//! explicites (24 h ligues/équipes, 6 h tournois/classements), écritures
//! atomiques et JSON corrompu ignoré. Les images restent des URLs distantes.

use std::path::{Path, PathBuf};

use reqwest::Url;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::cache::{self, Cache};
use crate::error::{AppError, AppResult};
use crate::model::{
    EsportsLeague, EsportsPlayer, EsportsStanding, EsportsTeam, EsportsTeamDetail,
    EsportsTournament,
};

/// Base de l'API publique Riot Esports.
const ESPORTS_BASE: &str = "https://esports-api.lolesports.com/persisted/gw";

/// Clé publique client LoL Esports (pas un secret utilisateur, comme le site
/// officiel) — volontairement documentée et jamais journalisée.
const ESPORTS_PUBLIC_API_KEY: &str = "0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z";

/// Timeout d'une requête Riot Esports.
const HTTP_TIMEOUT_SECS: u64 = 30;

/// TTL du cache des ligues et des équipes (24 h).
const LEAGUES_TTL_MS: i64 = 24 * 60 * 60 * 1_000;
const TEAMS_TTL_MS: i64 = 24 * 60 * 60 * 1_000;

/// TTL du cache des tournois et des classements (6 h).
const TOURNAMENTS_TTL_MS: i64 = 6 * 60 * 60 * 1_000;
const STANDINGS_TTL_MS: i64 = 6 * 60 * 60 * 1_000;

/// Sous-dossier du cache Esport.
const ESPORTS_CACHE_SUBDIR: &str = "esports";

/// Longueur maximale d'un identifiant numérique Riot Esports.
const MAX_ID_LEN: usize = 32;

// ---------------------------------------------------------------------------
// DTO de l'API Riot Esports (parsing défensif : tous les champs sont optionnels).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LeagueDto {
    #[serde(default)]
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    region: String,
    #[serde(default)]
    image: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LeaguesData {
    #[serde(default)]
    leagues: Vec<LeagueDto>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct LeaguesResponse {
    #[serde(default)]
    data: LeaguesData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct HomeLeagueDto {
    #[serde(default)]
    name: String,
    #[serde(default)]
    region: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct PlayerDto {
    #[serde(default)]
    id: String,
    #[serde(default, rename = "summonerName")]
    summoner_name: String,
    #[serde(default, rename = "firstName")]
    first_name: String,
    #[serde(default, rename = "lastName")]
    last_name: String,
    #[serde(default)]
    role: String,
    #[serde(default)]
    image: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TeamDto {
    #[serde(default)]
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    image: String,
    #[serde(default, rename = "alternativeImage")]
    alternative_image: Option<String>,
    #[serde(default)]
    status: String,
    #[serde(default, rename = "homeLeague")]
    home_league: Option<HomeLeagueDto>,
    #[serde(default)]
    players: Vec<PlayerDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TeamsData {
    #[serde(default)]
    teams: Vec<TeamDto>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct TeamsResponse {
    #[serde(default)]
    data: TeamsData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TournamentDto {
    #[serde(default)]
    id: String,
    #[serde(default)]
    slug: String,
    #[serde(default, rename = "startDate")]
    start_date: String,
    #[serde(default, rename = "endDate")]
    end_date: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct LeagueTournamentsDto {
    #[serde(default)]
    tournaments: Vec<TournamentDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TournamentsData {
    #[serde(default)]
    leagues: Vec<LeagueTournamentsDto>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct TournamentsResponse {
    #[serde(default)]
    data: TournamentsData,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RecordDto {
    #[serde(default)]
    wins: u32,
    #[serde(default)]
    losses: u32,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RankingTeamDto {
    #[serde(default)]
    name: String,
    #[serde(default)]
    code: String,
    #[serde(default)]
    image: String,
    #[serde(default)]
    record: Option<RecordDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct RankingDto {
    #[serde(default)]
    ordinal: u32,
    #[serde(default)]
    teams: Vec<RankingTeamDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct SectionDto {
    #[serde(default)]
    name: String,
    #[serde(default)]
    rankings: Vec<RankingDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StageDto {
    #[serde(default)]
    name: String,
    #[serde(default)]
    sections: Vec<SectionDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StandingsGroupDto {
    #[serde(default)]
    stages: Vec<StageDto>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct StandingsData {
    #[serde(default)]
    standings: Vec<StandingsGroupDto>,
}

#[derive(Debug, Clone, Default, Deserialize)]
struct StandingsResponse {
    #[serde(default)]
    data: StandingsData,
}

// ---------------------------------------------------------------------------
// Client HTTP Riot Esports.
// ---------------------------------------------------------------------------

fn http_client() -> AppResult<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(HTTP_TIMEOUT_SECS))
        .user_agent(concat!("LoL BOT/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| AppError::network("création du client HTTP Riot Esports", err))
}

/// Erreur lisible pour un statut HTTP Riot Esports (aucun token dans le message).
fn http_error(status: u16) -> AppError {
    match status {
        401 | 403 => AppError::Riot(format!(
            "Riot Esports : clé publique refusée (HTTP {status})."
        )),
        404 => AppError::Riot("Ressource Riot Esports introuvable (HTTP 404).".to_string()),
        429 => AppError::Riot(
            "Limite Riot Esports atteinte (HTTP 429) : réessayez plus tard.".to_string(),
        ),
        code if (500..=599).contains(&code) => AppError::Network(format!(
            "Erreur du serveur Riot Esports (HTTP {code}) : réessayez plus tard."
        )),
        code => AppError::Network(format!("Réponse Riot Esports inattendue (HTTP {code}).")),
    }
}

/// GET JSON sur l'API Esports (`hl=en-US` + paramètres fournis).
async fn get_json<T: DeserializeOwned>(path: &str, parametres: &[(&str, &str)]) -> AppResult<T> {
    let mut url = Url::parse(&format!("{ESPORTS_BASE}{path}"))
        .map_err(|err| AppError::Config(format!("URL Riot Esports invalide : {err}")))?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("hl", "en-US");
        for (cle, valeur) in parametres {
            query.append_pair(cle, valeur);
        }
    }
    let client = http_client()?;
    let response = client
        .get(url)
        .header("x-api-key", ESPORTS_PUBLIC_API_KEY)
        .send()
        .await
        .map_err(|err| AppError::Network(format!("Riot Esports injoignable : {err}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(http_error(status.as_u16()));
    }
    let bytes = response.bytes().await.map_err(|err| {
        AppError::Network(format!(
            "lecture de la réponse Riot Esports impossible : {err}"
        ))
    })?;
    serde_json::from_slice(&bytes)
        .map_err(|err| AppError::parse("réponse Riot Esports illisible", err))
}

async fn fetch_leagues() -> AppResult<Vec<LeagueDto>> {
    let response: LeaguesResponse = get_json("/getLeagues", &[]).await?;
    Ok(response.data.leagues)
}

async fn fetch_teams() -> AppResult<Vec<TeamDto>> {
    let response: TeamsResponse = get_json("/getTeams", &[]).await?;
    Ok(response.data.teams)
}

async fn fetch_tournaments(league_id: &str) -> AppResult<Vec<TournamentDto>> {
    let response: TournamentsResponse =
        get_json("/getTournamentsForLeague", &[("leagueId", league_id)]).await?;
    Ok(response
        .data
        .leagues
        .into_iter()
        .flat_map(|league| league.tournaments)
        .collect())
}

async fn fetch_standings(tournament_id: &str) -> AppResult<Vec<StandingsGroupDto>> {
    let response: StandingsResponse =
        get_json("/getStandings", &[("tournamentId", tournament_id)]).await?;
    Ok(response.data.standings)
}

// ---------------------------------------------------------------------------
// Cache Esport.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheEnvelope<T> {
    fetched_at_ms: i64,
    data: T,
}

fn esports_cache_root(cache_root: &Path) -> PathBuf {
    cache_root.join(ESPORTS_CACHE_SUBDIR)
}

fn leagues_cache_path(cache_root: &Path) -> PathBuf {
    esports_cache_root(cache_root).join("leagues.json")
}

fn teams_cache_path(cache_root: &Path) -> PathBuf {
    esports_cache_root(cache_root).join("teams.json")
}

fn tournaments_cache_path(cache_root: &Path, league_id: &str) -> PathBuf {
    esports_cache_root(cache_root).join(format!("tournaments-{league_id}.json"))
}

fn standings_cache_path(cache_root: &Path, tournament_id: &str) -> PathBuf {
    esports_cache_root(cache_root).join(format!("standings-{tournament_id}.json"))
}

fn read_cache<T: DeserializeOwned>(path: &Path) -> Option<CacheEnvelope<T>> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_cache<T: Serialize>(path: &Path, envelope: &CacheEnvelope<T>) -> AppResult<()> {
    let bytes = serde_json::to_vec(envelope)
        .map_err(|err| AppError::parse("encodage du cache Riot Esports", err))?;
    cache::write_bytes_atomic(path, &bytes)
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| "date inconnue".to_string())
}

fn is_fresh(fetched_at_ms: i64, ttl_ms: i64, maintenant_ms: i64) -> bool {
    fetched_at_ms >= maintenant_ms || maintenant_ms.saturating_sub(fetched_at_ms) <= ttl_ms
}

/// Résultat d'un chargement cache/API Riot Esports.
struct Cached<T> {
    data: T,
    from_cache: bool,
    warning: Option<String>,
    fetched_at_ms: i64,
}

/// Charge une ressource depuis le cache frais, sinon via `fetch` ; en cas
/// d'échec API, un cache même expiré est servi avec un warning réel.
async fn load_cached<T, F, Fut>(
    path: PathBuf,
    ttl_ms: i64,
    maintenant_ms: i64,
    fetch: F,
) -> AppResult<Cached<T>>
where
    T: Clone + Serialize + DeserializeOwned,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let cached = read_cache::<T>(&path);
    if let Some(entry) = &cached {
        if is_fresh(entry.fetched_at_ms, ttl_ms, maintenant_ms) {
            return Ok(Cached {
                data: entry.data.clone(),
                from_cache: true,
                warning: None,
                fetched_at_ms: entry.fetched_at_ms,
            });
        }
    }
    match fetch().await {
        Ok(data) => {
            let warning = write_cache(
                &path,
                &CacheEnvelope {
                    fetched_at_ms: maintenant_ms,
                    data: data.clone(),
                },
            )
            .err()
            .map(|err| {
                format!(
                    "cache Riot Esports non enregistré ({}) : {err}",
                    path.display()
                )
            });
            Ok(Cached {
                data,
                from_cache: false,
                warning,
                fetched_at_ms: maintenant_ms,
            })
        }
        Err(err) => match cached {
            Some(entry) => Ok(Cached {
                data: entry.data,
                from_cache: true,
                warning: Some(format!(
                    "Riot Esports indisponible, données en cache datant de {} — {err}",
                    rfc3339(entry.fetched_at_ms)
                )),
                fetched_at_ms: entry.fetched_at_ms,
            }),
            None => Err(err),
        },
    }
}

// ---------------------------------------------------------------------------
// Conversions DTO → contrats.
// ---------------------------------------------------------------------------

fn league_from_dto(dto: LeagueDto) -> EsportsLeague {
    EsportsLeague {
        id: dto.id,
        slug: dto.slug,
        name: dto.name,
        region: dto.region,
        image_url: dto.image,
    }
}

fn team_image(dto: &TeamDto) -> String {
    if !dto.image.trim().is_empty() {
        dto.image.clone()
    } else {
        dto.alternative_image.clone().unwrap_or_default()
    }
}

fn option_non_vide(valeur: &str) -> Option<String> {
    let valeur = valeur.trim();
    if valeur.is_empty() {
        None
    } else {
        Some(valeur.to_string())
    }
}

fn team_from_dto(dto: &TeamDto) -> EsportsTeam {
    EsportsTeam {
        id: dto.id.clone(),
        slug: dto.slug.clone(),
        name: dto.name.clone(),
        code: dto.code.clone(),
        image_url: team_image(dto),
        home_league: dto
            .home_league
            .as_ref()
            .and_then(|league| option_non_vide(&league.name)),
        region: dto
            .home_league
            .as_ref()
            .and_then(|league| option_non_vide(&league.region)),
        status: dto.status.clone(),
        player_count: dto.players.len().min(u32::MAX as usize) as u32,
    }
}

fn player_from_dto(dto: &PlayerDto) -> EsportsPlayer {
    EsportsPlayer {
        id: dto.id.clone(),
        summoner_name: dto.summoner_name.clone(),
        first_name: dto.first_name.clone(),
        last_name: dto.last_name.clone(),
        role: dto.role.clone(),
        image_url: dto.image.clone(),
        // L'API Riot Esports ne fournit pas ces informations biographiques.
        age: None,
        country: None,
        language: None,
        handedness: None,
    }
}

fn tournament_from_dto(dto: &TournamentDto) -> EsportsTournament {
    EsportsTournament {
        id: dto.id.clone(),
        slug: dto.slug.clone(),
        start_date: dto.start_date.clone(),
        end_date: dto.end_date.clone(),
    }
}

/// Aplatit `standings[].stages[].sections[].rankings[]` en lignes réelles.
///
/// Les sections sans classement (ex. playoffs sans ranking) sont ignorées sans
/// erreur ; une rangée sans équipe est ignorée (aucune donnée inventée).
fn standings_from_groups(groups: Vec<StandingsGroupDto>) -> Vec<EsportsStanding> {
    let mut lignes = Vec::new();
    for group in groups {
        for stage in group.stages {
            for section in stage.sections {
                for ranking in section.rankings {
                    let Some(team) = ranking.teams.first() else {
                        continue;
                    };
                    lignes.push(EsportsStanding {
                        stage: stage.name.clone(),
                        section: section.name.clone(),
                        ordinal: ranking.ordinal,
                        team_name: team.name.clone(),
                        team_code: team.code.clone(),
                        team_image_url: team.image.clone(),
                        wins: team.record.as_ref().map(|record| record.wins),
                        losses: team.record.as_ref().map(|record| record.losses),
                    });
                }
            }
        }
    }
    lignes
}

// ---------------------------------------------------------------------------
// Validation.
// ---------------------------------------------------------------------------

/// Valide un identifiant numérique Riot Esports (anti-traversée de chemin).
fn validate_numeric_id(kind: &str, raw: &str) -> AppResult<String> {
    let id = raw.trim();
    if id.is_empty()
        || id.len() > MAX_ID_LEN
        || !id.chars().all(|caractere| caractere.is_ascii_digit())
    {
        return Err(AppError::InvalidId(format!(
            "identifiant {kind} Riot Esports invalide : « {raw} »."
        )));
    }
    Ok(id.to_string())
}

// ---------------------------------------------------------------------------
// Fonctions internes injectables (tests sans réseau).
// ---------------------------------------------------------------------------

async fn leagues_with<F, Fut>(
    cache: &Cache,
    maintenant_ms: i64,
    fetch: F,
) -> AppResult<Cached<Vec<LeagueDto>>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<LeagueDto>>>,
{
    load_cached(
        leagues_cache_path(cache.root()),
        LEAGUES_TTL_MS,
        maintenant_ms,
        fetch,
    )
    .await
}

async fn teams_with<F, Fut>(
    cache: &Cache,
    maintenant_ms: i64,
    fetch: F,
) -> AppResult<Cached<Vec<TeamDto>>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<TeamDto>>>,
{
    load_cached(
        teams_cache_path(cache.root()),
        TEAMS_TTL_MS,
        maintenant_ms,
        fetch,
    )
    .await
}

async fn team_detail_with<F, Fut>(
    cache: &Cache,
    team_id: &str,
    maintenant_ms: i64,
    fetch: F,
) -> AppResult<EsportsTeamDetail>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<TeamDto>>>,
{
    let equipes = teams_with(cache, maintenant_ms, fetch).await?;
    let dto = equipes
        .data
        .iter()
        .find(|equipe| equipe.id == team_id)
        .ok_or_else(|| {
            AppError::Riot(format!(
                "Équipe esport introuvable dans la liste Riot Esports : {team_id}."
            ))
        })?;
    Ok(EsportsTeamDetail {
        team: team_from_dto(dto),
        players: dto.players.iter().map(player_from_dto).collect(),
        fetched_at: rfc3339(equipes.fetched_at_ms),
        from_cache: equipes.from_cache,
        warning: equipes.warning,
    })
}

async fn tournaments_with<F, Fut>(
    cache: &Cache,
    league_id: &str,
    maintenant_ms: i64,
    fetch: F,
) -> AppResult<Cached<Vec<TournamentDto>>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<TournamentDto>>>,
{
    load_cached(
        tournaments_cache_path(cache.root(), league_id),
        TOURNAMENTS_TTL_MS,
        maintenant_ms,
        fetch,
    )
    .await
}

async fn standings_with<F, Fut>(
    cache: &Cache,
    tournament_id: &str,
    maintenant_ms: i64,
    fetch: F,
) -> AppResult<Cached<Vec<StandingsGroupDto>>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<Vec<StandingsGroupDto>>>,
{
    load_cached(
        standings_cache_path(cache.root(), tournament_id),
        STANDINGS_TTL_MS,
        maintenant_ms,
        fetch,
    )
    .await
}

// ---------------------------------------------------------------------------
// API publique (utilisée par les commandes Tauri).
// ---------------------------------------------------------------------------

/// Ligues Esport (cache 24 h).
pub async fn leagues(cache: &Cache) -> AppResult<Vec<EsportsLeague>> {
    let cached = leagues_with(cache, now_ms(), || async { fetch_leagues().await }).await?;
    Ok(cached.data.into_iter().map(league_from_dto).collect())
}

/// Toutes les équipes Esport, actives et archivées (cache 24 h).
pub async fn teams(cache: &Cache) -> AppResult<Vec<EsportsTeam>> {
    let cached = teams_with(cache, now_ms(), || async { fetch_teams().await }).await?;
    Ok(cached.data.iter().map(team_from_dto).collect())
}

/// Fiche d'une équipe (équipe + joueurs), depuis le cache équipes (24 h).
pub async fn team_detail(cache: &Cache, team_id: &str) -> AppResult<EsportsTeamDetail> {
    let team_id = validate_numeric_id("d'équipe", team_id)?;
    team_detail_with(cache, &team_id, now_ms(), || async { fetch_teams().await }).await
}

/// Tournois d'une ligue (cache 6 h).
pub async fn tournaments(cache: &Cache, league_id: &str) -> AppResult<Vec<EsportsTournament>> {
    let league_id = validate_numeric_id("de ligue", league_id)?;
    let cached = tournaments_with(cache, &league_id, now_ms(), || async {
        fetch_tournaments(&league_id).await
    })
    .await?;
    Ok(cached.data.iter().map(tournament_from_dto).collect())
}

/// Convertit un chargement de classements en lignes ; une réponse vide signifie
/// un tournoi inconnu ou sans classement (Err claire, pas de panique).
fn standings_from_cached(
    cached: Cached<Vec<StandingsGroupDto>>,
    tournament_id: &str,
) -> AppResult<Vec<EsportsStanding>> {
    if cached.data.is_empty() {
        return Err(AppError::Riot(format!(
            "Tournoi Riot Esports introuvable ou sans classement : {tournament_id}."
        )));
    }
    Ok(standings_from_groups(cached.data))
}

/// Classements aplatis d'un tournoi (cache 6 h).
pub async fn standings(cache: &Cache, tournament_id: &str) -> AppResult<Vec<EsportsStanding>> {
    let tournament_id = validate_numeric_id("de tournoi", tournament_id)?;
    let cached = standings_with(cache, &tournament_id, now_ms(), || async {
        fetch_standings(&tournament_id).await
    })
    .await?;
    standings_from_cached(cached, &tournament_id)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::cache::test_support::temp_dir;

    const LEAGUES_JSON: &str = r#"{"data":{"leagues":[
        {"id":"98767991299243165","slug":"lcs","name":"LCS","region":"NORTH AMERICA","image":"http://static.lolesports.com/leagues/lcs.png"},
        {"id":"98767975604431411","slug":"worlds","name":"Worlds","region":"INTERNATIONAL","image":"http://static.lolesports.com/leagues/worlds.png"}
    ]}}"#;

    const TEAMS_JSON: &str = r#"{"data":{"teams":[
        {
            "id":"98767991853197861","slug":"t1","name":"T1","code":"T1",
            "image":"http://static.lolesports.com/teams/t1.png",
            "alternativeImage":"http://static.lolesports.com/teams/t1-alt.png",
            "status":"active",
            "homeLeague":{"name":"LCK","region":"KOREA"},
            "players":[
                {"id":"98767991747728851","summonerName":"Faker","firstName":"Sanghyeok","lastName":"Lee","role":"mid","image":"http://static.lolesports.com/players/faker.png"},
                {"id":"105320682452092471","summonerName":"Oner","firstName":"Hyunjun","lastName":"Mun","role":"jungle","image":"http://static.lolesports.com/players/oner.png"}
            ]
        },
        {
            "id":"11111111111111111","slug":"old-team","name":"Old Team","code":"OLD",
            "image":"","alternativeImage":"http://static.lolesports.com/teams/old-alt.png",
            "status":"archived","players":[]
        },
        {
            "id":"22222222222222222","slug":"no-home","name":"No Home","code":"NH",
            "status":"active"
        }
    ]}}"#;

    const TOURNAMENTS_JSON: &str = r#"{"data":{"leagues":[{"tournaments":[
        {"id":"115564797158840434","slug":"lcs_split_3_2026","startDate":"2026-07-25","endDate":"2026-10-05"},
        {"id":"115564760172712809","slug":"lcs_split_2_2026","startDate":"2026-04-04","endDate":"2026-06-15"}
    ]}]}}"#;

    const STANDINGS_JSON: &str = r#"{"data":{"standings":[{"stages":[
        {"name":"Regular Season","sections":[
            {"name":"Regular Season","matches":[],"rankings":[
                {"ordinal":1,"teams":[{"name":"LYON","code":"LYON","image":"http://static.lolesports.com/teams/lyon.png","record":{"wins":6,"losses":1}}]},
                {"ordinal":2,"teams":[{"name":"T2","code":"T2","image":"","record":null}]},
                {"ordinal":3,"teams":[]}
            ]},
            {"name":"Section vide","matches":[],"rankings":[]}
        ]},
        {"name":"Playoffs","sections":[{"name":"Playoffs","matches":[],"rankings":[]}]}
    ]}]}}"#;

    fn parse_leagues() -> Vec<LeagueDto> {
        let response: LeaguesResponse = serde_json::from_str(LEAGUES_JSON).expect("fixture ligues");
        response.data.leagues
    }

    fn parse_teams() -> Vec<TeamDto> {
        let response: TeamsResponse = serde_json::from_str(TEAMS_JSON).expect("fixture équipes");
        response.data.teams
    }

    fn parse_standings() -> Vec<StandingsGroupDto> {
        let response: StandingsResponse =
            serde_json::from_str(STANDINGS_JSON).expect("fixture classements");
        response.data.standings
    }

    #[test]
    fn parsing_ligues() {
        let ligues: Vec<EsportsLeague> = parse_leagues().into_iter().map(league_from_dto).collect();
        assert_eq!(ligues.len(), 2);
        assert_eq!(ligues[0].id, "98767991299243165");
        assert_eq!(ligues[0].slug, "lcs");
        assert_eq!(ligues[0].name, "LCS");
        assert_eq!(ligues[0].region, "NORTH AMERICA");
        assert_eq!(
            ligues[0].image_url,
            "http://static.lolesports.com/leagues/lcs.png"
        );
        assert_eq!(ligues[1].slug, "worlds");
    }

    #[test]
    fn parsing_equipes_et_image_de_repli() {
        let dtos = parse_teams();
        let equipes: Vec<EsportsTeam> = dtos.iter().map(team_from_dto).collect();
        assert_eq!(equipes.len(), 3);

        let t1 = &equipes[0];
        assert_eq!(t1.id, "98767991853197861");
        assert_eq!(t1.name, "T1");
        assert_eq!(t1.code, "T1");
        assert_eq!(t1.status, "active");
        assert_eq!(t1.player_count, 2);
        assert_eq!(t1.home_league.as_deref(), Some("LCK"));
        assert_eq!(t1.region.as_deref(), Some("KOREA"));
        assert_eq!(t1.image_url, "http://static.lolesports.com/teams/t1.png");

        // Image absente → alternativeImage ; équipe archivée sans homeLeague.
        let ancienne = &equipes[1];
        assert_eq!(ancienne.status, "archived");
        assert_eq!(
            ancienne.image_url,
            "http://static.lolesports.com/teams/old-alt.png"
        );
        assert_eq!(ancienne.home_league, None);
        assert_eq!(ancienne.region, None);
        assert_eq!(ancienne.player_count, 0);

        // Aucune image ni homeLeague : chaînes vides / None, jamais inventées.
        let sans_home = &equipes[2];
        assert_eq!(sans_home.image_url, "");
        assert_eq!(sans_home.home_league, None);
        assert_eq!(sans_home.region, None);
        assert_eq!(sans_home.player_count, 0);
    }

    #[test]
    fn parsing_joueurs_et_limites_de_l_api() {
        let dtos = parse_teams();
        let t1 = dtos
            .iter()
            .find(|equipe| equipe.id == "98767991853197861")
            .expect("T1");
        let joueurs: Vec<EsportsPlayer> = t1.players.iter().map(player_from_dto).collect();
        assert_eq!(joueurs.len(), 2);
        assert_eq!(joueurs[0].id, "98767991747728851");
        assert_eq!(joueurs[0].summoner_name, "Faker");
        assert_eq!(joueurs[0].first_name, "Sanghyeok");
        assert_eq!(joueurs[0].last_name, "Lee");
        assert_eq!(joueurs[0].role, "mid");
        assert!(joueurs[0].image_url.ends_with("faker.png"));
        // L'API Riot Esports ne fournit pas ces informations.
        assert_eq!(joueurs[0].age, None);
        assert_eq!(joueurs[0].country, None);
        assert_eq!(joueurs[0].language, None);
        assert_eq!(joueurs[0].handedness, None);
    }

    #[test]
    fn parsing_tournois() {
        let response: TournamentsResponse =
            serde_json::from_str(TOURNAMENTS_JSON).expect("fixture tournois");
        let tournois: Vec<EsportsTournament> = response
            .data
            .leagues
            .into_iter()
            .flat_map(|ligue| ligue.tournaments)
            .map(|dto| tournament_from_dto(&dto))
            .collect();
        assert_eq!(tournois.len(), 2);
        assert_eq!(tournois[0].id, "115564797158840434");
        assert_eq!(tournois[0].slug, "lcs_split_3_2026");
        assert_eq!(tournois[0].start_date, "2026-07-25");
        assert_eq!(tournois[0].end_date, "2026-10-05");
    }

    #[test]
    fn parsing_standings_aplatis_et_sections_vides() {
        let lignes = standings_from_groups(parse_standings());
        assert_eq!(
            lignes.len(),
            2,
            "sections sans ranking et rangée sans équipe ignorées"
        );
        assert_eq!(lignes[0].stage, "Regular Season");
        assert_eq!(lignes[0].section, "Regular Season");
        assert_eq!(lignes[0].ordinal, 1);
        assert_eq!(lignes[0].team_name, "LYON");
        assert_eq!(lignes[0].team_code, "LYON");
        assert_eq!(
            lignes[0].team_image_url,
            "http://static.lolesports.com/teams/lyon.png"
        );
        assert_eq!(lignes[0].wins, Some(6));
        assert_eq!(lignes[0].losses, Some(1));

        // record absent → None (pas de 0 inventé).
        assert_eq!(lignes[1].ordinal, 2);
        assert_eq!(lignes[1].team_name, "T2");
        assert_eq!(lignes[1].wins, None);
        assert_eq!(lignes[1].losses, None);

        assert!(standings_from_groups(Vec::new()).is_empty());
    }

    #[test]
    fn validation_des_identifiants() {
        for valide in ["98767991853197861", "115564797158840434", " 42 "] {
            assert!(validate_numeric_id("test", valide).is_ok());
        }
        for invalide in [
            "",
            "  ",
            "abc",
            "../42",
            "42/1",
            "42_1",
            "42 1",
            &"9".repeat(33),
        ] {
            assert!(
                matches!(
                    validate_numeric_id("test", invalide),
                    Err(AppError::InvalidId(_))
                ),
                "« {invalide} » aurait dû être refusé"
            );
        }

        // Les commandes publiques refusent les identifiants invalides avant tout réseau.
        let dir = temp_dir("esports-validation");
        let cache = dir.cache();
        tauri::async_runtime::block_on(async {
            assert!(matches!(
                team_detail(&cache, "abc").await,
                Err(AppError::InvalidId(_))
            ));
            assert!(matches!(
                tournaments(&cache, "../lcs").await,
                Err(AppError::InvalidId(_))
            ));
            assert!(matches!(
                standings(&cache, "42/1").await,
                Err(AppError::InvalidId(_))
            ));
        });
    }

    #[test]
    fn erreurs_http_lisibles() {
        for (statut, attendu) in [
            (401, "clé publique refusée"),
            (403, "clé publique refusée"),
            (404, "introuvable"),
            (429, "Limite Riot Esports"),
            (500, "500"),
            (418, "418"),
        ] {
            let message = http_error(statut).to_string();
            assert!(message.contains(attendu), "{statut} → {message}");
            assert!(
                !message.contains(ESPORTS_PUBLIC_API_KEY),
                "aucune clé dans le message"
            );
        }
    }

    #[test]
    fn chemins_de_cache_esport() {
        let root = Path::new("C:/cache-test");
        assert_eq!(
            leagues_cache_path(root),
            root.join("esports").join("leagues.json")
        );
        assert_eq!(
            teams_cache_path(root),
            root.join("esports").join("teams.json")
        );
        assert_eq!(
            tournaments_cache_path(root, "98767991299243165"),
            root.join("esports")
                .join("tournaments-98767991299243165.json")
        );
        assert_eq!(
            standings_cache_path(root, "115564797158840434"),
            root.join("esports")
                .join("standings-115564797158840434.json")
        );
        assert!(is_fresh(1_000, LEAGUES_TTL_MS, 1_000 + LEAGUES_TTL_MS));
        assert!(!is_fresh(1_000, LEAGUES_TTL_MS, 1_001 + LEAGUES_TTL_MS));
        assert!(is_fresh(1_000, STANDINGS_TTL_MS, 1_000 + STANDINGS_TTL_MS));
    }

    #[test]
    fn cache_generique_frais_expire_et_corrompu() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("esports-cache");
            let cache = dir.cache();
            let path = leagues_cache_path(cache.root());
            let ligues = parse_leagues();
            write_cache(
                &path,
                &CacheEnvelope {
                    fetched_at_ms: 1_000,
                    data: ligues.clone(),
                },
            )
            .expect("écriture cache ligues");

            // Cache frais : aucun fetch.
            let appele = AtomicBool::new(false);
            let cached = load_cached(path.clone(), LEAGUES_TTL_MS, 2_000, || {
                appele.store(true, Ordering::Relaxed);
                async { Ok::<Vec<LeagueDto>, AppError>(Vec::new()) }
            })
            .await
            .expect("cache frais");
            assert!(!appele.load(Ordering::Relaxed));
            assert!(cached.from_cache);
            assert!(cached.warning.is_none());
            assert_eq!(cached.data.len(), 2);
            assert_eq!(cached.fetched_at_ms, 1_000);

            // Cache expiré + API KO : cache réel + warning.
            let cached = load_cached(
                path.clone(),
                LEAGUES_TTL_MS,
                10 * LEAGUES_TTL_MS,
                || async { Err::<Vec<LeagueDto>, _>(AppError::Network("API KO".to_string())) },
            )
            .await
            .expect("repli cache");
            assert!(cached.from_cache);
            let warning = cached.warning.expect("warning");
            assert!(warning.contains("Riot Esports indisponible"), "{warning}");
            assert!(warning.contains("API KO"), "{warning}");

            // JSON corrompu ignoré → fetch puis réécriture atomique.
            std::fs::write(&path, b"{ corrompu").expect("corruption");
            let cached = load_cached(path.clone(), LEAGUES_TTL_MS, 20_000, || async {
                Ok::<Vec<LeagueDto>, AppError>(ligues.clone())
            })
            .await
            .expect("fetch après corruption");
            assert!(!cached.from_cache);
            assert_eq!(cached.data.len(), 2);
            let relu = read_cache::<Vec<LeagueDto>>(&path).expect("cache réécrit");
            assert_eq!(relu.data.len(), 2);
            assert_eq!(relu.fetched_at_ms, 20_000);

            // Aucun cache + échec → Err.
            let chemin_vide = tournaments_cache_path(cache.root(), "42");
            let resultat = load_cached(chemin_vide, TOURNAMENTS_TTL_MS, 0, || async {
                Err::<Vec<TournamentDto>, _>(AppError::Network("API KO".to_string()))
            })
            .await;
            assert!(matches!(resultat, Err(AppError::Network(_))));
        });
    }

    #[test]
    fn fiche_equipe_depuis_cache_et_repli() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("esports-equipe");
            let cache = dir.cache();
            let equipes = parse_teams();
            let path = teams_cache_path(cache.root());
            write_cache(
                &path,
                &CacheEnvelope {
                    fetched_at_ms: 1_000,
                    data: equipes.clone(),
                },
            )
            .expect("cache équipes");

            // Cache frais : aucun fetch ; joueurs et limites de l'API.
            let appele = AtomicBool::new(false);
            let detail = team_detail_with(cache_ref(&cache), "98767991853197861", 2_000, || {
                appele.store(true, Ordering::Relaxed);
                async { Ok::<Vec<TeamDto>, AppError>(Vec::new()) }
            })
            .await
            .expect("fiche équipe");
            assert!(!appele.load(Ordering::Relaxed));
            assert!(detail.from_cache);
            assert!(detail.warning.is_none());
            assert_eq!(detail.team.name, "T1");
            assert_eq!(detail.team.player_count, 2);
            assert_eq!(detail.players.len(), 2);
            assert_eq!(detail.players[0].summoner_name, "Faker");
            assert_eq!(detail.players[0].age, None);
            assert_eq!(detail.players[0].country, None);
            assert_eq!(detail.fetched_at, rfc3339(1_000));

            // Équipe inconnue → Err explicite.
            let inconnue =
                team_detail_with(cache_ref(&cache), "99999999999999999", 2_000, || async {
                    Ok::<Vec<TeamDto>, AppError>(Vec::new())
                })
                .await;
            match inconnue {
                Err(AppError::Riot(message)) => {
                    assert!(message.contains("introuvable"), "{message}");
                }
                autre => panic!("erreur attendue, reçu : {autre:?}"),
            }

            // Cache expiré + API KO → fiche en cache + warning réel.
            let detail = team_detail_with(
                cache_ref(&cache),
                "98767991853197861",
                10 * TEAMS_TTL_MS,
                || async { Err::<Vec<TeamDto>, _>(AppError::Network("API KO".to_string())) },
            )
            .await
            .expect("repli fiche équipe");
            assert!(detail.from_cache);
            assert_eq!(detail.players.len(), 2);
            let warning = detail.warning.expect("warning repli");
            assert!(warning.contains("Riot Esports indisponible"), "{warning}");
        });

        // Aucun cache + API KO → Err claire.
        let dir = temp_dir("esports-equipe-vide");
        let cache = dir.cache();
        let resultat = tauri::async_runtime::block_on(team_detail_with(
            cache_ref(&cache),
            "98767991853197861",
            0,
            || async { Err::<Vec<TeamDto>, _>(AppError::Network("API KO".to_string())) },
        ));
        assert!(matches!(resultat, Err(AppError::Network(_))));
    }

    /// Petite aide pour prêter le cache dans les fermetures async de test.
    fn cache_ref(cache: &Cache) -> &Cache {
        cache
    }

    #[test]
    fn standings_vides_et_tournois_vides_sans_panique() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("esports-standings");
            let cache = dir.cache();
            let path = standings_cache_path(cache.root(), "42");
            write_cache(
                &path,
                &CacheEnvelope {
                    fetched_at_ms: 1_000,
                    data: parse_standings(),
                },
            )
            .expect("cache standings");
            let cached = standings_with(cache_ref(&cache), "42", 1_500, || async {
                Err::<Vec<StandingsGroupDto>, _>(AppError::Network("API KO".to_string()))
            })
            .await
            .expect("standings cache");
            assert!(cached.from_cache);
            assert_eq!(standings_from_groups(cached.data).len(), 2);

            // Tournoi valide mais réponse vide → Err claire (aucune invention).
            let vide = load_cached(
                standings_cache_path(cache.root(), "43"),
                STANDINGS_TTL_MS,
                0,
                || async { Ok::<Vec<StandingsGroupDto>, AppError>(Vec::new()) },
            )
            .await
            .expect("cache standings vide");
            assert!(vide.data.is_empty());
            match standings_from_cached(vide, "43") {
                Err(AppError::Riot(message)) => {
                    assert!(
                        message.contains("introuvable ou sans classement"),
                        "{message}"
                    );
                }
                autre => panic!("erreur attendue, reçu : {autre:?}"),
            }
        });
    }
}
