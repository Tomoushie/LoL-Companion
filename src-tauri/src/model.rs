//! Contrats sérialisés entre le backend Rust et le frontend TypeScript.
//!
//! Convention : tous les champs sont exposés en `camelCase` pour coller aux
//! types de `src/types.ts`. Toute évolution doit être synchronisée des deux
//! côtés.

use serde::{Deserialize, Serialize};

/// Nombre d'éléments réellement présents dans le cache local.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DatasetCounts {
    pub champions: usize,
    pub items: usize,
    pub rune_trees: usize,
    /// Icônes PNG de champions réellement lisibles dans le cache.
    pub icons_cached: usize,
    /// Icônes PNG d'objets réellement lisibles dans le cache.
    pub item_icons_cached: usize,
    /// Icônes PNG de runes/arbres de runes réellement lisibles dans le cache.
    pub rune_icons_cached: usize,
}

/// État de la donnée Data Dragon en cache (aucune invention : null/0 si absent).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DataStatus {
    /// Version Data Dragon effectivement en cache (ex. « 16.21.1 »), sinon null.
    pub version: Option<String>,
    /// Dossier de cache local absolu.
    pub cache_dir: String,
    /// Horodatage RFC 3339 de la dernière synchronisation réussie.
    pub updated_at: Option<String>,
    /// Vrai si la dernière synchronisation a dû se rabattre sur le cache
    /// (réseau indisponible, version en cache conservée).
    pub offline: bool,
    /// Message réel expliquant le mode hors ligne ou un téléchargement partiel.
    pub warning: Option<String>,
    /// Compteurs calculés depuis les fichiers réellement en cache.
    pub counts: DatasetCounts,
}

/// Champion (résumé Data Dragon, suffisant pour la grille).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Champion {
    /// Identifiant Data Dragon (« Ahri »), utilisé pour les URLs d'assets.
    pub id: String,
    /// Clé numérique Riot (« 103 »).
    pub key: String,
    pub name: String,
    pub title: String,
    pub tags: Vec<String>,
    /// Chemin absolu de l'icône en cache, null si l'icône n'est pas téléchargée.
    pub icon_path: Option<String>,
}

/// Statistique brute d'un objet Data Dragon (`stats` du JSON).
///
/// La clé est telle que fournie par Riot (`FlatPhysicalDamageMod`,
/// `PercentAttackSpeedMod`, …) ; le libellé et le format sont décidés côté
/// interface. Aucune valeur n'est inventée ni complétée.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ItemStat {
    pub key: String,
    pub value: f64,
}

/// Objet (item) Data Dragon.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Item {
    pub id: String,
    pub name: String,
    pub plain_text: String,
    /// Description nettoyée du HTML Data Dragon (balises retirées).
    pub description: String,
    pub gold_total: u32,
    /// Prix de base Data Dragon (`gold.base`), 0 si non fourni.
    pub gold_base: u32,
    /// Prix de revente (`gold.sell`), 0 si non fourni.
    pub gold_sell: u32,
    /// Vrai si l'objet est achetable (`gold.purchasable`).
    pub purchasable: bool,
    pub tags: Vec<String>,
    /// Vrai si l'objet est disponible sur la Faille de l'invocateur (map 11).
    pub on_summoners_rift: bool,
    /// Niveau de recette Data Dragon (`depth`), null si non fourni.
    pub depth: Option<u32>,
    /// Vrai si l'objet est vendu en boutique (`inStore`), null si non fourni.
    pub in_store: Option<bool>,
    /// Vrai si l'objet est consommable (`consumed`), null si non fourni.
    pub consumed: Option<bool>,
    /// Identifiants Data Dragon des composants de la recette (`from`), ordre Riot.
    pub from: Vec<String>,
    /// Identifiants Data Dragon des objets dans lesquels celui-ci se transforme (`into`).
    pub into: Vec<String>,
    /// Chemin absolu de l'icône en cache, null si l'icône n'est pas disponible.
    pub icon_path: Option<String>,
    /// Statistiques non nulles fournies par Riot, dans l'ordre du JSON.
    pub stats: Vec<ItemStat>,
}

