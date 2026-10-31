//! Client Data Dragon : résolution de version, téléchargements HTTP et parsing.
//!
//! Ce module ne touche pas au système de fichiers : il produit des octets ou des
//! structures typées. L'écriture en cache est orchestrée par `commands` via
//! [`crate::cache::Cache`]. Aucune donnée n'est inventée : tout provient des JSON
//! publics de Data Dragon.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::time::Duration;

use serde::de::{MapAccess, Visitor};
use serde::Deserialize;

use crate::error::{AppError, AppResult};
use crate::model::{
    Champion, ChampionPassive, ChampionSpell, ChampionStats, Item, ItemStat, Rune, RuneTree,
};

/// Liste publique des versions Data Dragon.
pub const VERSIONS_URL: &str = "https://ddragon.leagueoflegends.com/api/versions.json";
/// Racine du CDN Data Dragon.
pub const CDN_BASE: &str = "https://ddragon.leagueoflegends.com/cdn";
/// Locale utilisée pour les fichiers de données (l'application est en français,
/// mais les libellés officiels ne sont pas traduits en V0.1).
pub const LOCALE: &str = "en_US";

/// Nombre de tentatives par requête HTTP (2 à 3 exigées).
const HTTP_ATTEMPTS: u32 = 3;
/// Délai de base du backoff exponentiel entre deux tentatives.
const HTTP_RETRY_BACKOFF: Duration = Duration::from_millis(400);
/// Délai maximal d'une requête HTTP.
const HTTP_TIMEOUT: Duration = Duration::from_secs(10);
/// Taille maximale acceptée pour une réponse Data Dragon (garde-fou).
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// Client HTTP Data Dragon avec délai maximal et tentatives multiples.
#[derive(Debug, Clone)]
pub struct DdragonClient {
    http: reqwest::Client,
}

impl DdragonClient {
    /// Construit le client HTTP (rustls, timeout de 10 s).
    pub fn new() -> AppResult<Self> {
        let http = reqwest::Client::builder()
            .timeout(HTTP_TIMEOUT)
            .user_agent(concat!(
                "LoL BOT/",
                env!("CARGO_PKG_VERSION"),
                " (application locale, données statiques Data Dragon)"
            ))
            .build()
            .map_err(|err| AppError::network("création du client HTTP Data Dragon", err))?;
        Ok(Self { http })
    }

    /// Récupère la première version publiée par Data Dragon.
    pub async fn latest_version(&self) -> AppResult<String> {
        let bytes = self.get_bytes(VERSIONS_URL).await?;
        parse_versions(&bytes)
    }

    /// Télécharge une URL avec tentatives et backoff exponentiel.
    pub async fn get_bytes(&self, url: &str) -> AppResult<Vec<u8>> {
        self.get_bytes_with_attempts(url, HTTP_ATTEMPTS).await
    }

    /// Télécharge une URL avec un nombre de tentatives explicite.
    pub async fn get_bytes_with_attempts(&self, url: &str, attempts: u32) -> AppResult<Vec<u8>> {
        let attempts = attempts.max(1);
        let mut derniere_erreur = String::new();
        for tentative in 1..=attempts {
            match self.try_get(url).await {
                Ok(bytes) => return Ok(bytes),
                Err(err) => {
                    derniere_erreur = err.to_string();
                    if tentative < attempts {
                        let delai = HTTP_RETRY_BACKOFF * 2u32.pow(tentative - 1);
                        tokio::time::sleep(delai).await;
                    }
                }
            }
        }
        Err(AppError::Network(format!(
            "échec du téléchargement de {url} après {attempts} tentative(s) : {derniere_erreur}"
        )))
    }

    /// Une tentative de téléchargement.
    async fn try_get(&self, url: &str) -> AppResult<Vec<u8>> {
        let response = self
            .http
            .get(url)
            .send()
            .await
            .map_err(|err| AppError::network(&format!("requête vers {url}"), err))?;
        let response = response
            .error_for_status()
            .map_err(|err| AppError::network(&format!("réponse HTTP de {url}"), err))?;
        let bytes = response
            .bytes()
            .await
            .map_err(|err| AppError::network(&format!("lecture de la réponse de {url}"), err))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err(AppError::Network(format!(
                "réponse trop volumineuse depuis {url} ({} octets)",
                bytes.len()
            )));
        }
        Ok(bytes.to_vec())
    }
}

/// URL d'un fichier de données Data Dragon.
pub fn data_url(version: &str, file: &str) -> String {
    format!("{CDN_BASE}/{version}/data/{LOCALE}/{file}")
}

/// URL d'une icône de champion.
pub fn champion_icon_url(version: &str, image_file: &str) -> String {
    format!("{CDN_BASE}/{version}/img/champion/{image_file}")
}

/// URL d'une icône d'objet.
pub fn item_icon_url(version: &str, image_file: &str) -> String {
    format!("{CDN_BASE}/{version}/img/item/{image_file}")
}

/// URL de l'icône d'un sort.
pub fn spell_icon_url(version: &str, image_file: &str) -> String {
    format!("{CDN_BASE}/{version}/img/spell/{image_file}")
}

/// URL de l'icône d'un passif.
pub fn passive_icon_url(version: &str, image_file: &str) -> String {
    format!("{CDN_BASE}/{version}/img/passive/{image_file}")
}

/// URL de la fiche JSON détaillée d'un champion.
pub fn champion_detail_url(version: &str, champion_id: &str) -> String {
    format!("{CDN_BASE}/{version}/data/{LOCALE}/champion/{champion_id}.json")
}

/// URL du splash art d'un champion.
///
/// Le CDN renvoie 403 pour l'URL de splash versionnée (`cdn/<version>/...`) :
/// on utilise volontairement l'URL Data Dragon **sans version**
/// (`cdn/img/champion/splash/...`), vérifiée accessible.
pub fn splash_url(champion_id: &str) -> String {
    format!("{CDN_BASE}/img/champion/splash/{champion_id}_0.jpg")
}

/// URL d'une icône de rune ou d'arbre de runes.
///
/// Comme le splash, ces icônes sont servies par le CDN **sans version**
/// (`cdn/img/<icône>`), l'URL versionnée renvoyant 403. `icon` est le chemin
/// relatif fourni par Data Dragon, validé par [`is_valid_icon_rel_path`].
pub fn rune_icon_url(icon: &str) -> String {
    format!("{CDN_BASE}/img/{icon}")
}

/// URL d'un fichier de données Data Dragon dans une locale donnée.
pub fn localized_data_url(version: &str, locale: &str, file: &str) -> String {
    format!("{CDN_BASE}/{version}/data/{locale}/{file}")
}

/// Vérifie le format d'une version Data Dragon et refuse tout path traversal.
///
/// Seuls `[0-9A-Za-z._-]` sont acceptés, la longueur est bornée et les séquences
/// `.` / `..` sont refusées (même si les séparateurs `/` et `\` sont déjà exclus
/// par la liste blanche).
pub fn validate_version(version: &str) -> AppResult<()> {
    const MAX_LEN: usize = 32;
    let refusee = || {
        AppError::InvalidVersion(format!(
            "version Data Dragon refusée : « {version} » (format inattendu ou tentative de traversée de chemin)"
        ))
    };

    if version.is_empty() || version.len() > MAX_LEN {
        return Err(refusee());
    }
    if version == "." || version.contains("..") {
        return Err(refusee());
    }
    if !version
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(refusee());
    }
    Ok(())
}

/// Extrait la première version de `versions.json` après validation.
pub fn parse_versions(bytes: &[u8]) -> AppResult<String> {
    let versions: Vec<String> = serde_json::from_slice(bytes)
        .map_err(|err| AppError::parse("versions.json Data Dragon illisible", err))?;
    let premiere = versions.first().ok_or_else(|| {
        AppError::Parse("versions.json Data Dragon ne contient aucune version".to_string())
    })?;
    validate_version(premiere)?;
    Ok(premiere.clone())
}