/// Statistiques de base d'un champion (valeurs exactes Data Dragon).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChampionStats {
    pub hp: f64,
    pub hp_per_level: f64,
    pub mp: f64,
    pub mp_per_level: f64,
    pub armor: f64,
    pub armor_per_level: f64,
    pub magic_resist: f64,
    pub magic_resist_per_level: f64,
    pub attack_damage: f64,
    pub attack_damage_per_level: f64,
    pub attack_speed: f64,
    pub attack_speed_per_level: f64,
    pub move_speed: f64,
    pub attack_range: f64,
    pub hp_regen: f64,
    pub mp_regen: f64,
}

/// Sort d'un champion (description nettoyée du HTML).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChampionSpell {
    pub id: String,
    pub name: String,
    pub description: String,
    /// Coût de récupération (mana, énergie, fureur…) tel que fourni par Riot,
    /// ex. « 60/65/70/75/80 » ; chaîne conservée pour ne pas perdre les paliers.
    pub cooldown: String,
    pub cost: String,
    /// Ressource du coût (Mana, Energy, Rage…), fournie par Riot.
    pub cost_type: String,
    /// Portée fournie par Riot (ex. « 650 »).
    pub range: String,
    /// Chemin absolu de l'icône en cache, null si absente.
    pub icon_path: Option<String>,
}

/// Passif d'un champion.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChampionPassive {
    pub name: String,
    pub description: String,
    pub icon_path: Option<String>,
}

/// Fiche détaillée d'un champion (onglet/fiche V0.2).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChampionDetail {
    pub id: String,
    pub key: String,
    pub name: String,
    pub title: String,
    pub tags: Vec<String>,
    /// Courte biographie officielle Data Dragon (`blurb`), en anglais.
    pub blurb: String,
    /// Chemin absolu du splash art en cache, null si absent.
    pub splash_path: Option<String>,
    pub stats: ChampionStats,
    pub spells: Vec<ChampionSpell>,
    pub passive: Option<ChampionPassive>,
}

/// Arbre de runes (5 arbres : Domination, Inspiration, Précision, Volonté, Sorcellerie).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RuneTree {
    pub id: u32,
    pub key: String,
    /// Nom officiel `en_US` fourni par Data Dragon (toujours présent).
    pub name: String,
    /// Nom officiel `fr_FR` fourni par Data Dragon, `None` si indisponible.
    pub localized_name: Option<String>,
    /// Chemin d'icône relatif fourni par Data Dragon (`perk-images/...`).
    pub icon: String,
    /// Chemin absolu de l'icône PNG locale, `None` si non téléchargée.
    pub icon_path: Option<String>,
    pub runes: Vec<Rune>,
}

/// Rune individuelle, aplatie avec son palier (`slot` = ligne de l'arbre).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Rune {
    pub id: u32,
    pub key: String,
    /// Nom officiel `en_US` fourni par Data Dragon (toujours présent).
    pub name: String,
    /// Description courte `en_US` nettoyée du HTML (telle que fournie).
    pub short_desc: String,
    /// Description longue `en_US` nettoyée du HTML, vide si non fournie.
    pub long_desc: String,
    /// Nom officiel `fr_FR` fourni par Data Dragon, `None` si indisponible.
    pub localized_name: Option<String>,
    /// Description courte `fr_FR` nettoyée du HTML, `None` si indisponible.
    pub localized_short_desc: Option<String>,
    /// Description longue `fr_FR` nettoyée du HTML, `None` si indisponible.
    pub localized_long_desc: Option<String>,
    /// Chemin d'icône relatif fourni par Data Dragon (`perk-images/...`).
    pub icon: String,
    /// Chemin absolu de l'icône PNG locale, `None` si non téléchargée.
    pub icon_path: Option<String>,
    pub slot: u32,
}

// ---------------------------------------------------------------------------
// Riot API (V0.5)
// ---------------------------------------------------------------------------

/// État de la clé API Riot côté poste local (la clé elle-même n'est jamais
/// renvoyée au frontend).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RiotKeyStatus {
    pub configured: bool,
    /// Origine de la clé : « environment » ou « local », `None` si absente.
    pub source: Option<String>,
}

/// Plateforme Riot proposée dans l'interface (identifiant réel + libellé).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RiotPlatformInfo {
    pub id: String,
    pub label: String,
}

/// Entrée de classement Riot (League-v4) pour une file donnée.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RiotLeagueEntry {
    /// `RANKED_SOLO_5x5`, `RANKED_FLEX_SR`, …
    pub queue_type: String,
    pub tier: String,
    pub rank: String,
    pub league_points: u32,
    pub wins: u32,
    pub losses: u32,
}

/// Résumé d'un match dans la liste des 10 derniers.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiotMatchSummary {
    pub match_id: String,
    /// Identifiant Data Dragon du champion joué (`Aatrox`, `MonkeyKing`, …).
    pub champion_name: String,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    /// Sbires + monstres neutres (`totalMinionsKilled + neutralMinionsKilled`).
    pub cs: u32,
    pub vision_score: u32,
    pub duration_secs: u32,
    pub win: bool,
    pub queue_id: u32,
    pub game_creation_ms: i64,
    pub position: String,
}

/// Profil Riot d'un joueur : identité, classements et 10 derniers matchs.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiotProfile {
    pub game_name: String,
    pub tag_line: String,
    pub puuid: String,
    /// Plateforme demandée (`EUW1`, `NA1`, …).
    pub platform: String,
    pub ranks: Vec<RiotLeagueEntry>,
    pub matches: Vec<RiotMatchSummary>,
    /// Horodatage RFC 3339 des données (cache ou réseau).
    pub fetched_at: String,
    /// Vrai si la réponse a été servie sans aucun appel réseau.
    pub from_cache: bool,
    /// Message réel (données en cache suite à une erreur, matchs partiels…).
    pub warning: Option<String>,
}

/// Participant d'un match (10 joueurs).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RiotMatchParticipant {
    pub puuid: String,
    /// Riot ID affichable (`Nom#TAG`) ou nom de summoner fourni par Riot.
    pub display_name: String,
    pub champion_name: String,
    pub team_id: u32,
    pub kills: u32,
    pub deaths: u32,
    pub assists: u32,
    pub cs: u32,
    pub vision_score: u32,
    pub position: String,
    pub win: bool,
}

/// Détail d'un match (fiche de match).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiotMatchDetail {
    pub match_id: String,
    pub game_duration_secs: u32,
    pub game_mode: String,
    pub queue_id: u32,
    pub game_creation_ms: i64,
    /// Équipe gagnante (100/200) si Riot la fournit.
    pub winning_team: Option<u32>,
    pub participants: Vec<RiotMatchParticipant>,
    pub fetched_at: String,
    pub from_cache: bool,
}

// ---------------------------------------------------------------------------
// OP.GG (MCP public) — tier lists et builds méta (V0.6)
// ---------------------------------------------------------------------------

/// Entrée de tier list OP.GG pour un champion et un rôle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaTierEntry {
    /// Clé numérique Data Dragon (`86` pour Garen), 0 si introuvable.
    pub champion_key: u32,
    /// Nom fourni par OP.GG (affichage de secours).
    pub champion_name: String,
    /// `top`, `mid`, `jungle`, `adc`, `support`.
    pub position: String,
    /// 1 = OP, 2 = Fort, 3 = Bon, 4 = Correct, 5 = Faible (sémantique OP.GG).
    pub tier: u32,
    pub rank: u32,
    pub win_rate: f64,
    pub pick_rate: f64,
    pub ban_rate: f64,
    pub kda: f64,
    pub play: u32,
    pub role_rate: f64,
}

/// Tier list OP.GG d'une région (données externes réelles, mises en cache).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaTierList {
    /// Plateforme demandée (`EUW1`).
    pub platform: String,
    /// Slug OP.GG (`euw`).
    pub region: String,
    /// Source affichée (ex. « OP.GG MCP »).
    pub source: String,
    pub fetched_at: String,
    pub from_cache: bool,
    pub entries: Vec<MetaTierEntry>,
    pub warning: Option<String>,
}

/// Objet d'un build méta (avec taux de sélection réel OP.GG).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaItemBuild {
    /// Identifiants Data Dragon des objets (mêmes ids que `item.json`).
    pub ids: Vec<u32>,
    /// Noms fournis par OP.GG.
    pub names: Vec<String>,
    pub pick_rate: f64,
    pub games: u32,
    pub wins: u32,
}