/// Vrai si le nom de fichier est sûr (pas de séparateur, pas de `..`).
///
/// Utilisé pour les noms de fichiers venant du JSON Data Dragon (`image.full`)
/// avant toute construction de chemin sur disque.
pub fn is_safe_file_name(name: &str) -> bool {
    const MAX_LEN: usize = 128;
    !name.is_empty()
        && name.len() <= MAX_LEN
        && name != "."
        && name != ".."
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// Nom de fichier PNG de l'icône d'un champion, avec repli sur `<id>.png`.
///
/// Renvoie `None` si aucun nom sûr ne peut être construit (donnée inexploitable).
pub fn champion_icon_file(champion: &RawChampion) -> Option<String> {
    if is_safe_file_name(&champion.image.full) {
        return Some(champion.image.full.clone());
    }
    if is_safe_file_name(&champion.id) {
        return Some(format!("{}.png", champion.id));
    }
    None
}

/// Vrai si l'identifiant de champion est sûr pour construire un chemin ou une URL.
///
/// Les identifiants Data Dragon sont ASCII graphiques (`Aatrox`, `Ahri`, …) ; on
/// refuse explicitement les séparateurs, `..`, les caractères interdits sous
/// Windows et tout caractère de contrôle. La vérification « identifiant connu »
/// est faite séparément en confrontant la liste de `champion.json`.
pub fn is_valid_champion_id(id: &str) -> bool {
    const MAX_LEN: usize = 64;
    !id.is_empty()
        && id.len() <= MAX_LEN
        && id != "."
        && !id.contains("..")
        && id.chars().all(|c| {
            c.is_ascii_graphic()
                && !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
}

/// Vrai si un chemin d'icône relatif Data Dragon est sûr à écrire dans le cache.
///
/// Les icônes de runes ont la forme `perk-images/Styles/<fichier>.png`. On exige
/// des segments non vides, uniquement `[A-Za-z0-9._-]`, ni `.` ni `..`, pas de
/// séparateur Windows, pas de chemin absolu, et des longueurs bornées. Le même
/// contrôle protège la construction de l'URL sans version.
pub fn is_valid_icon_rel_path(icon: &str) -> bool {
    const MAX_TOTAL_LEN: usize = 256;
    const MAX_SEGMENT_LEN: usize = 128;
    const MAX_SEGMENTS: usize = 8;

    if icon.is_empty() || icon.len() > MAX_TOTAL_LEN {
        return false;
    }
    let mut segments = 0usize;
    for segment in icon.split('/') {
        segments += 1;
        if segment.is_empty()
            || segment == "."
            || segment == ".."
            || segment.len() > MAX_SEGMENT_LEN
            || !segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return false;
        }
    }
    segments <= MAX_SEGMENTS
}

/// Vrai si les octets ressemblent à un PNG (signature).
pub fn is_png(bytes: &[u8]) -> bool {
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
}

/// Vrai si les octets ressemblent à un JPEG (signature `FF D8 FF`).
pub fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF])
}

// ---------------------------------------------------------------------------
// Structures brutes de Data Dragon et conversion vers les contrats `model`.
// ---------------------------------------------------------------------------

/// Entrée brute de `champion.json`.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawChampion {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub image: RawImage,
}

/// Image brute d'un champion (seul `full` nous intéresse en V0.1).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawImage {
    #[serde(default)]
    pub full: String,
}

#[derive(Debug, Deserialize)]
struct ChampionFile {
    data: BTreeMap<String, RawChampion>,
}

/// Parse `champion.json` et ne conserve que les entrées exploitables.
pub fn parse_champions(bytes: &[u8]) -> AppResult<Vec<RawChampion>> {
    let file: ChampionFile = serde_json::from_slice(bytes)
        .map_err(|err| AppError::parse("champion.json Data Dragon invalide", err))?;

    let mut champions = Vec::with_capacity(file.data.len());
    for (cle, mut champion) in file.data {
        if champion.id.is_empty() {
            champion.id = cle;
        }
        if champion.id.is_empty() || champion.name.trim().is_empty() {
            continue;
        }
        champions.push(champion);
    }
    Ok(champions)
}

/// Conversion d'un champion brut vers le contrat sérialisé.
///
/// `icon_path` n'est renseigné que si le PNG est réellement présent ; il est
/// calculé par l'appelant (qui possède le cache).
pub fn champion_from_raw(champion: RawChampion, icon_path: Option<String>) -> Champion {
    Champion {
        id: champion.id,
        key: champion.key,
        name: champion.name,
        title: champion.title,
        tags: champion.tags,
        icon_path,
    }
}

// ---------------------------------------------------------------------------
// Fiche détaillée d'un champion (`champion/<Id>.json`).
// ---------------------------------------------------------------------------

/// Statistiques brutes d'un champion (`stats` de la fiche Data Dragon).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawChampionStats {
    #[serde(default)]
    pub hp: f64,
    #[serde(default, rename = "hpperlevel")]
    pub hp_per_level: f64,
    #[serde(default)]
    pub mp: f64,
    #[serde(default, rename = "mpperlevel")]
    pub mp_per_level: f64,
    #[serde(default)]
    pub armor: f64,
    #[serde(default, rename = "armorperlevel")]
    pub armor_per_level: f64,
    #[serde(default)]
    pub spellblock: f64,
    #[serde(default, rename = "spellblockperlevel")]
    pub magic_resist_per_level: f64,
    #[serde(default, rename = "attackdamage")]
    pub attack_damage: f64,
    #[serde(default, rename = "attackdamageperlevel")]
    pub attack_damage_per_level: f64,
    #[serde(default, rename = "attackspeed")]
    pub attack_speed: f64,
    #[serde(default, rename = "attackspeedperlevel")]
    pub attack_speed_per_level: f64,
    #[serde(default, rename = "movespeed")]
    pub move_speed: f64,
    #[serde(default, rename = "attackrange")]
    pub attack_range: f64,
    #[serde(default, rename = "hpregen")]
    pub hp_regen: f64,
    #[serde(default, rename = "mpregen")]
    pub mp_regen: f64,
}

/// Sort brut d'une fiche champion.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawSpell {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, rename = "cooldownBurn")]
    pub cooldown_burn: String,
    #[serde(default, rename = "costBurn")]
    pub cost_burn: String,
    #[serde(default, rename = "costType")]
    pub cost_type: String,
    #[serde(default, rename = "rangeBurn")]
    pub range_burn: String,
    #[serde(default)]
    pub image: RawImage,
}

/// Passif brut d'une fiche champion.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawPassive {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub image: RawImage,
}

/// Entrée brute d'une fiche champion (valeur de `data.<Id>`).
#[derive(Debug, Clone, Default, Deserialize)]
pub struct RawChampionDetail {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub blurb: String,
    #[serde(default)]
    pub stats: RawChampionStats,
    #[serde(default)]
    pub spells: Vec<RawSpell>,
    #[serde(default)]
    pub passive: Option<RawPassive>,
}

#[derive(Debug, Deserialize)]
struct ChampionDetailFile {
    data: BTreeMap<String, RawChampionDetail>,
}

/// Parse la fiche détaillée d'un champion ; l'entrée `data.<champion_id>` est exigée.
pub fn parse_champion_detail(bytes: &[u8], champion_id: &str) -> AppResult<RawChampionDetail> {
    let file: ChampionDetailFile = serde_json::from_slice(bytes)
        .map_err(|err| AppError::parse("fiche champion Data Dragon invalide", err))?;
    let mut detail = file.data.get(champion_id).cloned().ok_or_else(|| {
        AppError::Parse(format!(
            "fiche champion Data Dragon sans entrée « {champion_id} »"
        ))
    })?;
    if detail.id.is_empty() {
        detail.id = champion_id.to_string();
    }
    Ok(detail)
}

/// Nom de fichier de l'icône d'un sort, si le nom fourni par Riot est sûr.
pub fn spell_icon_file(spell: &RawSpell) -> Option<String> {
    is_safe_file_name(&spell.image.full).then(|| spell.image.full.clone())
}

/// Nom de fichier de l'icône d'un passif, si le nom fourni par Riot est sûr.
pub fn passive_icon_file(passive: &RawPassive) -> Option<String> {
    is_safe_file_name(&passive.image.full).then(|| passive.image.full.clone())
}

/// Conversion des statistiques brutes vers le contrat (valeurs exactes Riot).
///
/// `spellblock` est exposé sous le nom `magicResist` côté contrat.
pub fn champion_stats_from_raw(stats: &RawChampionStats) -> ChampionStats {
    ChampionStats {
        hp: stats.hp,
        hp_per_level: stats.hp_per_level,
        mp: stats.mp,
        mp_per_level: stats.mp_per_level,
        armor: stats.armor,
        armor_per_level: stats.armor_per_level,
        magic_resist: stats.spellblock,
        magic_resist_per_level: stats.magic_resist_per_level,
        attack_damage: stats.attack_damage,
        attack_damage_per_level: stats.attack_damage_per_level,
        attack_speed: stats.attack_speed,
        attack_speed_per_level: stats.attack_speed_per_level,
        move_speed: stats.move_speed,
        attack_range: stats.attack_range,
        hp_regen: stats.hp_regen,
        mp_regen: stats.mp_regen,
    }
}

/// Conversion d'un sort brut : description nettoyée du HTML, champs « burn »
/// conservés tels quels (paliers), ordre Data Dragon préservé.
pub fn champion_spell_from_raw(spell: &RawSpell, icon_path: Option<String>) -> ChampionSpell {
    ChampionSpell {
        id: spell.id.clone(),
        name: spell.name.clone(),
        description: strip_html(&spell.description),
        cooldown: spell.cooldown_burn.clone(),
        cost: spell.cost_burn.clone(),
        cost_type: spell.cost_type.clone(),
        range: spell.range_burn.clone(),
        icon_path,
    }
}

/// Conversion d'un passif brut : description nettoyée du HTML.
pub fn champion_passive_from_raw(
    passive: &RawPassive,
    icon_path: Option<String>,
) -> ChampionPassive {
    ChampionPassive {
        name: passive.name.clone(),
        description: strip_html(&passive.description),
        icon_path,
    }
}

/// Entrée brute de `item.json`.
#[derive(Debug, Deserialize, Default)]
struct RawItem {
    #[serde(default)]
    name: String,
    #[serde(default)]
    plaintext: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    gold: RawGold,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    maps: BTreeMap<String, bool>,
    #[serde(default)]
    image: RawImage,
    #[serde(default, deserialize_with = "deserialize_item_stats")]
    stats: Vec<ItemStat>,
    /// Niveau de recette, absent pour la majorité des objets.
    #[serde(default)]
    depth: Option<u32>,
    /// Vendu en boutique (`inStore`), absent pour la majorité des objets.
    #[serde(default, rename = "inStore")]
    in_store: Option<bool>,
    /// Consommable (`consumed`), absent pour la majorité des objets.
    #[serde(default)]
    consumed: Option<bool>,
    /// Identifiants Data Dragon des composants de la recette, ordre Riot.
    #[serde(default)]
    from: Vec<String>,
    /// Identifiants Data Dragon des objets de transformation, ordre Riot.
    #[serde(default)]
    into: Vec<String>,
}

/// Bloc `gold` de `item.json`. Le top-level `purchasable` n'existe pas dans
/// Data Dragon : l'achatabilité est portée par `gold.purchasable`.
#[derive(Debug, Deserialize, Default)]
struct RawGold {
    #[serde(default)]
    base: f64,
    #[serde(default)]
    sell: f64,
    #[serde(default)]
    total: f64,
    #[serde(default)]
    purchasable: bool,
}

#[derive(Debug, Deserialize)]
struct ItemFile {
    data: BTreeMap<String, RawItem>,
}

/// Décode `stats` d'un objet en conservant l'ordre du JSON et en écartant les
/// valeurs nulles. Les clés Riot sont conservées telles quelles.
fn deserialize_item_stats<'de, D>(deserializer: D) -> Result<Vec<ItemStat>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    struct StatsVisitor;

    impl<'de> Visitor<'de> for StatsVisitor {
        type Value = Vec<ItemStat>;

        fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
            formatter.write_str("un objet de statistiques numériques Data Dragon")
        }

        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            let mut stats = Vec::new();
            while let Some((cle, valeur)) = map.next_entry::<String, serde_json::Value>()? {
                if let Some(valeur) = valeur.as_f64() {
                    if valeur != 0.0 {
                        stats.push(ItemStat {
                            key: cle,
                            value: valeur,
                        });
                    }
                }
            }
            Ok(stats)
        }
    }

    deserializer.deserialize_map(StatsVisitor)
}

/// Objet analysé, avant résolution du chemin d'icône.
struct ParsedItem {
    item: Item,
    image_file: Option<String>,
}

/// Analyse `item.json` et applique le filtre de `get_items` (objets réels
/// nommés — tous maps —, identifiant numérique).
fn parse_item_entries(bytes: &[u8]) -> AppResult<Vec<ParsedItem>> {
    let file: ItemFile = serde_json::from_slice(bytes)
        .map_err(|err| AppError::parse("item.json Data Dragon invalide", err))?;

    let mut entries = Vec::new();
    for (cle, brut) in file.data {
        // Objets réels : nom renseigné et identifiant numérique.
        if brut.name.trim().is_empty() || cle.parse::<u32>().is_err() {
            continue;
        }
        let image_file = is_safe_file_name(&brut.image.full).then(|| brut.image.full.clone());
        entries.push(ParsedItem {
            item: Item {
                id: cle,
                name: brut.name,
                plain_text: brut.plaintext,
                description: strip_html(&brut.description),
                gold_total: prix_or(brut.gold.total),
                gold_base: prix_or(brut.gold.base),
                gold_sell: prix_or(brut.gold.sell),
                purchasable: brut.gold.purchasable,
                tags: brut.tags,
                on_summoners_rift: brut.maps.get("11").copied().unwrap_or(false),
                depth: brut.depth,
                in_store: brut.in_store,
                consumed: brut.consumed,
                from: brut.from,
                into: brut.into,
                icon_path: None,
                stats: brut.stats,
            },
            image_file,
        });
    }
    entries.sort_by(|a, b| {
        a.item
            .name
            .to_lowercase()
            .cmp(&b.item.name.to_lowercase())
            .then_with(|| a.item.name.cmp(&b.item.name))
            .then_with(|| a.item.id.cmp(&b.item.id))
    });
    Ok(entries)
}

/// Parse `item.json` : tous les objets réels nommés, triés par nom.
///
/// Le drapeau `on_summoners_rift` reflète `maps["11"]` mais ne filtre pas : les
/// 859 objets de `get_items` restent exposés (contrat V0.2). L'icône n'est pas
/// résolue ici (voir [`parse_items_with_icons`]).
pub fn parse_items(bytes: &[u8]) -> AppResult<Vec<Item>> {
    Ok(parse_item_entries(bytes)?
        .into_iter()
        .map(|entry| entry.item)
        .collect())
}

/// Parse `item.json` en résolvant les icônes via le cache de l'appelant.
///
/// La fermeture reçoit le nom de fichier `image.full` (déjà vérifié sans
/// séparateur ni `..`) et renvoie le chemin absolu si le PNG local est valide.
pub fn parse_items_with_icons<F>(bytes: &[u8], icon: F) -> AppResult<Vec<Item>>
where
    F: Fn(&str) -> Option<String>,
{
    Ok(parse_item_entries(bytes)?
        .into_iter()
        .map(|mut entry| {
            entry.item.icon_path = entry.image_file.and_then(|fichier| icon(&fichier));
            entry.item
        })
        .collect())
}

/// Noms de fichiers `image.full` uniques des objets de `get_items`.
///
/// Sert à télécharger les icônes d'objets pendant la synchronisation ; les noms
/// insûrs (séparateur, `..`) sont ignorés.
pub fn item_icon_files(bytes: &[u8]) -> AppResult<Vec<String>> {
    let mut vus = HashSet::new();
    let mut fichiers = Vec::new();
    for entry in parse_item_entries(bytes)? {
        if let Some(fichier) = entry.image_file {
            if vus.insert(fichier.clone()) {
                fichiers.push(fichier);
            }
        }
    }
    Ok(fichiers)
}

/// Convertit un prix d'or Data Dragon en entier non négatif (0 si absent).
///
/// Le JSON peut contenir des nombres à virgule ; on arrondit sans inventer.
fn prix_or(valeur: f64) -> u32 {
    if valeur.is_finite() && valeur > 0.0 {
        valeur.round() as u32
    } else {
        0
    }
}

/// Arbre de runes brut de `runesReforged.json`.
#[derive(Debug, Deserialize, Default)]
struct RawRuneTree {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    key: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    icon: String,
    #[serde(default)]
    slots: Vec<RawSlot>,
}

#[derive(Debug, Deserialize, Default)]
struct RawSlot {
    #[serde(default)]
    runes: Vec<RawRune>,
}