/// Build méta OP.GG pour un champion/rôle/tiers donnés.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaBuild {
    pub champion: String,
    pub position: String,
    pub platform: String,
    pub region: String,
    /// Filtre de rang demandé (`challenger`, `all`).
    pub tier: String,
    pub source: String,
    pub fetched_at: String,
    pub from_cache: bool,
    pub win_rate: Option<f64>,
    pub pick_rate: Option<f64>,
    pub ban_rate: Option<f64>,
    pub games: Option<u32>,
    pub tier_label: Option<u32>,
    pub rank: Option<u32>,
    pub starter: Vec<MetaItemBuild>,
    pub boots: Vec<MetaItemBuild>,
    pub core: Vec<MetaItemBuild>,
    pub fourth: Vec<MetaItemBuild>,
    pub fifth: Vec<MetaItemBuild>,
    pub sixth: Vec<MetaItemBuild>,
    pub warning: Option<String>,
}

// ---------------------------------------------------------------------------
// Progression personnelle (Riot API, 50 derniers matchs) — V0.6
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiotProgressionOverall {
    pub games: u32,
    pub wins: u32,
    pub losses: u32,
    /// Taux de victoire entre 0 et 1 (0 si aucun match).
    pub win_rate: f64,
    pub kills: f64,
    pub deaths: f64,
    pub assists: f64,
    pub kda: f64,
    pub cs_per_game: f64,
    pub vision_per_game: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiotChampionProgress {
    pub champion_name: String,
    pub games: u32,
    pub wins: u32,
    pub win_rate: f64,
    pub kills: f64,
    pub deaths: f64,
    pub assists: f64,
    pub kda: f64,
    pub cs_per_game: f64,
    pub vision_per_game: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiotRoleProgress {
    /// `TOP`, `JUNGLE`, `MIDDLE`, `BOTTOM`, `UTILITY` ou « » si absent.
    pub position: String,
    pub games: u32,
    pub wins: u32,
    pub win_rate: f64,
    pub kda: f64,
}

/// Progression personnelle calculée sur les 50 derniers matchs du joueur.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RiotProgression {
    pub game_name: String,
    pub tag_line: String,
    pub puuid: String,
    pub platform: String,
    pub matches_requested: u32,
    pub matches_analyzed: u32,
    pub overall: RiotProgressionOverall,
    pub by_champion: Vec<RiotChampionProgress>,
    pub by_role: Vec<RiotRoleProgress>,
    /// Taux de victoire sur la plateforme demandée (serveur).
    pub server_win_rate: f64,
    pub server_games: u32,
    pub fetched_at: String,
    pub from_cache: bool,
    pub warning: Option<String>,
}

// ---------------------------------------------------------------------------
// Rune Builder (V0.7) — trois pages de runes réelles OP.GG
// ---------------------------------------------------------------------------

/// Une page de runes proposée par OP.GG pour un champion/rôle et une portée donnée.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaRunePage {
    /// Portée réelle de la page : `challenger`, `grandmaster` ou `all`.
    pub scope: String,
    pub primary_page_id: u32,
    pub primary_page_name: String,
    /// Keystone en premier, puis les 3 runes majeures de l'arbre principal.
    pub primary_rune_ids: Vec<u32>,
    pub primary_rune_names: Vec<String>,
    pub secondary_page_id: u32,
    pub secondary_page_name: String,
    pub secondary_rune_ids: Vec<u32>,
    pub secondary_rune_names: Vec<String>,
    /// Fragments de stats (ids Riot).
    pub stat_mod_ids: Vec<u32>,
    /// Libellés réels (Community Dragon) ; ids en chaîne si indisponibles.
    pub stat_mod_names: Vec<String>,
    pub play: u32,
    pub win: u32,
    pub pick_rate: f64,
    /// Taux de victoire calculé (win/play), absent si échantillon nul.
    pub win_rate: Option<f64>,
}

/// Trois pages de runes réelles OP.GG pour un champion et un rôle.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MetaRunePages {
    pub champion: String,
    pub position: String,
    pub platform: String,
    pub source: String,
    pub fetched_at: String,
    pub from_cache: bool,
    pub pages: Vec<MetaRunePage>,
    pub warning: Option<String>,
}