#[derive(Debug, Deserialize, Default)]
struct RawRune {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    key: String,
    #[serde(default)]
    name: String,
    #[serde(default, rename = "shortDesc")]
    short_desc: String,
    #[serde(default, rename = "longDesc")]
    long_desc: String,
    #[serde(default)]
    icon: String,
}

fn parse_rune_tree_file(bytes: &[u8]) -> AppResult<Vec<RawRuneTree>> {
    serde_json::from_slice(bytes)
        .map_err(|err| AppError::parse("runesReforged.json Data Dragon invalide", err))
}

/// Parse `runesReforged.json` (en_US) en aplatissant les runes de chaque palier.
///
/// L'ordre Data Dragon est conservé ; `slot` est l'index du palier dans `slots`.
/// `localized_*` et `icon_path` restent `None` : la localisation est fusionnée
/// par [`apply_rune_localization`] et les chemins locaux résolus par l'appelant.
pub fn parse_rune_trees(bytes: &[u8]) -> AppResult<Vec<RuneTree>> {
    let bruts = parse_rune_tree_file(bytes)?;

    let mut arbres = Vec::with_capacity(bruts.len());
    for brut in bruts {
        let mut runes = Vec::new();
        for (slot, palier) in brut.slots.into_iter().enumerate() {
            for rune in palier.runes {
                runes.push(Rune {
                    id: rune.id,
                    key: rune.key,
                    name: rune.name,
                    short_desc: rune.short_desc,
                    long_desc: strip_html(&rune.long_desc),
                    localized_name: None,
                    localized_short_desc: None,
                    localized_long_desc: None,
                    icon: rune.icon,
                    icon_path: None,
                    slot: slot as u32,
                });
            }
        }
        arbres.push(RuneTree {
            id: brut.id,
            key: brut.key,
            name: brut.name,
            localized_name: None,
            icon: brut.icon,
            icon_path: None,
            runes,
        });
    }
    Ok(arbres)
}

/// Localisation officielle `fr_FR` des runes, indexée par identifiant Riot.
#[derive(Debug, Clone, Default)]
pub struct RuneLocalization {
    trees: HashMap<u32, String>,
    runes: HashMap<u32, LocalizedRune>,
}

/// Nom et descriptions localisés d'une rune.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalizedRune {
    pub name: String,
    /// Description courte nettoyée du HTML Data Dragon.
    pub short_desc: String,
    /// Description longue nettoyée du HTML, `None` si Data Dragon ne la fournit pas.
    pub long_desc: Option<String>,
}

/// Parse le fichier `runesReforged.json` d'une locale (`fr_FR`).
///
/// Les arbres et runes sont indexés par id ; les entrées sans nom sont ignorées.
/// Les descriptions sont nettoyées du HTML via [`strip_html`].
pub fn parse_runes_localization(bytes: &[u8]) -> AppResult<RuneLocalization> {
    let bruts = parse_rune_tree_file(bytes)?;

    let mut localization = RuneLocalization::default();
    for arbre in bruts {
        if !arbre.name.trim().is_empty() {
            localization.trees.insert(arbre.id, arbre.name);
        }
        for palier in arbre.slots {
            for rune in palier.runes {
                if rune.name.trim().is_empty() {
                    continue;
                }
                let long_desc = strip_html(&rune.long_desc);
                localization.runes.insert(
                    rune.id,
                    LocalizedRune {
                        name: rune.name,
                        short_desc: strip_html(&rune.short_desc),
                        long_desc: (!long_desc.is_empty()).then_some(long_desc),
                    },
                );
            }
        }
    }
    Ok(localization)
}

/// Fusionne la localisation `fr_FR` dans les arbres en_US (par id).
///
/// Les champs en_US (`name`, `short_desc`, `long_desc`) sont conservés ; seuls
/// les champs `localized_*` sont renseignés, et restent `None` quand l'id (ou la
/// donnée correspondante) est absent de la localisation.
pub fn apply_rune_localization(trees: &mut [RuneTree], localization: &RuneLocalization) {
    for arbre in trees {
        arbre.localized_name = localization.trees.get(&arbre.id).cloned();
        for rune in &mut arbre.runes {
            if let Some(traduction) = localization.runes.get(&rune.id) {
                rune.localized_name = Some(traduction.name.clone());
                rune.localized_short_desc = Some(traduction.short_desc.clone());
                rune.localized_long_desc = traduction.long_desc.clone();
            }
        }
    }
}

/// Icônes relatives uniques (arbres + runes) d'un `runesReforged.json`.
#[derive(Debug, Clone, Default)]
pub struct RuneIconList {
    /// Chemins relatifs valides et uniques, dans l'ordre Data Dragon.
    pub files: Vec<String>,
    /// Nombre de chemins fournis par Riot mais refusés par la validation.
    pub rejected: usize,
}

/// Liste les icônes relatives (arbres + runes) à mettre en cache.
pub fn rune_icon_files(bytes: &[u8]) -> AppResult<RuneIconList> {
    let bruts = parse_rune_tree_file(bytes)?;

    let mut vus = HashSet::new();
    let mut fichiers = Vec::new();
    let mut rejetes = 0usize;
    let mut ajouter = |icone: &str, vus: &mut HashSet<String>, fichiers: &mut Vec<String>| {
        if !is_valid_icon_rel_path(icone) {
            rejetes += 1;
            return;
        }
        if vus.insert(icone.to_string()) {
            fichiers.push(icone.to_string());
        }
    };

    for arbre in &bruts {
        ajouter(&arbre.icon, &mut vus, &mut fichiers);
        for palier in &arbre.slots {
            for rune in &palier.runes {
                ajouter(&rune.icon, &mut vus, &mut fichiers);
            }
        }
    }

    Ok(RuneIconList {
        files: fichiers,
        rejected: rejetes,
    })
}

// ---------------------------------------------------------------------------
// Nettoyage du HTML des descriptions.
// ---------------------------------------------------------------------------

/// Retire les balises HTML/Data Dragon et décode les entités de base.
///
/// Data Dragon utilise surtout des balises de mise en forme (`<mainText>`,
/// `<attention>`, `<speed>`, …) et `<br>` pour les sauts de ligne : les balises
/// sont retirées, `<br>` devient une espace, puis les espaces sont normalisés.
pub fn strip_html(input: &str) -> String {
    let mut sans_balises = String::with_capacity(input.len());
    let mut reste = input;

    loop {
        let Some(debut) = reste.find('<') else {
            sans_balises.push_str(reste);
            break;
        };
        sans_balises.push_str(&reste[..debut]);

        let Some(fin_relatif) = reste[debut..].find('>') else {
            // Balise non terminée : on conserve le texte tel quel plutôt que de le perdre.
            sans_balises.push_str(&reste[debut..]);
            break;
        };

        let nom = &reste[debut + 1..debut + fin_relatif];
        let nom = nom.trim().trim_start_matches('/');
        if nom.eq_ignore_ascii_case("br") || nom.eq_ignore_ascii_case("br/") {
            sans_balises.push(' ');
        }
        reste = &reste[debut + fin_relatif + 1..];
    }

    let decode = decode_html_entities(&sans_balises);
    decode.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Décode les entités HTML de base (`&amp;`, `&lt;`, `&nbsp;`, `&#39;`, `&#x27;`, …).
fn decode_html_entities(input: &str) -> String {
    let mut sortie = String::with_capacity(input.len());
    let mut caracteres = input.char_indices().peekable();

    while let Some((index, caractere)) = caracteres.next() {
        if caractere != '&' {
            sortie.push(caractere);
            continue;
        }

        let reste = &input[index + 1..];
        let fin = match reste.find(';') {
            Some(fin) if fin <= 12 => fin,
            _ => {
                sortie.push('&');
                continue;
            }
        };

        let entite = &reste[..fin];
        let decode = match entite {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" | "#39" | "#x27" | "#X27" => Some('\''),
            "nbsp" => Some(' '),
            _ => decode_numeric_entity(entite),
        };

        match decode {
            Some(caractere) => {
                sortie.push(caractere);
                // Avance au-delà du « ; » de l'entité.
                let consomme = index + 1 + fin + 1;
                while let Some((prochain, _)) = caracteres.peek().copied() {
                    if prochain < consomme {
                        caracteres.next();
                    } else {
                        break;
                    }
                }
            }
            None => sortie.push('&'),
        }
    }

    sortie
}

/// Décode une entité numérique (`&#8217;` ou `&#x2019;`).
fn decode_numeric_entity(entite: &str) -> Option<char> {
    let chiffres = entite.strip_prefix('#')?;
    let valeur = if let Some(hexadecimal) = chiffres
        .strip_prefix('x')
        .or_else(|| chiffres.strip_prefix('X'))
    {
        u32::from_str_radix(hexadecimal, 16).ok()?
    } else {
        chiffres.parse::<u32>().ok()?
    };
    char::from_u32(valeur).filter(|c| !c.is_control())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_des_versions_et_traversal() {
        for version in ["16.21.1", "15.1.1", "1", "16.21.1-alpha"] {
            validate_version(version).unwrap_or_else(|err| panic!("« {version} » refusée : {err}"));
        }
        for version in [
            "",
            ".",
            "..",
            "../16.21.1",
            "16/21/1",
            "16\\21\\1",
            "16 21 1",
            "16.21.1\n",
            "<script>",
            &"1".repeat(64),
        ] {
            assert!(
                matches!(validate_version(version), Err(AppError::InvalidVersion(_))),
                "« {version} » aurait dû être refusée"
            );
        }
    }

    #[test]
    fn parse_versions_prend_la_premiere_version() {
        let bytes = br#"["16.21.1", "16.20.1", "16.19.1"]"#;
        assert_eq!(parse_versions(bytes).expect("versions valides"), "16.21.1");

        assert!(parse_versions(br#"["../etc/passwd"]"#).is_err());
        assert!(parse_versions(br#"[]"#).is_err());
        assert!(parse_versions(br#"{"versions": []}"#).is_err());
        assert!(parse_versions(b"pas du json").is_err());
    }

    const CHAMPIONS_JSON: &str = r#"{
        "data": {
            "Ahri": {
                "id": "Ahri",
                "key": "103",
                "name": "Ahri",
                "title": "la Renarde à neuf queues",
                "tags": ["Mage", "Assassin"],
                "image": { "full": "Ahri.png" }
            },
            "Zed": {
                "id": "Zed",
                "key": "238",
                "name": "Zed",
                "title": "le Maître des ombres",
                "tags": ["Assassin"],
                "image": { "full": "" }
            },
            "SansNom": { "key": "999", "name": "", "image": { "full": "Rien.png" } }
        }
    }"#;

    #[test]
    fn parsing_champions_et_repli_d_icone() {
        let champions = parse_champions(CHAMPIONS_JSON.as_bytes()).expect("champions");
        assert_eq!(champions.len(), 2, "entrée sans nom ignorée");

        let zed = champions
            .iter()
            .find(|champion| champion.id == "Zed")
            .expect("Zed présent");
        assert_eq!(champion_icon_file(zed).as_deref(), Some("Zed.png"));
        assert_eq!(zed.key, "238");
        assert_eq!(zed.title, "le Maître des ombres");
        assert_eq!(zed.tags, vec!["Assassin".to_string()]);

        let ahri = champions
            .iter()
            .find(|champion| champion.id == "Ahri")
            .expect("Ahri présent");
        assert_eq!(champion_icon_file(ahri).as_deref(), Some("Ahri.png"));

        // Nom de fichier dangereux : repli sur l'identifiant.
        let piege = RawChampion {
            id: "Zed".to_string(),
            image: RawImage {
                full: "../evil.png".to_string(),
            },
            ..RawChampion::default()
        };
        assert_eq!(champion_icon_file(&piege).as_deref(), Some("Zed.png"));

        // Identifiant lui-même dangereux : aucune icône possible.
        let inexploitable = RawChampion {
            id: "../evil".to_string(),
            image: RawImage {
                full: "/etc/passwd".to_string(),
            },
            ..RawChampion::default()
        };
        assert_eq!(champion_icon_file(&inexploitable), None);
    }

    const ITEMS_JSON: &str = r#"{
        "data": {
            "1001": {
                "name": "Bottes de vitesse",
                "plaintext": "Vitesse de déplacement",
                "description": "<mainText>+<speed>25</speed> vitesse &amp; détails<br>suite</mainText>",
                "gold": { "base": 300, "sell": 210, "total": 300, "purchasable": true },
                "tags": ["Boots"],
                "maps": { "11": true, "12": false },
                "image": { "full": "1001.png" },
                "depth": 1,
                "inStore": true,
                "consumed": false,
                "stats": {
                    "FlatMovementSpeedMod": 25,
                    "PercentMovementSpeedMod": 0,
                    "FlatHPPoolMod": 150.5
                }
            },
            "1002": {
                "name": "",
                "description": "objet sans nom",
                "maps": { "11": true }
            },
            "1003": {
                "name": "Épée longue",
                "description": "<i>dégâts</i> physiques &lt;brut&gt;",
                "gold": { "base": 350.0, "sell": 245.0, "total": 350.0, "purchasable": true },
                "tags": ["Damage"],
                "maps": { "11": false },
                "image": { "full": "1003.png" },
                "stats": { "FlatPhysicalDamageMod": 10 }
            },
            "1004": {
                "name": "Bottes de vitesse alternatives",
                "description": "",
                "gold": { "total": 300 },
                "maps": { "11": true },
                "image": { "full": "1001.png" },
                "stats": {}
            },
            "EPIC": {
                "name": "Objet épique",
                "description": "id non numérique",
                "maps": { "11": true }
            }
        }
    }"#;

    #[test]
    fn parsing_items_filtre_et_nettoie() {
        let items = parse_items(ITEMS_JSON.as_bytes()).expect("objets");
        assert_eq!(
            items.len(),
            3,
            "objets sans nom ou sans id numérique exclus"
        );

        let bottes = items
            .iter()
            .find(|item| item.id == "1001")
            .expect("Bottes de vitesse");
        assert_eq!(bottes.name, "Bottes de vitesse");
        assert_eq!(bottes.plain_text, "Vitesse de déplacement");
        assert_eq!(bottes.description, "+25 vitesse & détails suite");
        assert_eq!(bottes.gold_total, 300);
        assert_eq!(bottes.gold_base, 300);
        assert_eq!(bottes.gold_sell, 210);
        assert!(bottes.purchasable, "purchasable vient de gold.purchasable");
        assert_eq!(bottes.depth, Some(1));
        assert_eq!(bottes.in_store, Some(true));
        assert_eq!(bottes.consumed, Some(false));
        assert!(bottes.from.is_empty());
        assert!(bottes.into.is_empty());
        assert_eq!(bottes.tags, vec!["Boots".to_string()]);
        assert!(bottes.on_summoners_rift);
        assert_eq!(bottes.icon_path, None, "icône résolue par l'appelant");
        assert_eq!(bottes.stats.len(), 2, "statistiques nulles exclues");
        assert_eq!(bottes.stats[0].key, "FlatMovementSpeedMod");
        assert_eq!(bottes.stats[0].value, 25.0);
        assert_eq!(bottes.stats[1].key, "FlatHPPoolMod");
        assert_eq!(bottes.stats[1].value, 150.5);

        let epee = items
            .iter()
            .find(|item| item.id == "1003")
            .expect("Épée longue");
        assert_eq!(epee.description, "dégâts physiques <brut>");
        assert_eq!(epee.gold_total, 350, "total d'or à virgule arrondi");
        assert_eq!(epee.gold_base, 350);
        assert_eq!(epee.gold_sell, 245);
        assert!(epee.purchasable);
        assert_eq!(epee.depth, None, "depth absent → None");
        assert_eq!(epee.in_store, None, "inStore absent → None");
        assert_eq!(epee.consumed, None, "consumed absent → None");
        assert!(!epee.on_summoners_rift, "map 11 absente/fausse");
        assert_eq!(epee.stats.len(), 1);
        assert_eq!(epee.stats[0].key, "FlatPhysicalDamageMod");
        assert_eq!(epee.stats[0].value, 10.0);

        // Objet partageant l'icône d'un autre objet : conserve aussi son image.
        let alternatives = items
            .iter()
            .find(|item| item.id == "1004")
            .expect("Bottes alternatives");
        assert!(alternatives.on_summoners_rift);
        assert!(alternatives.stats.is_empty());
        assert_eq!(alternatives.gold_base, 0, "prix absents → 0");
        assert_eq!(alternatives.gold_sell, 0);
        assert!(!alternatives.purchasable, "achatabilité absente → false");
        assert_eq!(alternatives.depth, None);
        assert_eq!(alternatives.in_store, None);
        assert_eq!(alternatives.consumed, None);
        assert!(alternatives.from.is_empty());
        assert!(alternatives.into.is_empty());
    }

    /// Mini `item.json` avec recettes réelles (Infinity Edge / B.F. Sword).
    const RECIPE_ITEMS_JSON: &str = r#"{
        "data": {
            "3031": {
                "name": "Infinity Edge",
                "description": "<mainText>Critique</mainText>",
                "from": ["1038", "1037", "1018"],
                "gold": { "base": 725, "sell": 2450, "total": 3500, "purchasable": true },
                "tags": ["CriticalStrike", "Damage"],
                "maps": { "11": true },
                "depth": 2,
                "image": { "full": "3031.png" },
                "stats": { "FlatCritChanceMod": 0.25 }
            },
            "1038": {
                "name": "B. F. Sword",
                "description": "<mainText>Dégâts</mainText>",
                "into": ["3031", "3026", "3031"],
                "gold": { "base": 1300, "sell": 910, "total": 1300, "purchasable": true },
                "tags": ["Damage"],
                "maps": { "11": true },
                "image": { "full": "1038.png" },
                "stats": { "FlatPhysicalDamageMod": 40 }
            },
            "7000": {
                "name": "Objet minimal",
                "description": "",
                "from": ["1038", "1038"],
                "maps": { "11": false }
            }
        }
    }"#;

    #[test]
    fn parsing_recettes_gold_et_champs_optionnels() {
        let items = parse_items(RECIPE_ITEMS_JSON.as_bytes()).expect("objets recettes");
        assert_eq!(items.len(), 3);

        let infinity = items
            .iter()
            .find(|item| item.id == "3031")
            .expect("Infinity Edge");
        assert_eq!(infinity.gold_total, 3500);
        assert_eq!(infinity.gold_base, 725);
        assert_eq!(infinity.gold_sell, 2450);
        assert!(infinity.purchasable);
        assert_eq!(infinity.depth, Some(2));
        assert_eq!(infinity.in_store, None, "inStore absent → None");
        assert_eq!(infinity.consumed, None, "consumed absent → None");
        assert_eq!(
            infinity.from,
            vec!["1038".to_string(), "1037".to_string(), "1018".to_string()],
            "ordre Riot conservé"
        );
        assert!(infinity.into.is_empty(), "objet final : into vide");
        assert_eq!(infinity.description, "Critique");
        assert!(infinity.on_summoners_rift);

        let epee = items
            .iter()
            .find(|item| item.id == "1038")
            .expect("B. F. Sword");
        assert!(epee.from.is_empty(), "composant de base : from vide");
        assert_eq!(
            epee.into,
            vec!["3031".to_string(), "3026".to_string(), "3031".to_string()],
            "ordre Riot conservé et doublons conservés"
        );
        assert!(epee.into.contains(&"3031".to_string()));
        assert_eq!(epee.depth, None);
        assert_eq!(epee.gold_total, 1300);
        assert_eq!(epee.gold_base, 1300);
        assert_eq!(epee.gold_sell, 910);

        let minimal = items
            .iter()
            .find(|item| item.id == "7000")
            .expect("Objet minimal");
        assert_eq!(minimal.gold_total, 0);
        assert_eq!(minimal.gold_base, 0);
        assert_eq!(minimal.gold_sell, 0);
        assert!(!minimal.purchasable);
        assert_eq!(minimal.depth, None);
        assert_eq!(minimal.in_store, None);
        assert_eq!(minimal.consumed, None);
        assert_eq!(minimal.from, vec!["1038".to_string(), "1038".to_string()]);
        assert!(minimal.into.is_empty());
    }

    #[test]
    fn resolution_icones_objets_et_noms_uniques() {
        let items = parse_items_with_icons(ITEMS_JSON.as_bytes(), |image_file| {
            Some(format!("C:/cache/img/item/{image_file}"))
        })
        .expect("objets avec icônes");

        let bottes = items.iter().find(|item| item.id == "1001").expect("Bottes");
        assert_eq!(
            bottes.icon_path.as_deref(),
            Some("C:/cache/img/item/1001.png")
        );
        let alternatives = items
            .iter()
            .find(|item| item.id == "1004")
            .expect("Alternatives");
        assert_eq!(
            alternatives.icon_path.as_deref(),
            Some("C:/cache/img/item/1001.png")
        );

        // Liste unique des fichiers d'icônes à télécharger.
        let fichiers = item_icon_files(ITEMS_JSON.as_bytes()).expect("fichiers d'icônes");
        assert_eq!(
            fichiers,
            vec!["1001.png".to_string(), "1003.png".to_string()]
        );
    }

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
                        "description": "<mainText>Inflige <magicDamage>30/40/50/60/70</magicDamage> dégâts.</mainText>",
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
                    "description": "<mainText>Inflige <physicalDamage>5/8/11</physicalDamage> % des PV max.</mainText>",
                    "image": { "full": "Aatrox_Passive.png" }
                }
            }
        }
    }"#;

    #[test]
    fn parsing_fiche_champion_complete() {
        let brut = parse_champion_detail(CHAMPION_DETAIL_JSON.as_bytes(), "Aatrox")
            .expect("fiche champion");

        assert_eq!(brut.id, "Aatrox");
        assert_eq!(brut.key, "266");
        assert_eq!(brut.name, "Aatrox");
        assert_eq!(brut.title, "l'Épée des Darkin");
        assert_eq!(brut.tags, vec!["Fighter".to_string(), "Tank".to_string()]);
        assert!(brut.blurb.contains("Aatrox"));

        // Statistiques exactes : `spellblock` devient `magicResist`.
        let stats = champion_stats_from_raw(&brut.stats);
        assert_eq!(stats.hp, 650.0);
        assert_eq!(stats.hp_per_level, 114.0);
        assert_eq!(stats.mp, 0.0);
        assert_eq!(stats.mp_per_level, 0.0);
        assert_eq!(stats.armor, 38.0);
        assert_eq!(stats.armor_per_level, 4.45);
        assert_eq!(stats.magic_resist, 32.0);
        assert_eq!(stats.magic_resist_per_level, 2.05);
        assert_eq!(stats.attack_damage, 60.0);
        assert_eq!(stats.attack_damage_per_level, 5.0);
        assert_eq!(stats.attack_speed, 0.651);
        assert_eq!(stats.attack_speed_per_level, 2.5);
        assert_eq!(stats.move_speed, 345.0);
        assert_eq!(stats.attack_range, 175.0);
        assert_eq!(stats.hp_regen, 3.0);
        assert_eq!(stats.mp_regen, 0.0);

        // 4 sorts dans l'ordre Q/W/E/R, champs « burn » conservés, HTML nettoyé.
        assert_eq!(brut.spells.len(), 4);
        let sorts: Vec<ChampionSpell> = brut
            .spells
            .iter()
            .map(|sort| champion_spell_from_raw(sort, None))
            .collect();
        assert_eq!(
            sorts
                .iter()
                .map(|sort| sort.id.as_str())
                .collect::<Vec<_>>(),
            vec!["AatroxQ", "AatroxW", "AatroxE", "AatroxR"]
        );
        assert_eq!(sorts[0].cooldown, "14/12/10/8/6");
        assert_eq!(sorts[0].cost, "0");
        assert_eq!(sorts[0].cost_type, "Aucun coût");
        assert_eq!(sorts[0].range, "650");
        assert_eq!(sorts[0].description, "Premier coup : 10/25/40/55/70");
        assert_eq!(sorts[2].description, "Dash & soin.");
        assert_eq!(
            sorts[3].description,
            "Transforme Aatrox. Gagne de la vitesse."
        );
        assert!(sorts.iter().all(|sort| sort.icon_path.is_none()));

        // Passif : description nettoyée et nom d'icône sûr.
        let passif = brut.passive.as_ref().expect("passif");
        assert_eq!(passif.name, "Posture du seigneur de guerre");
        assert_eq!(
            passive_icon_file(passif).as_deref(),
            Some("Aatrox_Passive.png")
        );
        let passif_converti = champion_passive_from_raw(passif, Some("C:/cache/p.png".to_string()));
        assert_eq!(passif_converti.description, "Inflige 5/8/11 % des PV max.");
        assert_eq!(passif_converti.icon_path.as_deref(), Some("C:/cache/p.png"));

        // Le nom de fichier d'icône d'un sort est validé.
        assert_eq!(
            spell_icon_file(&brut.spells[0]).as_deref(),
            Some("AatroxQ.png")
        );

        // Une fiche dont la clé ne correspond pas est refusée.
        assert!(parse_champion_detail(CHAMPION_DETAIL_JSON.as_bytes(), "Ahri").is_err());
        assert!(parse_champion_detail(b"{}", "Aatrox").is_err());
    }

    #[test]
    fn validation_des_identifiants_de_champion() {
        for id in ["Aatrox", "Ahri", "Kai'Sa", "KogMaw", "MonkeyKing"] {
            assert!(is_valid_champion_id(id), "« {id} » devrait être valide");
        }
        for id in [
            "",
            ".",
            "..",
            "../Aatrox",
            "Aatrox/../../etc",
            "a\\b",
            "a:b",
            "a*b",
            "a?b",
            "a\"b",
            "a<b",
            "a>b",
            "a|b",
            "Aatrox\n",
            "Aatrox ",
            "Aätrox",
            &"A".repeat(65),
        ] {
            assert!(!is_valid_champion_id(id), "« {id} » aurait dû être refusé");
        }
    }

    #[test]
    fn parsing_runes_aplatit_les_paliers() {
        let json = r#"[
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
                                "shortDesc": "description 1",
                                "longDesc": "Longue <mainText>description &amp; <b>détail</b>",
                                "icon": "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png"
                            }
                        ]
                    },
                    {
                        "runes": [
                            {
                                "id": 9101,
                                "key": "AbsorbLife",
                                "name": "Absorption de vie",
                                "shortDesc": "description 2",
                                "icon": "perk-images/Styles/Precision/AbsorbLife/AbsorbLife.png"
                            },
                            {
                                "id": 9111,
                                "key": "Triumph",
                                "name": "Triomphe",
                                "shortDesc": "description 3",
                                "icon": "perk-images/Styles/Precision/Triumph/Triumph.png"
                            }
                        ]
                    }
                ]
            }
        ]"#;

        let arbres = parse_rune_trees(json.as_bytes()).expect("runes");
        assert_eq!(arbres.len(), 1);
        let arbre = &arbres[0];
        assert_eq!(arbre.id, 8000);
        assert_eq!(arbre.key, "Precision");
        assert_eq!(arbre.name, "Précision");
        assert_eq!(arbre.localized_name, None);
        assert_eq!(arbre.icon, "perk-images/Styles/7201_Precision.png");
        assert_eq!(arbre.icon_path, None);
        assert_eq!(arbre.runes.len(), 3);
        assert_eq!(arbre.runes[0].slot, 0);
        assert_eq!(arbre.runes[0].id, 8005);
        assert_eq!(arbre.runes[0].localized_name, None);
        assert_eq!(arbre.runes[0].localized_short_desc, None);
        assert_eq!(arbre.runes[0].localized_long_desc, None);
        assert_eq!(arbre.runes[0].icon_path, None);
        assert_eq!(
            arbre.runes[0].long_desc, "Longue description & détail",
            "longDesc en_US nettoyée du HTML"
        );
        assert_eq!(
            arbre.runes[1].long_desc, "",
            "longDesc absent → chaîne vide"
        );
        assert_eq!(arbre.runes[1].slot, 1);
        assert_eq!(arbre.runes[2].slot, 1);
        assert_eq!(arbre.runes[2].name, "Triomphe");

        assert!(parse_rune_trees(b"{}").is_err());
    }

    const RUNES_EN: &str = r#"[
        {
            "id": 8000,
            "name": "Precision",
            "icon": "perk-images/Styles/7201_Precision.png",
            "slots": [
                {
                    "runes": [
                        { "id": 8005, "name": "Press the Attack", "shortDesc": "Basic attacks mark the target.", "longDesc": "<mainText>EN long <b>bold</b> one<br>two</mainText>", "icon": "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png" },
                        { "id": 8014, "name": "Coup de Grace", "shortDesc": "Deal more damage to low health targets.", "icon": "perk-images/Styles/Precision/CoupDeGrace/CoupDeGrace.png" }
                    ]
                },
                {
                    "runes": [
                        { "id": 8010, "name": "Conqueror", "shortDesc": "Basic attacks grant stacks.", "longDesc": "Basic attacks or spells grant stacks of <font color='#48C4B7'>Adaptive Force</font>.<br><br>When fully stacked, heal for 8% of the damage you deal to champions.", "icon": "perk-images/Styles/Precision/Conqueror/Conqueror.png" }
                    ]
                }
            ]
        },
        {
            "id": 8400,
            "name": "Resolve",
            "icon": "perk-images/Styles/7204_Resolve.png",
            "slots": [
                {
                    "runes": [
                        { "id": 8437, "name": "Grasp of the Undying", "shortDesc": "Empowers your next attack.", "icon": "perk-images/Styles/Resolve/GraspOfTheUndying/GraspOfTheUndying.png" }
                    ]
                }
            ]
        }
    ]"#;

    const RUNES_FR: &str = r#"[
        {
            "id": 8000,
            "name": "Précision",
            "icon": "perk-images/Styles/7201_Precision.png",
            "slots": [
                {
                    "runes": [
                        { "id": 8005, "name": "Attaque soutenue", "shortDesc": "<mainText>Les attaques de base <physicalDamage>marquent</physicalDamage> la cible.</mainText>", "icon": "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png" },
                        { "id": 8014, "name": "Coup de grâce", "shortDesc": "<mainText>Inflige plus de dégâts aux cibles à PV bas &amp; plus.</mainText>", "longDesc": "<mainText>Description FR <i>longue</i><br>sur deux lignes.</mainText>", "icon": "perk-images/Styles/Precision/CoupDeGrace/CoupDeGrace.png" },
                        { "id": 8010, "name": "Conquérant", "shortDesc": "<mainText>Gagnez de la force adaptative.</mainText>", "longDesc": "<mainText>Les attaques génèrent 2 effets de <font color='#48C4B7'>force adaptative</font>.<br><br>Au maximum, soignez 8% des dégâts infligés aux champions.</mainText>", "icon": "perk-images/Styles/Precision/Conqueror/Conqueror.png" }
                    ]
                }
            ]
        },
        {
            "id": 8400,
            "name": "Volonté",
            "icon": "perk-images/Styles/7204_Resolve.png",
            "slots": []
        }
    ]"#;

    #[test]
    fn fusion_long_descriptions_fr_par_id() {
        let mut arbres = parse_rune_trees(RUNES_EN.as_bytes()).expect("runes en_US");
        let localisation = parse_runes_localization(RUNES_FR.as_bytes()).expect("runes fr_FR");
        apply_rune_localization(&mut arbres, &localisation);

        let precision = arbres
            .iter()
            .find(|arbre| arbre.id == 8000)
            .expect("arbre Précision");

        // 8005 : longDesc en_US nettoyée ; fr_FR fournit short/name mais pas longDesc.
        let soutenue = precision
            .runes
            .iter()
            .find(|rune| rune.id == 8005)
            .expect("rune 8005");
        assert_eq!(
            soutenue.long_desc, "EN long bold one two",
            "longDesc en_US nettoyée (<br> → espace)"
        );
        assert_eq!(soutenue.localized_name.as_deref(), Some("Attaque soutenue"));
        assert_eq!(
            soutenue.localized_short_desc.as_deref(),
            Some("Les attaques de base marquent la cible.")
        );
        assert_eq!(
            soutenue.localized_long_desc, None,
            "longDesc fr_FR absent → None (pas de valeur inventée)"
        );

        // 8014 : longDesc en_US absent → vide ; longDesc fr_FR nettoyée.
        let coup = precision
            .runes
            .iter()
            .find(|rune| rune.id == 8014)
            .expect("rune 8014");
        assert_eq!(coup.long_desc, "", "longDesc en_US absent → vide");
        assert_eq!(
            coup.localized_long_desc.as_deref(),
            Some("Description FR longue sur deux lignes.")
        );

        // 8010 : localisation FR avec longDesc contenant du balisage.
        let conquerant = precision
            .runes
            .iter()
            .find(|rune| rune.id == 8010)
            .expect("rune 8010");
        assert!(
            conquerant.long_desc.contains("Adaptive Force"),
            "longDesc en_US conservé"
        );
        assert!(!conquerant.long_desc.contains('<'));
        assert!(conquerant
            .localized_long_desc
            .as_deref()
            .unwrap_or("")
            .contains("force adaptative"));
        assert!(
            !conquerant
                .localized_long_desc
                .as_deref()
                .unwrap_or("")
                .contains('<'),
            "localized longDesc fr nettoyée"
        );

        // 8437 : rune présente en_US mais absente de la localisation fr_FR.
        let volonte = arbres
            .iter()
            .find(|arbre| arbre.id == 8400)
            .expect("arbre Resolve");
        assert_eq!(volonte.runes[0].id, 8437);
        assert_eq!(volonte.runes[0].localized_name, None);
        assert_eq!(volonte.runes[0].localized_short_desc, None);
        assert_eq!(volonte.runes[0].localized_long_desc, None);
    }

    #[test]
    fn fusion_localisation_fr_par_id() {
        let mut arbres = parse_rune_trees(RUNES_EN.as_bytes()).expect("runes en_US");
        let localisation = parse_runes_localization(RUNES_FR.as_bytes()).expect("runes fr_FR");
        apply_rune_localization(&mut arbres, &localisation);

        assert_eq!(arbres.len(), 2);

        // Arbre localisé par id, en_US conservé.
        let precision = arbres
            .iter()
            .find(|arbre| arbre.id == 8000)
            .expect("arbre Précision");
        assert_eq!(precision.name, "Precision");
        assert_eq!(precision.localized_name.as_deref(), Some("Précision"));

        // Rune localisée : nom + description FR nettoyée du HTML.
        let soutenue = precision
            .runes
            .iter()
            .find(|rune| rune.id == 8005)
            .expect("rune 8005");
        assert_eq!(soutenue.name, "Press the Attack");
        assert_eq!(soutenue.short_desc, "Basic attacks mark the target.");
        assert_eq!(soutenue.localized_name.as_deref(), Some("Attaque soutenue"));
        assert_eq!(
            soutenue.localized_short_desc.as_deref(),
            Some("Les attaques de base marquent la cible.")
        );

        let coup = precision
            .runes
            .iter()
            .find(|rune| rune.id == 8014)
            .expect("rune 8014");
        assert_eq!(coup.localized_name.as_deref(), Some("Coup de grâce"));
        assert_eq!(
            coup.localized_short_desc.as_deref(),
            Some("Inflige plus de dégâts aux cibles à PV bas & plus.")
        );

        // Rune présente en_US mais absente de la localisation fr_FR.
        let volonte = arbres
            .iter()
            .find(|arbre| arbre.id == 8400)
            .expect("arbre Resolve");
        assert_eq!(volonte.runes[0].localized_name, None);
        assert_eq!(volonte.runes[0].localized_short_desc, None);
        assert_eq!(volonte.runes[0].localized_long_desc, None);

        // Fichier de localisation illisible → erreur (repli géré par l'appelant).
        assert!(parse_runes_localization(b"{}").is_err());
    }

    #[test]
    fn chemins_icones_runes_et_url_sans_version() {
        // Chemins relatifs valides.
        for icone in [
            "perk-images/Styles/7201_Precision.png",
            "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png",
            "a/b/c.png",
            "image.png",
            "a-b_c.d/e.f-g_h.png",
        ] {
            assert!(
                is_valid_icon_rel_path(icone),
                "« {icone} » devrait être valide"
            );
        }

        // Chemins refusés : absolu, traversal, séparateur Windows, segments vides,
        // caractères hors liste blanche, longueurs excessives.
        let chemin_long = format!("{}/x.png", "a".repeat(129));
        let trop_de_segments = (0..9)
            .map(|index| format!("s{index}"))
            .collect::<Vec<_>>()
            .join("/");
        for icone in [
            "",
            ".",
            "..",
            "../perk-images/x.png",
            "perk-images/../../../x.png",
            "/perk-images/Styles/x.png",
            "perk-images//x.png",
            "perk-images/Styles/x.png/",
            "perk-images\\Styles\\x.png",
            "C:/perk-images/x.png",
            "perk-images/Styles/x é.png",
            "perk-images/Styles/x%2e.png",
            "perk-images/Styles/..",
            &chemin_long,
            &trop_de_segments,
        ] {
            assert!(
                !is_valid_icon_rel_path(icone),
                "« {icone} » aurait dû être refusé"
            );
        }

        // URL des icônes de runes : volontairement SANS version (403 sinon).
        assert_eq!(
            rune_icon_url("perk-images/Styles/7201_Precision.png"),
            "https://ddragon.leagueoflegends.com/cdn/img/perk-images/Styles/7201_Precision.png"
        );
        // Fichier de localisation : URL versionnée, locale explicite.
        assert_eq!(
            localized_data_url("16.21.1", "fr_FR", "runesReforged.json"),
            "https://ddragon.leagueoflegends.com/cdn/16.21.1/data/fr_FR/runesReforged.json"
        );
    }

    #[test]
    fn liste_icones_runes_uniques_et_rejets() {
        let json = r#"[
            {
                "id": 8000,
                "name": "Precision",
                "icon": "a/Tree.png",
                "slots": [
                    {
                        "runes": [
                            { "id": 1, "name": "Rune 1", "shortDesc": "d", "icon": "a/Rune.png" },
                            { "id": 2, "name": "Rune 2", "shortDesc": "d", "icon": "a/Rune.png" },
                            { "id": 3, "name": "Rune 3", "shortDesc": "d", "icon": "../evil.png" }
                        ]
                    }
                ]
            },
            {
                "id": 8400,
                "name": "Resolve",
                "icon": "/abs/tree.png",
                "slots": []
            }
        ]"#;

        let liste = rune_icon_files(json.as_bytes()).expect("icônes de runes");
        assert_eq!(
            liste.files,
            vec!["a/Tree.png".to_string(), "a/Rune.png".to_string()]
        );
        assert_eq!(liste.rejected, 2, "icône rune ../evil + arbre absolu");
    }

    #[test]
    fn strip_html_retire_balises_et_decode_entites() {
        assert_eq!(
            strip_html("<mainText>+<speed>25</speed> vitesse</mainText>"),
            "+25 vitesse"
        );
        assert_eq!(
            strip_html("ligne 1<br>ligne 2<br/>ligne 3"),
            "ligne 1 ligne 2 ligne 3"
        );
        assert_eq!(
            strip_html("&amp; &lt; &gt; &quot; &#39; &apos; &nbsp; &#x41;"),
            "& < > \" ' ' A"
        );
        assert_eq!(strip_html("texte sans balise"), "texte sans balise");
    }

    #[test]
    fn urls_data_dragon() {
        assert_eq!(
            data_url("16.21.1", "champion.json"),
            "https://ddragon.leagueoflegends.com/cdn/16.21.1/data/en_US/champion.json"
        );
        assert_eq!(
            champion_icon_url("16.21.1", "Ahri.png"),
            "https://ddragon.leagueoflegends.com/cdn/16.21.1/img/champion/Ahri.png"
        );
        assert_eq!(
            item_icon_url("16.21.1", "1001.png"),
            "https://ddragon.leagueoflegends.com/cdn/16.21.1/img/item/1001.png"
        );
        assert_eq!(
            spell_icon_url("16.21.1", "AatroxQ.png"),
            "https://ddragon.leagueoflegends.com/cdn/16.21.1/img/spell/AatroxQ.png"
        );
        assert_eq!(
            passive_icon_url("16.21.1", "Aatrox_Passive.png"),
            "https://ddragon.leagueoflegends.com/cdn/16.21.1/img/passive/Aatrox_Passive.png"
        );
        assert_eq!(
            champion_detail_url("16.21.1", "Aatrox"),
            "https://ddragon.leagueoflegends.com/cdn/16.21.1/data/en_US/champion/Aatrox.json"
        );
        // Splash volontairement SANS version (l'URL versionnée renvoie 403).
        assert_eq!(
            splash_url("Aatrox"),
            "https://ddragon.leagueoflegends.com/cdn/img/champion/splash/Aatrox_0.jpg"
        );
    }

    #[test]
    fn signatures_png_et_jpeg() {
        assert!(is_png(b"\x89PNG\r\n\x1a\nreste"));
        assert!(!is_png(b"<html>"));
        assert!(!is_png(b""));
        assert!(!is_png(b"\xFF\xD8\xFF\xE0pas un png"));

        assert!(is_jpeg(b"\xFF\xD8\xFF\xE0reste"));
        assert!(!is_jpeg(b"\x89PNG\r\n\x1a\n"));
        assert!(!is_jpeg(b""));
    }
}
