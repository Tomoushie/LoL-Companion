//! Méta OP.GG via le serveur MCP public (V0.6).
//!
//! OP.GG expose un serveur MCP public (`https://mcp-api.op.gg/mcp`, Streamable
//! HTTP / JSON-RPC) : on initialise une session (`initialize` +
//! `notifications/initialized`), puis on appelle des outils (`tools/call`).
//! Les réponses sont du texte contenant un *repr Python* de classes
//! (`class X: a,b,c` puis `X(...)`) : un mini-parser générique reconstruit les
//! champs à partir des déclarations, sans ordre codé en dur.
//!
//! Aucune clé n'est nécessaire. Les données restent des données externes
//! réelles, mises en cache (tier list 6 h, build 12 h) et jamais inventées.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderMap, ACCEPT, CONTENT_TYPE};
use reqwest::StatusCode;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::cache::{self, Cache, CHAMPION_FILE};
use crate::ddragon;
use crate::error::{AppError, AppResult};
use crate::model::{
    MetaBuild, MetaItemBuild, MetaRunePage, MetaRunePages, MetaTierEntry, MetaTierList,
};

// ---------------------------------------------------------------------------
// Constantes.
// ---------------------------------------------------------------------------

/// Endpoint MCP public d'OP.GG.
const MCP_URL: &str = "https://mcp-api.op.gg/mcp";

/// Timeout d'une requête MCP.
const MCP_TIMEOUT: Duration = Duration::from_secs(25);

/// Intervalle minimal poli entre deux appels d'outil MCP.
const MCP_MIN_INTERVAL: Duration = Duration::from_secs(2);

/// TTL du cache de la tier list (6 h).
const TIER_TTL_MS: i64 = 6 * 60 * 60 * 1_000;

/// TTL du cache d'un build (12 h).
const BUILD_TTL_MS: i64 = 12 * 60 * 60 * 1_000;

/// TTL du cache des pages de runes (12 h).
const RUNES_TTL_MS: i64 = 12 * 60 * 60 * 1_000;

/// TTL du cache des libellés de fragments Community Dragon (7 jours).
const PERKS_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1_000;

/// Catalogue public Community Dragon des perks/fragments.
const COMMUNITY_PERKS_URL: &str =
    "https://raw.communitydragon.org/latest/plugins/rcp-be-lol-game-data/global/default/v1/perks.json";

/// Portées réelles demandées à OP.GG (3 pages de runes).
const RUNE_SCOPES: [&str; 3] = ["challenger", "grandmaster", "all"];

/// Champs demandés à OP.GG pour une page de runes.
const RUNES_OUTPUT_FIELDS: [&str; 3] = ["champion", "data.summary.average_stats", "data.runes"];

/// Sous-dossier du cache méta (sous la racine de cache Data Dragon).
const META_CACHE_SUBDIR: &str = "meta";

/// Source affichée dans les contrats.
const META_SOURCE: &str = "OP.GG MCP";

/// Positions OP.GG supportées (ordre d'affichage de la tier list).
const META_POSITIONS: [&str; 5] = ["top", "mid", "jungle", "adc", "support"];

/// Positions valides pour un build.
const BUILD_POSITIONS: [&str; 5] = ["top", "mid", "jungle", "adc", "support"];

/// Tags de rang acceptés pour un build.
const BUILD_TIERS: [&str; 2] = ["challenger", "all"];

/// Champs demandés à OP.GG pour la tier list (une entrée par position).
const TIER_OUTPUT_FIELDS: [&str; 5] = [
    "data.positions.top[]",
    "data.positions.mid[]",
    "data.positions.jungle[]",
    "data.positions.adc[]",
    "data.positions.support[]",
];

/// Champs demandés à OP.GG pour un build.
const BUILD_OUTPUT_FIELDS: [&str; 8] = [
    "champion",
    "data.summary.average_stats",
    "data.starter_items",
    "data.boots",
    "data.core_items",
    "data.fourth_items[]",
    "data.fifth_items[]",
    "data.sixth_items[]",
];

// ---------------------------------------------------------------------------
// Plateformes → slug OP.GG.
// ---------------------------------------------------------------------------

/// Convertit une plateforme Riot en (identifiant canonique, slug OP.GG).
pub(crate) fn region_slug(platform: &str) -> AppResult<(String, String)> {
    let plateforme = crate::riot::resolve_platform(platform)?;
    let slug = match plateforme.id.as_str() {
        "EUW1" => "euw",
        "EUNE1" => "eune",
        "TR1" => "tr",
        "RU" => "ru",
        "ME1" => "me",
        "NA1" => "na",
        "BR1" => "br",
        "LA1" => "lan",
        "LA2" => "las",
        "KR" => "kr",
        "JP1" => "jp",
        "OC1" => "oce",
        "PH2" => "ph",
        "SG2" => "sg",
        "TH2" => "th",
        "TW2" => "tw",
        "VN2" => "vn",
        _ => {
            return Err(AppError::InvalidId(format!(
                "plateforme OP.GG inconnue : « {} »",
                plateforme.id
            )))
        }
    };
    Ok((plateforme.id, slug.to_string()))
}

// ---------------------------------------------------------------------------
// Normalisation des champions.
// ---------------------------------------------------------------------------

/// Normalise un nom de champion en clé OP.GG `UPPER_SNAKE`.
///
/// Apostrophes retirées (`K'Sante` → `KSANTE`), séparateurs non alphanumériques
/// (espaces, points, `&`…) remplacés par `_` et séquences fusionnées
/// (`Dr. Mundo` → `DR_MUNDO`, `Nunu & Willump` → `NUNU_WILLUMP`).
pub(crate) fn normalize_champion_key(name: &str) -> String {
    let mut sortie = String::with_capacity(name.len());
    for caractere in name.chars() {
        if caractere.is_ascii_alphanumeric() {
            sortie.push(caractere.to_ascii_uppercase());
        } else if matches!(caractere, '\'' | '\u{2019}') {
            // Apostrophes supprimées sans séparateur.
        } else if !sortie.ends_with('_') {
            sortie.push('_');
        }
    }
    sortie.trim_matches('_').to_string()
}

/// Clé de comparaison insensible à la casse/ponctuation.
fn comparison_key(name: &str) -> String {
    name.chars()
        .filter(|caractere| caractere.is_ascii_alphanumeric())
        .map(|caractere| caractere.to_ascii_lowercase())
        .collect()
}

/// Champion résolu : nom Data Dragon (affichage) et clé OP.GG.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ResolvedChampion {
    pub display_name: String,
    pub opgg_key: String,
}

/// Charge les champions Data Dragon du cache (vide si cache absent/corrompu).
fn load_champions(cache: &Cache) -> Vec<ddragon::RawChampion> {
    let Ok(Some(version)) = cache.active_version() else {
        return Vec::new();
    };
    let Ok(bytes) = cache.read_data_file(&version, CHAMPION_FILE) else {
        return Vec::new();
    };
    ddragon::parse_champions(&bytes).unwrap_or_default()
}

/// Résout un identifiant/nom de champion vers le nom Data Dragon et la clé OP.GG.
pub(crate) fn resolve_champion(cache: &Cache, input: &str) -> AppResult<ResolvedChampion> {
    let recherche = input.trim();
    if recherche.is_empty() {
        return Err(AppError::InvalidId(
            "champion vide : renseignez un nom ou un identifiant Data Dragon.".to_string(),
        ));
    }
    let cible = comparison_key(recherche);
    let champions = load_champions(cache);
    if !cible.is_empty() {
        if let Some(champion) = champions.iter().find(|champion| {
            comparison_key(&champion.id) == cible || comparison_key(&champion.name) == cible
        }) {
            let cle = normalize_champion_key(&champion.name);
            if cle.is_empty() {
                return Err(AppError::InvalidId(format!(
                    "champion non normalisable pour OP.GG : « {recherche} »"
                )));
            }
            return Ok(ResolvedChampion {
                display_name: champion.name.clone(),
                opgg_key: cle,
            });
        }
    }
    let cle = normalize_champion_key(recherche);
    if cle.is_empty() {
        return Err(AppError::InvalidId(format!(
            "champion non normalisable pour OP.GG : « {recherche} »"
        )));
    }
    Ok(ResolvedChampion {
        display_name: recherche.to_string(),
        opgg_key: cle,
    })
}

/// Clé numérique Data Dragon d'un nom OP.GG (0 si introuvable).
fn champion_key_from_name(champions: &[ddragon::RawChampion], nom_opgg: &str) -> u32 {
    let cible = comparison_key(nom_opgg);
    if cible.is_empty() {
        return 0;
    }
    champions
        .iter()
        .find(|champion| comparison_key(&champion.name) == cible)
        .and_then(|champion| champion.key.parse::<u32>().ok())
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Parser du repr Python produit par OP.GG.
// ---------------------------------------------------------------------------

/// Valeur scalaire ou composite d'un repr Python.
#[derive(Debug, Clone, PartialEq)]
enum PyValue {
    Str(String),
    Int(i64),
    Float(f64),
    Bool(bool),
    None,
    List(Vec<PyValue>),
    Instance(PyInstance),
}

#[derive(Debug, Clone, PartialEq)]
struct PyInstance {
    class: String,
    args: Vec<PyValue>,
}

/// Repr Python parsé : déclarations de classes + instance racine.
#[derive(Debug, Clone, Default)]
struct PyRepr {
    classes: HashMap<String, Vec<String>>,
    root: Option<PyValue>,
}

impl PyRepr {
    /// Parse un texte MCP complet (déclarations `class X: a,b` + instance).
    fn parse(text: &str) -> AppResult<Self> {
        let mut parser = PyParser {
            input: text.as_bytes(),
            pos: 0,
        };
        let mut repr = PyRepr::default();
        loop {
            parser.skip_whitespace();
            if parser.is_eof() {
                break;
            }
            if parser.remaining().starts_with("class ") {
                parser.advance("class ".len())?;
                let class_name = parser.parse_identifier()?;
                parser.skip_whitespace();
                parser.expect(b':')?;
                let ligne = parser.take_until_newline();
                let champs: Vec<String> = ligne
                    .split(',')
                    .map(|champ| champ.trim().to_string())
                    .filter(|champ| !champ.is_empty())
                    .collect();
                if class_name.is_empty() {
                    return Err(parser.erreur("déclaration de classe vide"));
                }
                repr.classes.insert(class_name, champs);
            } else {
                let value = parser.parse_value()?;
                parser.skip_whitespace();
                if !parser.is_eof() {
                    return Err(parser.erreur("contenu inattendu après l'instance racine"));
                }
                repr.root = Some(value);
                break;
            }
        }
        let root = repr
            .root
            .take()
            .ok_or_else(|| AppError::parse("repr OP.GG vide", "aucune instance racine"))?;
        Ok(PyRepr {
            classes: repr.classes,
            root: Some(root),
        })
    }

    fn fields(&self, class: &str) -> Option<&[String]> {
        self.classes.get(class).map(Vec::as_slice)
    }

    fn root(&self) -> AppResult<&PyValue> {
        self.root
            .as_ref()
            .ok_or_else(|| AppError::parse("repr OP.GG vide", "instance racine absente"))
    }
}

impl PyValue {
    fn field(&self, repr: &PyRepr, nom: &str) -> Option<&PyValue> {
        let PyValue::Instance(instance) = self else {
            return None;
        };
        let champs = repr.fields(&instance.class)?;
        let index = champs.iter().position(|champ| champ == nom)?;
        instance.args.get(index)
    }

    fn as_instance(&self, class: &str) -> Option<&PyInstance> {
        match self {
            PyValue::Instance(instance) if instance.class == class => Some(instance),
            _ => None,
        }
    }

    fn as_str(&self) -> Option<&str> {
        match self {
            PyValue::Str(valeur) => Some(valeur),
            _ => None,
        }
    }

    fn as_i64(&self) -> Option<i64> {
        match self {
            PyValue::Int(valeur) => Some(*valeur),
            PyValue::Float(valeur) if valeur.is_finite() => Some(*valeur as i64),
            _ => None,
        }
    }

    fn as_f64(&self) -> Option<f64> {
        match self {
            PyValue::Int(valeur) => Some(*valeur as f64),
            PyValue::Float(valeur) => Some(*valeur),
            _ => None,
        }
    }

    fn as_list(&self) -> Option<&[PyValue]> {
        match self {
            PyValue::List(valeurs) => Some(valeurs),
            _ => None,
        }
    }
}

/// Accès de champ typés (valeurs absentes → valeurs par défaut explicites).
fn field_str(value: &PyValue, repr: &PyRepr, nom: &str) -> Option<String> {
    value
        .field(repr, nom)
        .and_then(PyValue::as_str)
        .map(str::to_string)
}

fn field_u32(value: &PyValue, repr: &PyRepr, nom: &str) -> u32 {
    value
        .field(repr, nom)
        .and_then(PyValue::as_i64)
        .map(|valeur| valeur.clamp(0, i64::from(u32::MAX)) as u32)
        .unwrap_or(0)
}

fn field_f64(value: &PyValue, repr: &PyRepr, nom: &str) -> f64 {
    value
        .field(repr, nom)
        .and_then(PyValue::as_f64)
        .filter(|valeur| valeur.is_finite())
        .unwrap_or(0.0)
}

/// Parseur récursif minimal du repr Python.
struct PyParser<'a> {
    input: &'a [u8],
    pos: usize,
}

impl<'a> PyParser<'a> {
    fn is_eof(&self) -> bool {
        self.pos >= self.input.len()
    }

    fn remaining(&self) -> &'a str {
        // L'entrée est de l'UTF-8 valide : découper à `pos` est sûr.
        std::str::from_utf8(&self.input[self.pos..]).unwrap_or_default()
    }

    fn advance(&mut self, count: usize) -> AppResult<()> {
        let nouveau = self.pos.saturating_add(count);
        if nouveau > self.input.len() {
            return Err(self.erreur("fin de flux inattendue"));
        }
        self.pos = nouveau;
        Ok(())
    }

    fn erreur(&self, message: &str) -> AppError {
        AppError::parse(
            "repr OP.GG illisible",
            format!("{message} (position {})", self.pos),
        )
    }

    fn skip_whitespace(&mut self) {
        while let Some(&octet) = self.input.get(self.pos) {
            if matches!(octet, b' ' | b'\t' | b'\r' | b'\n') {
                self.pos += 1;
            } else {
                break;
            }
        }
    }

    fn expect(&mut self, octet: u8) -> AppResult<()> {
        if self.input.get(self.pos) == Some(&octet) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.erreur(&format!("caractère « {} » attendu", octet as char)))
        }
    }

    fn peek(&self) -> Option<u8> {
        self.input.get(self.pos).copied()
    }

    fn parse_identifier(&mut self) -> AppResult<String> {
        let start = self.pos;
        while let Some(&octet) = self.input.get(self.pos) {
            if octet.is_ascii_alphanumeric() || octet == b'_' {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            return Err(self.erreur("identifiant attendu"));
        }
        Ok(String::from_utf8_lossy(&self.input[start..self.pos]).into_owned())
    }

    fn take_until_newline(&mut self) -> String {
        let start = self.pos;
        while let Some(&octet) = self.input.get(self.pos) {
            if octet == b'\n' {
                break;
            }
            self.pos += 1;
        }
        let ligne = String::from_utf8_lossy(&self.input[start..self.pos]).into_owned();
        if self.peek() == Some(b'\n') {
            self.pos += 1;
        }
        ligne
    }

    fn parse_value(&mut self) -> AppResult<PyValue> {
        self.skip_whitespace();
        match self.peek() {
            Some(b'"') | Some(b'\'') => self.parse_string().map(PyValue::Str),
            Some(b'[') => self.parse_sequence(b'[', b']').map(PyValue::List),
            Some(b'(') => self.parse_sequence(b'(', b')').map(PyValue::List),
            Some(b'-') | Some(b'0'..=b'9') => self.parse_number(),
            Some(octet) if octet.is_ascii_alphabetic() || octet == b'_' => {
                let identifiant = self.parse_identifier()?;
                match identifiant.as_str() {
                    "True" | "true" => Ok(PyValue::Bool(true)),
                    "False" | "false" => Ok(PyValue::Bool(false)),
                    "None" | "none" | "null" => Ok(PyValue::None),
                    classe => {
                        self.skip_whitespace();
                        self.expect(b'(')?;
                        let args = self.parse_arguments()?;
                        Ok(PyValue::Instance(PyInstance {
                            class: classe.to_string(),
                            args,
                        }))
                    }
                }
            }
            Some(octet) => Err(self.erreur(&format!("valeur inattendue « {} »", octet as char))),
            None => Err(self.erreur("valeur attendue")),
        }
    }

    fn parse_arguments(&mut self) -> AppResult<Vec<PyValue>> {
        let mut args = Vec::new();
        loop {
            self.skip_whitespace();
            if self.peek() == Some(b')') {
                self.pos += 1;
                break;
            }
            args.push(self.parse_value()?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(b')') => {
                    self.pos += 1;
                    break;
                }
                _ => return Err(self.erreur("virgule ou parenthèse fermante attendue")),
            }
        }
        Ok(args)
    }

    fn parse_sequence(&mut self, ouverture: u8, fermeture: u8) -> AppResult<Vec<PyValue>> {
        self.expect(ouverture)?;
        let mut valeurs = Vec::new();
        loop {
            self.skip_whitespace();
            if self.peek() == Some(fermeture) {
                self.pos += 1;
                break;
            }
            valeurs.push(self.parse_value()?);
            self.skip_whitespace();
            match self.peek() {
                Some(b',') => {
                    self.pos += 1;
                }
                Some(octet) if octet == fermeture => {
                    self.pos += 1;
                    break;
                }
                _ => {
                    return Err(self.erreur("virgule ou fermeture de liste attendue"));
                }
            }
        }
        Ok(valeurs)
    }

    fn parse_number(&mut self) -> AppResult<PyValue> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        while let Some(&octet) = self.input.get(self.pos) {
            if octet.is_ascii_digit()
                || matches!(octet, b'.' | b'e' | b'E')
                || ((octet == b'+' || octet == b'-')
                    && matches!(self.input.get(self.pos.wrapping_sub(1)), Some(b'e' | b'E')))
            {
                self.pos += 1;
            } else {
                break;
            }
        }
        if self.pos == start {
            return Err(self.erreur("nombre attendu"));
        }
        let texte = String::from_utf8_lossy(&self.input[start..self.pos]).into_owned();
        if !texte.contains('.') && !texte.contains('e') && !texte.contains('E') {
            texte
                .parse::<i64>()
                .map(PyValue::Int)
                .map_err(|_| self.erreur("entier invalide"))
        } else {
            let valeur = texte
                .parse::<f64>()
                .map_err(|_| self.erreur("nombre flottant invalide"))?;
            if !valeur.is_finite() {
                return Err(self.erreur("nombre flottant invalide"));
            }
            Ok(PyValue::Float(valeur))
        }
    }

    fn parse_string(&mut self) -> AppResult<String> {
        let quote = self.peek().ok_or_else(|| self.erreur("chaîne attendue"))?;
        self.pos += 1;
        let mut octets: Vec<u8> = Vec::new();
        loop {
            let octet = self
                .peek()
                .ok_or_else(|| self.erreur("chaîne non terminée"))?;
            if octet == quote {
                self.pos += 1;
                break;
            }
            if octet == b'\\' {
                self.pos += 1;
                let echappe = self
                    .peek()
                    .ok_or_else(|| self.erreur("échappement non terminé"))?;
                self.pos += 1;
                match echappe {
                    b'n' => octets.push(b'\n'),
                    b'r' => octets.push(b'\r'),
                    b't' => octets.push(b'\t'),
                    b'0' => octets.push(0),
                    b'\\' => octets.push(b'\\'),
                    b'\'' => octets.push(b'\''),
                    b'"' => octets.push(b'"'),
                    b'x' => {
                        let hex = self.take_hex(2)?;
                        octets.push(u8::try_from(hex).unwrap_or(0));
                    }
                    b'u' => {
                        let hex = self.take_hex(4)?;
                        let caractere = char::from_u32(hex)
                            .ok_or_else(|| self.erreur("échappement unicode invalide"))?;
                        let mut buffer = [0u8; 4];
                        octets.extend_from_slice(caractere.encode_utf8(&mut buffer).as_bytes());
                    }
                    autre => octets.push(autre),
                }
            } else {
                octets.push(octet);
                self.pos += 1;
            }
        }
        String::from_utf8(octets).map_err(|_| self.erreur("chaîne non UTF-8"))
    }

    fn take_hex(&mut self, digits: usize) -> AppResult<u32> {
        let start = self.pos;
        let end = start.saturating_add(digits);
        if end > self.input.len() {
            return Err(self.erreur("échappement hexadécimal tronqué"));
        }
        let texte = std::str::from_utf8(&self.input[start..end])
            .map_err(|_| self.erreur("échappement hexadécimal invalide"))?;
        let valeur = u32::from_str_radix(texte, 16)
            .map_err(|_| self.erreur("échappement hexadécimal invalide"))?;
        self.pos = end;
        Ok(valeur)
    }
}

// ---------------------------------------------------------------------------
// Structures extraites du repr.
// ---------------------------------------------------------------------------

/// Entrée brute de tier list (avant mapping Data Dragon).
#[derive(Debug, Clone, PartialEq)]
struct TierRow {
    champion: String,
    position: String,
    tier: u32,
    rank: u32,
    win_rate: f64,
    pick_rate: f64,
    ban_rate: f64,
    kda: f64,
    play: u32,
    role_rate: f64,
}

/// Build brut extrait du repr.
#[derive(Debug, Clone, Default, PartialEq)]
struct BuildRows {
    average: Option<AverageRow>,
    starter: Vec<ItemRow>,
    boots: Vec<ItemRow>,
    core: Vec<ItemRow>,
    fourth: Vec<ItemRow>,
    fifth: Vec<ItemRow>,
    sixth: Vec<ItemRow>,
}

#[derive(Debug, Clone, PartialEq)]
struct AverageRow {
    play: u32,
    win_rate: f64,
    pick_rate: f64,
    ban_rate: f64,
    tier: u32,
    rank: u32,
}

#[derive(Debug, Clone, PartialEq)]
struct ItemRow {
    ids: Vec<u32>,
    names: Vec<String>,
    play: u32,
    win: u32,
    pick_rate: f64,
}

/// Extrait les entrées de tier list d'un repr parsé.
fn tier_rows_from_repr(repr: &PyRepr) -> AppResult<Vec<TierRow>> {
    let root = repr.root()?;
    let data = root
        .field(repr, "data")
        .ok_or_else(|| AppError::parse("tier list OP.GG", "champ data absent"))?;
    let positions = data
        .field(repr, "positions")
        .ok_or_else(|| AppError::parse("tier list OP.GG", "champ positions absent"))?;

    let mut rows = Vec::new();
    for position in META_POSITIONS {
        let Some(entrees) = positions.field(repr, position) else {
            continue;
        };
        let Some(entrees) = entrees.as_list() else {
            continue;
        };
        for entree in entrees {
            let Some(champion) = field_str(entree, repr, "champion") else {
                continue;
            };
            if champion.trim().is_empty() {
                continue;
            }
            rows.push(TierRow {
                champion,
                position: position.to_string(),
                tier: field_u32(entree, repr, "tier"),
                rank: field_u32(entree, repr, "rank"),
                win_rate: field_f64(entree, repr, "win_rate"),
                pick_rate: field_f64(entree, repr, "pick_rate"),
                ban_rate: field_f64(entree, repr, "ban_rate"),
                kda: field_f64(entree, repr, "kda"),
                play: field_u32(entree, repr, "play"),
                role_rate: field_f64(entree, repr, "role_rate"),
            });
        }
    }
    Ok(rows)
}

fn item_row_from_value(value: &PyValue, repr: &PyRepr) -> Option<ItemRow> {
    value.as_instance("CoreItems")?;
    let ids = value
        .field(repr, "ids")
        .and_then(PyValue::as_list)
        .map(|liste| {
            liste
                .iter()
                .filter_map(PyValue::as_i64)
                .filter(|valeur| *valeur >= 0 && *valeur <= i64::from(u32::MAX))
                .map(|valeur| valeur as u32)
                .collect()
        })
        .unwrap_or_default();
    let names = value
        .field(repr, "ids_names")
        .and_then(PyValue::as_list)
        .map(|liste| {
            liste
                .iter()
                .filter_map(PyValue::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default();
    Some(ItemRow {
        ids,
        names,
        play: field_u32(value, repr, "play"),
        win: field_u32(value, repr, "win"),
        pick_rate: field_f64(value, repr, "pick_rate"),
    })
}

fn items_from_field(data: &PyValue, repr: &PyRepr, nom: &str) -> Vec<ItemRow> {
    let Some(valeur) = data.field(repr, nom) else {
        return Vec::new();
    };
    match valeur {
        PyValue::Instance(_) => item_row_from_value(valeur, repr).into_iter().collect(),
        PyValue::List(liste) => liste
            .iter()
            .filter_map(|element| item_row_from_value(element, repr))
            .collect(),
        _ => Vec::new(),
    }
}

/// Extrait un build d'un repr parsé.
fn build_rows_from_repr(repr: &PyRepr) -> AppResult<BuildRows> {
    let root = repr.root()?;
    let data = root
        .field(repr, "data")
        .ok_or_else(|| AppError::parse("build OP.GG", "champ data absent"))?;
    let average = data
        .field(repr, "summary")
        .and_then(|summary| summary.field(repr, "average_stats"))
        .filter(|average| average.as_instance("AverageStats").is_some())
        .map(|average| AverageRow {
            play: field_u32(average, repr, "play"),
            win_rate: field_f64(average, repr, "win_rate"),
            pick_rate: field_f64(average, repr, "pick_rate"),
            ban_rate: field_f64(average, repr, "ban_rate"),
            tier: field_u32(average, repr, "tier"),
            rank: field_u32(average, repr, "rank"),
        });

    Ok(BuildRows {
        average,
        starter: items_from_field(data, repr, "starter_items"),
        boots: items_from_field(data, repr, "boots"),
        core: items_from_field(data, repr, "core_items"),
        fourth: items_from_field(data, repr, "fourth_items"),
        fifth: items_from_field(data, repr, "fifth_items"),
        sixth: items_from_field(data, repr, "sixth_items"),
    })
}

fn item_row_to_build(row: ItemRow) -> MetaItemBuild {
    MetaItemBuild {
        ids: row.ids,
        names: row.names,
        pick_rate: row.pick_rate,
        games: row.play,
        wins: row.win,
    }
}

/// Mappe les entrées brutes vers le contrat, avec les clés Data Dragon.
fn tier_entries_from_rows(
    rows: Vec<TierRow>,
    champions: &[ddragon::RawChampion],
) -> Vec<MetaTierEntry> {
    rows.into_iter()
        .map(|row| MetaTierEntry {
            champion_key: champion_key_from_name(champions, &row.champion),
            champion_name: row.champion,
            position: row.position,
            tier: row.tier,
            rank: row.rank,
            win_rate: row.win_rate,
            pick_rate: row.pick_rate,
            ban_rate: row.ban_rate,
            kda: row.kda,
            play: row.play,
            role_rate: row.role_rate,
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Client MCP partagé.
// ---------------------------------------------------------------------------

/// Réponse HTTP brute du serveur MCP.
struct McpHttpResponse {
    status: StatusCode,
    headers: HeaderMap,
    body: String,
}

/// Client MCP (session JSON-RPC + throttle poli), partagé par tout le processus.
struct McpClient {
    http: reqwest::Client,
    session: Mutex<Option<String>>,
    last_call: Mutex<Option<Instant>>,
    request_id: AtomicU64,
}

impl McpClient {
    fn new() -> Self {
        let http = reqwest::Client::builder()
            .timeout(MCP_TIMEOUT)
            .user_agent(concat!("LoL BOT/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            http,
            session: Mutex::new(None),
            last_call: Mutex::new(None),
            request_id: AtomicU64::new(1),
        }
    }

    fn next_id(&self) -> u64 {
        self.request_id.fetch_add(1, Ordering::Relaxed)
    }

    fn session_snapshot(&self) -> Option<String> {
        self.session
            .lock()
            .unwrap_or_else(|empoisonne| empoisonne.into_inner())
            .clone()
    }

    fn store_session(&self, session: String) {
        *self
            .session
            .lock()
            .unwrap_or_else(|empoisonne| empoisonne.into_inner()) = Some(session);
    }

    fn invalidate_session(&self, session: &str) {
        let mut guard = self
            .session
            .lock()
            .unwrap_or_else(|empoisonne| empoisonne.into_inner());
        if guard.as_deref() == Some(session) {
            *guard = None;
        }
    }

    /// Respecte un intervalle minimal entre deux appels d'outil MCP.
    async fn throttle(&self) {
        let attente = {
            let guard = self
                .last_call
                .lock()
                .unwrap_or_else(|empoisonne| empoisonne.into_inner());
            match *guard {
                Some(dernier) => MCP_MIN_INTERVAL.saturating_sub(dernier.elapsed()),
                None => Duration::ZERO,
            }
        };
        if !attente.is_zero() {
            tokio::time::sleep(attente).await;
        }
        *self
            .last_call
            .lock()
            .unwrap_or_else(|empoisonne| empoisonne.into_inner()) = Some(Instant::now());
    }

    async fn post(
        &self,
        body: &serde_json::Value,
        session: Option<&str>,
    ) -> AppResult<McpHttpResponse> {
        let mut request = self
            .http
            .post(MCP_URL)
            .header(CONTENT_TYPE, "application/json")
            .header(ACCEPT, "application/json, text/event-stream")
            .json(body);
        if let Some(session) = session {
            request = request.header("Mcp-Session-Id", session);
        }
        let response = request
            .send()
            .await
            .map_err(|err| AppError::Network(format!("OP.GG MCP injoignable : {err}")))?;
        let status = response.status();
        let headers = response.headers().clone();
        let body = response.text().await.map_err(|err| {
            AppError::Network(format!(
                "lecture de la réponse OP.GG MCP impossible : {err}"
            ))
        })?;
        Ok(McpHttpResponse {
            status,
            headers,
            body,
        })
    }

    /// Initialise une session MCP et envoie `notifications/initialized`.
    async fn initialize(&self) -> AppResult<String> {
        let corps = json!({
            "jsonrpc": "2.0",
            "id": self.next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {
                    "name": "LoL BOT",
                    "version": env!("CARGO_PKG_VERSION")
                }
            }
        });
        let response = self.post(&corps, None).await?;
        if !response.status.is_success() {
            return Err(mcp_http_error("initialisation", &response));
        }
        let valeur = parse_jsonrpc_payload(&response.body).ok_or_else(|| {
            AppError::parse("réponse MCP illisible", "initialisation sans JSON-RPC")
        })?;
        if let Some(erreur) = valeur.get("error") {
            let message = erreur
                .get("message")
                .and_then(|message| message.as_str())
                .unwrap_or("erreur MCP inconnue");
            return Err(AppError::Network(format!(
                "OP.GG MCP (initialisation) : {message}"
            )));
        }
        let session = response
            .headers
            .get("mcp-session-id")
            .and_then(|valeur| valeur.to_str().ok())
            .map(str::to_string)
            .ok_or_else(|| {
                AppError::Network(
                    "OP.GG MCP n'a pas fourni d'identifiant de session (Mcp-Session-Id)."
                        .to_string(),
                )
            })?;

        let notification = json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        });
        let reponse = self.post(&notification, Some(&session)).await?;
        if !reponse.status.is_success() {
            return Err(mcp_http_error("notifications/initialized", &reponse));
        }
        Ok(session)
    }

    async fn ensure_session(&self) -> AppResult<String> {
        if let Some(session) = self.session_snapshot() {
            return Ok(session);
        }
        let session = self.initialize().await?;
        self.store_session(session.clone());
        Ok(session)
    }

    /// Appelle un outil MCP ; retente **une fois** avec une nouvelle session si
    /// la session courante est invalide.
    async fn call_tool(&self, name: &str, arguments: serde_json::Value) -> AppResult<String> {
        self.throttle().await;
        let mut derniere_erreur: Option<AppError> = None;
        for tentative in 0..2 {
            let session = self.ensure_session().await?;
            let corps = json!({
                "jsonrpc": "2.0",
                "id": self.next_id(),
                "method": "tools/call",
                "params": {
                    "name": name,
                    "arguments": arguments.clone()
                }
            });
            let response = self.post(&corps, Some(&session)).await?;
            if matches!(response.status.as_u16(), 400 | 404 | 410) {
                self.invalidate_session(&session);
                derniere_erreur = Some(mcp_http_error(name, &response));
                if tentative == 0 {
                    continue;
                }
                break;
            }
            if !response.status.is_success() {
                return Err(mcp_http_error(name, &response));
            }
            let valeur = parse_jsonrpc_payload(&response.body).ok_or_else(|| {
                AppError::parse(
                    "réponse OP.GG MCP illisible",
                    format!("JSON-RPC absent pour {name}"),
                )
            })?;
            if let Some(erreur) = valeur.get("error") {
                let message = erreur
                    .get("message")
                    .and_then(|message| message.as_str())
                    .unwrap_or("erreur MCP inconnue");
                let message_minuscule = message.to_ascii_lowercase();
                if tentative == 0
                    && (message_minuscule.contains("session")
                        || message_minuscule.contains("mcp-session"))
                {
                    self.invalidate_session(&session);
                    derniere_erreur =
                        Some(AppError::Network(format!("OP.GG MCP ({name}) : {message}")));
                    continue;
                }
                return Err(AppError::Network(format!("OP.GG MCP ({name}) : {message}")));
            }
            let texte = extract_mcp_text(&valeur).ok_or_else(|| {
                AppError::parse(
                    "réponse OP.GG MCP sans contenu",
                    format!("content textuel absent pour {name}"),
                )
            })?;
            return Ok(texte);
        }
        Err(derniere_erreur.unwrap_or_else(|| {
            AppError::Network(format!("OP.GG MCP : échec de l'appel « {name} »."))
        }))
    }
}

fn mcp_http_error(operation: &str, response: &McpHttpResponse) -> AppError {
    let code = response.status.as_u16();
    match code {
        429 => AppError::Network(format!(
            "OP.GG MCP : limite de requêtes atteinte (HTTP 429) lors de « {operation} » : réessayez plus tard."
        )),
        401 | 403 => AppError::Network(format!(
            "OP.GG MCP : accès refusé (HTTP {code}) lors de « {operation} »."
        )),
        code if (500..=599).contains(&code) => AppError::Network(format!(
            "OP.GG MCP : erreur serveur (HTTP {code}) lors de « {operation} »."
        )),
        _ => AppError::Network(format!(
            "OP.GG MCP : réponse HTTP {code} inattendue lors de « {operation} »."
        )),
    }
}

/// Extrait le premier contenu textuel d'une réponse `tools/call`.
fn extract_mcp_text(value: &serde_json::Value) -> Option<String> {
    let contenu = value
        .get("result")
        .and_then(|result| result.get("content"))
        .and_then(|contenu| contenu.as_array())?;
    contenu.iter().find_map(|element| {
        if element.get("type").and_then(|valeur| valeur.as_str()) == Some("text") {
            element
                .get("text")
                .and_then(|valeur| valeur.as_str())
                .map(str::to_string)
        } else {
            None
        }
    })
}

/// Récupère le JSON-RPC d'un corps de réponse JSON **ou** SSE.
fn parse_jsonrpc_payload(body: &str) -> Option<serde_json::Value> {
    let trimmed = body.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(valeur) = serde_json::from_str::<serde_json::Value>(trimmed) {
        if valeur.is_object() {
            return Some(valeur);
        }
    }
    let mut dernier = None;
    for ligne in body.lines() {
        let ligne = ligne.trim_start();
        let Some(donnees) = ligne.strip_prefix("data:") else {
            continue;
        };
        let donnees = donnees.trim();
        if donnees.is_empty() || donnees == "[DONE]" {
            continue;
        }
        if let Ok(valeur) = serde_json::from_str::<serde_json::Value>(donnees) {
            if valeur.is_object() {
                dernier = Some(valeur);
            }
        }
    }
    dernier
}

fn shared_mcp_client() -> Arc<McpClient> {
    static CLIENT: OnceLock<Arc<McpClient>> = OnceLock::new();
    Arc::clone(CLIENT.get_or_init(|| Arc::new(McpClient::new())))
}

// ---------------------------------------------------------------------------
// Cache méta.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MetaCacheEntry<T> {
    fetched_at_ms: i64,
    data: T,
}

fn meta_cache_root(cache_root: &Path) -> PathBuf {
    cache_root.join(META_CACHE_SUBDIR)
}

fn tier_cache_path(cache_root: &Path, slug: &str) -> PathBuf {
    meta_cache_root(cache_root)
        .join("tier")
        .join(format!("{slug}.json"))
}

fn build_cache_path(
    cache_root: &Path,
    slug: &str,
    tier: &str,
    champion_key: &str,
    position: &str,
) -> PathBuf {
    meta_cache_root(cache_root)
        .join("build")
        .join(slug)
        .join(tier)
        .join(format!("{champion_key}-{position}.json"))
}

fn read_meta_cache<T: DeserializeOwned>(path: &Path) -> Option<MetaCacheEntry<T>> {
    let bytes = std::fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_meta_cache<T: Serialize>(path: &Path, entry: &MetaCacheEntry<T>) -> AppResult<()> {
    let bytes =
        serde_json::to_vec(entry).map_err(|err| AppError::parse("encodage du cache méta", err))?;
    cache::write_bytes_atomic(path, &bytes)
}

fn is_fresh(fetched_at_ms: i64, ttl_ms: i64, now_ms: i64) -> bool {
    fetched_at_ms >= now_ms || now_ms.saturating_sub(fetched_at_ms) <= ttl_ms
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn rfc3339(ms: i64) -> String {
    chrono::DateTime::from_timestamp_millis(ms)
        .map(|date| date.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .unwrap_or_else(|| "date inconnue".to_string())
}

/// Charge une ressource méta depuis le cache frais, sinon via `fetch` ; en cas
/// d'échec, replie sur un cache même expiré avec warning explicite.
async fn load_meta_with_fallback<T, F, Fut>(
    path: PathBuf,
    ttl_ms: i64,
    now_ms_value: i64,
    fetch: F,
) -> AppResult<(T, bool, Option<String>)>
where
    T: Clone + Serialize + DeserializeOwned,
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<T>>,
{
    let cached = read_meta_cache::<T>(&path);
    if let Some(entry) = &cached {
        if is_fresh(entry.fetched_at_ms, ttl_ms, now_ms_value) {
            return Ok((entry.data.clone(), true, None));
        }
    }
    match fetch().await {
        Ok(data) => {
            let entry = MetaCacheEntry {
                fetched_at_ms: now_ms_value,
                data: data.clone(),
            };
            let warning = match write_meta_cache(&path, &entry) {
                Ok(()) => None,
                Err(err) => Some(format!(
                    "cache méta non enregistré ({}) : {err}",
                    path.display()
                )),
            };
            Ok((data, false, warning))
        }
        Err(err) => match cached {
            Some(entry) => Ok((
                entry.data,
                true,
                Some(format!(
                    "OP.GG MCP indisponible, données en cache datant de {} — {err}",
                    rfc3339(entry.fetched_at_ms)
                )),
            )),
            None => Err(err),
        },
    }
}

// ---------------------------------------------------------------------------
// Appels d'outils OP.GG.
// ---------------------------------------------------------------------------

async fn fetch_tier_rows() -> AppResult<Vec<TierRow>> {
    let arguments = json!({
        "position": "all",
        "lang": "en_US",
        "desired_output_fields": TIER_OUTPUT_FIELDS
    });
    let texte = shared_mcp_client()
        .call_tool("lol_list_lane_meta_champions", arguments)
        .await?;
    let repr = PyRepr::parse(&texte)?;
    tier_rows_from_repr(&repr)
}

async fn fetch_build_rows(champion_key: &str, position: &str, tier: &str) -> AppResult<BuildRows> {
    let arguments = json!({
        "game_mode": "ranked",
        "champion": champion_key,
        "position": position,
        "lang": "en_US",
        "tier": tier,
        "desired_output_fields": BUILD_OUTPUT_FIELDS
    });
    let texte = shared_mcp_client()
        .call_tool("lol_get_champion_analysis", arguments)
        .await?;
    let repr = PyRepr::parse(&texte)?;
    build_rows_from_repr(&repr)
}

// ---------------------------------------------------------------------------
// API publique.
// ---------------------------------------------------------------------------

fn normalize_position(position: &str) -> AppResult<String> {
    let position = position.trim().to_ascii_lowercase();
    if BUILD_POSITIONS.contains(&position.as_str()) {
        Ok(position)
    } else {
        Err(AppError::InvalidId(format!(
            "position OP.GG invalide : « {position} » (valeurs acceptées : top, mid, jungle, adc, support)."
        )))
    }
}

fn normalize_tier(tier: Option<&str>) -> AppResult<String> {
    match tier.map(str::trim).filter(|tier| !tier.is_empty()) {
        None => Ok("challenger".to_string()),
        Some(valeur) => {
            let valeur = valeur.to_ascii_lowercase();
            if BUILD_TIERS.contains(&valeur.as_str()) {
                Ok(valeur)
            } else {
                Err(AppError::InvalidId(format!(
                    "tier OP.GG invalide : « {valeur} » (valeurs acceptées : challenger, all)."
                )))
            }
        }
    }
}

/// Tier list méta OP.GG pour une plateforme donnée.
///
/// Cache `<cache>/meta/tier/<slug>.json` (6 h) ; en cas d'échec MCP, un cache
/// même expiré est servi avec un `warning` explicite.
pub async fn tier_list(cache: &Cache, platform: &str) -> AppResult<MetaTierList> {
    let (platform_id, slug) = region_slug(platform)?;
    let maintenant = now_ms();
    let path = tier_cache_path(cache.root(), &slug);

    if let Some(entry) = read_meta_cache::<MetaTierList>(&path) {
        if is_fresh(entry.fetched_at_ms, TIER_TTL_MS, maintenant) {
            let mut liste = entry.data;
            liste.from_cache = true;
            liste.warning = None;
            return Ok(liste);
        }
    }

    match fetch_tier_rows().await {
        Ok(rows) => {
            let champions = load_champions(cache);
            let entries = tier_entries_from_rows(rows, &champions);
            let liste = MetaTierList {
                platform: platform_id,
                region: slug,
                source: META_SOURCE.to_string(),
                fetched_at: rfc3339(maintenant),
                from_cache: false,
                entries,
                warning: None,
            };
            let mut resultat = liste.clone();
            if let Err(err) = write_meta_cache(
                &path,
                &MetaCacheEntry {
                    fetched_at_ms: maintenant,
                    data: liste,
                },
            ) {
                resultat.warning = Some(format!(
                    "cache méta non enregistré ({}) : {err}",
                    path.display()
                ));
            }
            Ok(resultat)
        }
        Err(err) => match read_meta_cache::<MetaTierList>(&path) {
            Some(entry) => {
                let mut liste = entry.data;
                liste.from_cache = true;
                liste.warning = Some(format!(
                    "OP.GG MCP indisponible, données en cache datant de {} — {err}",
                    rfc3339(entry.fetched_at_ms)
                ));
                Ok(liste)
            }
            None => Err(err),
        },
    }
}

/// Convertit les lignes de build en contrat `MetaBuild`.
#[allow(clippy::too_many_arguments)]
fn meta_build_from_rows(
    rows: BuildRows,
    champion: String,
    position: String,
    platform: String,
    region: String,
    tier: String,
    fetched_at: String,
) -> MetaBuild {
    let moyenne = rows.average.as_ref();
    MetaBuild {
        champion,
        position,
        platform,
        region,
        tier,
        source: META_SOURCE.to_string(),
        fetched_at,
        from_cache: false,
        win_rate: moyenne.map(|moyenne| moyenne.win_rate),
        pick_rate: moyenne.map(|moyenne| moyenne.pick_rate),
        ban_rate: moyenne.map(|moyenne| moyenne.ban_rate),
        games: moyenne.map(|moyenne| moyenne.play),
        tier_label: moyenne.map(|moyenne| moyenne.tier),
        rank: moyenne.map(|moyenne| moyenne.rank),
        starter: rows.starter.into_iter().map(item_row_to_build).collect(),
        boots: rows.boots.into_iter().map(item_row_to_build).collect(),
        core: rows.core.into_iter().map(item_row_to_build).collect(),
        fourth: rows.fourth.into_iter().map(item_row_to_build).collect(),
        fifth: rows.fifth.into_iter().map(item_row_to_build).collect(),
        sixth: rows.sixth.into_iter().map(item_row_to_build).collect(),
        warning: None,
    }
}

/// Builds méta OP.GG pour un champion, une position et un tiers donnés.
///
/// Cache `<cache>/meta/build/<slug>/<tier>/<CHAMPION>-<position>.json` (12 h) ;
/// en cas d'échec MCP, un cache même expiré est servi avec un `warning`.
pub async fn builds(
    cache: &Cache,
    champion: &str,
    position: &str,
    platform: &str,
    tier: Option<&str>,
) -> AppResult<MetaBuild> {
    let (platform_id, slug) = region_slug(platform)?;
    let position = normalize_position(position)?;
    let tier = normalize_tier(tier)?;
    let resolu = resolve_champion(cache, champion)?;
    let maintenant = now_ms();
    let path = build_cache_path(cache.root(), &slug, &tier, &resolu.opgg_key, &position);

    let champion_affiche = resolu.display_name.clone();
    let cle_opgg = resolu.opgg_key.clone();
    let platform_pour_fetch = platform_id.clone();
    let slug_pour_fetch = slug.clone();
    let position_pour_fetch = position.clone();
    let tier_pour_fetch = tier.clone();

    let (mut build, from_cache, warning) =
        load_meta_with_fallback(path, BUILD_TTL_MS, maintenant, || async move {
            let rows = fetch_build_rows(&cle_opgg, &position_pour_fetch, &tier_pour_fetch).await?;
            Ok(meta_build_from_rows(
                rows,
                champion_affiche,
                position_pour_fetch,
                platform_pour_fetch,
                slug_pour_fetch,
                tier_pour_fetch,
                rfc3339(now_ms()),
            ))
        })
        .await?;

    // Les champs d'identité proviennent de la requête (même clé de cache).
    build.champion = resolu.display_name;
    build.position = position;
    build.platform = platform_id;
    build.region = slug;
    build.tier = tier;
    build.from_cache = from_cache;
    build.warning = warning;
    Ok(build)
}

// ---------------------------------------------------------------------------
// Rune Builder (V0.7) — 3 pages OP.GG + fragments Community Dragon.
// ---------------------------------------------------------------------------

/// Page de runes brute extraite du repr OP.GG (classe `Runes`).
#[derive(Debug, Clone, PartialEq)]
struct RunesRow {
    primary_page_id: u32,
    primary_page_name: String,
    primary_rune_ids: Vec<u32>,
    primary_rune_names: Vec<String>,
    secondary_page_id: u32,
    secondary_page_name: String,
    secondary_rune_ids: Vec<u32>,
    secondary_rune_names: Vec<String>,
    stat_mod_ids: Vec<u32>,
    stat_mod_names: Vec<String>,
    play: u32,
    win: u32,
    pick_rate: f64,
}

/// Extrait la page de runes d'un repr `lol_get_champion_analysis`.
fn runes_from_repr(repr: &PyRepr) -> AppResult<RunesRow> {
    let root = repr.root()?;
    let data = root
        .field(repr, "data")
        .ok_or_else(|| AppError::parse("runes OP.GG", "champ data absent"))?;
    let runes = data
        .field(repr, "runes")
        .ok_or_else(|| AppError::parse("runes OP.GG", "champ data.runes absent"))?;
    if runes.as_instance("Runes").is_none() {
        return Err(AppError::parse(
            "runes OP.GG",
            "instance Runes absente de la réponse",
        ));
    }
    Ok(RunesRow {
        primary_page_id: field_u32(runes, repr, "primary_page_id"),
        primary_page_name: field_str(runes, repr, "primary_page_name").unwrap_or_default(),
        primary_rune_ids: field_u32_list(runes, repr, "primary_rune_ids"),
        primary_rune_names: field_name_list(runes, repr, "primary_rune_names"),
        secondary_page_id: field_u32(runes, repr, "secondary_page_id"),
        secondary_page_name: field_str(runes, repr, "secondary_page_name").unwrap_or_default(),
        secondary_rune_ids: field_u32_list(runes, repr, "secondary_rune_ids"),
        secondary_rune_names: field_name_list(runes, repr, "secondary_rune_names"),
        stat_mod_ids: field_u32_list(runes, repr, "stat_mod_ids"),
        stat_mod_names: field_name_list(runes, repr, "stat_mod_names"),
        play: field_u32(runes, repr, "play"),
        win: field_u32(runes, repr, "win"),
        pick_rate: field_f64(runes, repr, "pick_rate"),
    })
}

/// Liste d'entiers positifs d'un champ (ids Riot).
fn field_u32_list(value: &PyValue, repr: &PyRepr, nom: &str) -> Vec<u32> {
    value
        .field(repr, nom)
        .and_then(PyValue::as_list)
        .map(|liste| {
            liste
                .iter()
                .filter_map(PyValue::as_i64)
                .filter(|valeur| *valeur >= 0 && *valeur <= i64::from(u32::MAX))
                .map(|valeur| valeur as u32)
                .collect()
        })
        .unwrap_or_default()
}

/// Liste de noms d'un champ ; OP.GG peut fournir des nombres (fragments), on
/// les convertit en chaînes pour conserver la correspondance avec les ids.
fn field_name_list(value: &PyValue, repr: &PyRepr, nom: &str) -> Vec<String> {
    value
        .field(repr, nom)
        .and_then(PyValue::as_list)
        .map(|liste| {
            liste
                .iter()
                .map(|element| match element {
                    PyValue::Str(texte) => texte.clone(),
                    PyValue::Int(valeur) => valeur.to_string(),
                    PyValue::Float(valeur) if valeur.fract() == 0.0 => {
                        format!("{}", *valeur as i64)
                    }
                    PyValue::Float(valeur) => valeur.to_string(),
                    PyValue::Bool(valeur) => valeur.to_string(),
                    PyValue::None => String::new(),
                    PyValue::List(_) | PyValue::Instance(_) => String::new(),
                })
                .collect()
        })
        .unwrap_or_default()
}

// -- Fragments Community Dragon ---------------------------------------------

/// Entrée du catalogue Community Dragon (`id`, `name`, `iconPath`…).
#[derive(Debug, Clone, Deserialize)]
struct CommunityPerkDto {
    #[serde(default)]
    id: u32,
    #[serde(default)]
    name: String,
}

/// Parse le catalogue Community Dragon en table id → libellé réel.
fn parse_community_perks(bytes: &[u8]) -> AppResult<HashMap<u32, String>> {
    let perks: Vec<CommunityPerkDto> = serde_json::from_slice(bytes)
        .map_err(|err| AppError::parse("perks.json Community Dragon illisible", err))?;
    let mut catalogue = HashMap::new();
    for perk in perks {
        if perk.id > 0 && !perk.name.trim().is_empty() {
            catalogue.insert(perk.id, perk.name);
        }
    }
    Ok(catalogue)
}

/// Télécharge le catalogue public Community Dragon des perks/fragments.
async fn fetch_community_perks() -> AppResult<HashMap<u32, String>> {
    let http = reqwest::Client::builder()
        .timeout(MCP_TIMEOUT)
        .user_agent(concat!("LoL BOT/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|err| AppError::network("création du client HTTP Community Dragon", err))?;
    let response = http
        .get(COMMUNITY_PERKS_URL)
        .send()
        .await
        .map_err(|err| AppError::Network(format!("Community Dragon injoignable : {err}")))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AppError::Network(format!(
            "Community Dragon : réponse HTTP {status} pour les perks."
        )));
    }
    let bytes = response.bytes().await.map_err(|err| {
        AppError::Network(format!(
            "lecture des perks Community Dragon impossible : {err}"
        ))
    })?;
    parse_community_perks(&bytes)
}

fn community_cache_path(cache_root: &Path) -> PathBuf {
    meta_cache_root(cache_root)
        .join("community")
        .join("perks.json")
}

/// Charge le catalogue des fragments (cache 7 j) avec repli cache + warning.
async fn load_perk_catalog<F, Fut>(
    cache: &Cache,
    maintenant: i64,
    fetch: F,
) -> (HashMap<u32, String>, Option<String>)
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = AppResult<HashMap<u32, String>>>,
{
    let path = community_cache_path(cache.root());
    if let Some(entry) = read_meta_cache::<HashMap<u32, String>>(&path) {
        if is_fresh(entry.fetched_at_ms, PERKS_TTL_MS, maintenant) {
            return (entry.data, None);
        }
    }
    match fetch().await {
        Ok(catalogue) => {
            let warning = match write_meta_cache(
                &path,
                &MetaCacheEntry {
                    fetched_at_ms: maintenant,
                    data: catalogue.clone(),
                },
            ) {
                Ok(()) => None,
                Err(err) => Some(format!(
                    "cache Community Dragon non enregistré ({}) : {err}",
                    path.display()
                )),
            };
            (catalogue, warning)
        }
        Err(err) => match read_meta_cache::<HashMap<u32, String>>(&path) {
            Some(entry) => (
                entry.data,
                Some(format!(
                    "libellés de fragments Community Dragon indisponibles, noms OP.GG conservés (cache datant de {}) — {err}",
                    rfc3339(entry.fetched_at_ms)
                )),
            ),
            None => (
                HashMap::new(),
                Some(format!(
                    "libellés de fragments Community Dragon indisponibles, noms OP.GG conservés : {err}"
                )),
            ),
        },
    }
}

/// Remplace les noms de fragments par les libellés Community Dragon.
///
/// Priorité : catalogue officiel → nom fourni par OP.GG (même index) → id.
fn fragment_names(
    ids: &[u32],
    noms_opgg: &[String],
    catalogue: &HashMap<u32, String>,
) -> Vec<String> {
    ids.iter()
        .enumerate()
        .map(|(index, id)| {
            catalogue
                .get(id)
                .cloned()
                .or_else(|| {
                    noms_opgg
                        .get(index)
                        .cloned()
                        .filter(|nom| !nom.trim().is_empty())
                })
                .unwrap_or_else(|| id.to_string())
        })
        .collect()
}

fn rune_cache_path(cache_root: &Path, slug: &str, champion_key: &str, position: &str) -> PathBuf {
    meta_cache_root(cache_root)
        .join("runes")
        .join(slug)
        .join(format!("{champion_key}-{position}.json"))
}

fn rune_page_from_row(
    scope: &str,
    row: RunesRow,
    catalogue: &HashMap<u32, String>,
) -> MetaRunePage {
    let stat_mod_names = fragment_names(&row.stat_mod_ids, &row.stat_mod_names, catalogue);
    let win_rate = if row.play > 0 {
        Some(f64::from(row.win) / f64::from(row.play))
    } else {
        None
    };
    MetaRunePage {
        scope: scope.to_string(),
        primary_page_id: row.primary_page_id,
        primary_page_name: row.primary_page_name,
        primary_rune_ids: row.primary_rune_ids,
        primary_rune_names: row.primary_rune_names,
        secondary_page_id: row.secondary_page_id,
        secondary_page_name: row.secondary_page_name,
        secondary_rune_ids: row.secondary_rune_ids,
        secondary_rune_names: row.secondary_rune_names,
        stat_mod_ids: row.stat_mod_ids,
        stat_mod_names,
        play: row.play,
        win: row.win,
        pick_rate: row.pick_rate,
        win_rate,
    }
}

/// Assemble les pages à partir des résultats par portée (échecs non bloquants).
fn rune_pages_from_results(
    champion: &str,
    position: &str,
    platform: &str,
    results: Vec<(&'static str, AppResult<RunesRow>)>,
    catalogue: &HashMap<u32, String>,
    fetched_at: String,
) -> AppResult<MetaRunePages> {
    let mut pages = Vec::new();
    let mut warnings = Vec::new();
    for (scope, resultat) in results {
        match resultat {
            Ok(row) => pages.push(rune_page_from_row(scope, row, catalogue)),
            Err(err) => warnings.push(format!("page de runes {scope} indisponible : {err}")),
        }
    }
    if pages.is_empty() {
        return Err(AppError::Network(format!(
            "Aucune page de runes OP.GG récupérée pour {champion} ({position}) : {}",
            warnings.join(" ; ")
        )));
    }
    Ok(MetaRunePages {
        champion: champion.to_string(),
        position: position.to_string(),
        platform: platform.to_string(),
        source: META_SOURCE.to_string(),
        fetched_at,
        from_cache: false,
        pages,
        warning: if warnings.is_empty() {
            None
        } else {
            Some(warnings.join(" ; "))
        },
    })
}

async fn fetch_runes_row(champion_key: &str, position: &str, scope: &str) -> AppResult<RunesRow> {
    let arguments = json!({
        "game_mode": "ranked",
        "champion": champion_key,
        "position": position,
        "lang": "en_US",
        "tier": scope,
        "desired_output_fields": RUNES_OUTPUT_FIELDS
    });
    let texte = shared_mcp_client()
        .call_tool("lol_get_champion_analysis", arguments)
        .await?;
    let repr = PyRepr::parse(&texte)?;
    runes_from_repr(&repr)
}

/// Trois pages de runes réelles OP.GG (Challenger, Grandmaster, Tous niveaux).
///
/// Cache `<cache>/meta/runes/<slug>/<CHAMPION>-<position>.json` (12 h) ; un
/// échec de portée est non bloquant (warning), zéro page → Err claire ; repli
/// sur un cache même expiré si le MCP est indisponible.
pub async fn rune_pages(
    cache: &Cache,
    champion: &str,
    position: &str,
    platform: &str,
) -> AppResult<MetaRunePages> {
    rune_pages_with(
        cache,
        champion,
        position,
        platform,
        |champion_key: String, position: String, scope: String| async move {
            fetch_runes_row(&champion_key, &position, &scope).await
        },
        || async { fetch_community_perks().await },
    )
    .await
}

async fn rune_pages_with<PF, PFut, KF, KFut>(
    cache: &Cache,
    champion: &str,
    position: &str,
    platform: &str,
    page_fetch: PF,
    perk_fetch: KF,
) -> AppResult<MetaRunePages>
where
    PF: Fn(String, String, String) -> PFut,
    PFut: std::future::Future<Output = AppResult<RunesRow>>,
    KF: FnOnce() -> KFut,
    KFut: std::future::Future<Output = AppResult<HashMap<u32, String>>>,
{
    let (platform_id, slug) = region_slug(platform)?;
    let position = normalize_position(position)?;
    let resolu = resolve_champion(cache, champion)?;
    let maintenant = now_ms();
    let path = rune_cache_path(cache.root(), &slug, &resolu.opgg_key, &position);

    // 1. Cache frais (aucun réseau).
    if let Some(entry) = read_meta_cache::<MetaRunePages>(&path) {
        if is_fresh(entry.fetched_at_ms, RUNES_TTL_MS, maintenant) {
            let mut pages = entry.data;
            pages.from_cache = true;
            pages.warning = None;
            return Ok(pages);
        }
    }

    // 2. Trois portées réelles (échec d'une portée = warning, pas d'arrêt).
    let mut results: Vec<(&'static str, AppResult<RunesRow>)> = Vec::new();
    for scope in RUNE_SCOPES {
        let resultat =
            page_fetch(resolu.opgg_key.clone(), position.clone(), scope.to_string()).await;
        results.push((scope, resultat));
    }
    let echecs: Vec<String> = results
        .iter()
        .filter_map(|(scope, resultat)| {
            resultat
                .as_ref()
                .err()
                .map(|err| format!("page de runes {scope} indisponible : {err}"))
        })
        .collect();
    let succes = results
        .iter()
        .filter(|(_, resultat)| resultat.is_ok())
        .count();

    if succes == 0 {
        return match read_meta_cache::<MetaRunePages>(&path) {
            Some(entry) => {
                let mut pages = entry.data;
                pages.from_cache = true;
                pages.champion = resolu.display_name;
                pages.position = position;
                pages.platform = platform_id;
                pages.warning = Some(format!(
                    "OP.GG MCP indisponible, données en cache datant de {} — {}",
                    rfc3339(entry.fetched_at_ms),
                    echecs.join(" ; ")
                ));
                Ok(pages)
            }
            None => Err(AppError::Network(format!(
                "Aucune page de runes OP.GG récupérée pour {} ({}) : {}",
                resolu.display_name,
                position,
                echecs.join(" ; ")
            ))),
        };
    }

    // 3. Libellés réels des fragments (cache 7 j, repli OP.GG + warning).
    let (catalogue, perk_warning) = load_perk_catalog(cache, maintenant, perk_fetch).await;
    let mut pages = rune_pages_from_results(
        &resolu.display_name,
        &position,
        &platform_id,
        results,
        &catalogue,
        rfc3339(maintenant),
    )?;
    if let Some(warning) = perk_warning {
        pages.warning = Some(match pages.warning.take() {
            Some(existant) => format!("{existant} ; {warning}"),
            None => warning,
        });
    }

    // 4. Cache uniquement un jeu complet : une page manquante sera re-tentée.
    if pages.pages.len() == RUNE_SCOPES.len() {
        let mut a_stocker = pages.clone();
        a_stocker.from_cache = false;
        a_stocker.warning = None;
        if let Err(err) = write_meta_cache(
            &path,
            &MetaCacheEntry {
                fetched_at_ms: maintenant,
                data: a_stocker,
            },
        ) {
            let warning = format!("cache de runes non enregistré ({}) : {err}", path.display());
            pages.warning = Some(match pages.warning.take() {
                Some(existant) => format!("{existant} ; {warning}"),
                None => warning,
            });
        }
    }
    Ok(pages)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;
    use crate::cache::test_support::temp_dir;
    use crate::cache::{CacheMeta, CHAMPION_FILE};

    const VERSION: &str = "16.21.1";

    const TIER_FIXTURE: &str = r#"class LolListLaneMetaChampions: data
class Data: positions
class Positions: top,mid,jungle,adc,support
class Top: champion,is_rip,play,win,win_rate,pick_rate,role_rate,ban_rate,kda,tier,rank,rank_prev

LolListLaneMetaChampions(Data(Positions([Top("Malphite",False,135828,69867,0.51,0.07,0.78,0.18,2.44,1,1,1),Top("Kai'Sa",False,500,250,0.5,0.2,0.9,0.05,2.0,2,1,2)],[Top("Ahri",False,800,410,0.52,0.1,0.95,0.03,2.56,1,1,1)],[],[],[])))
"#;

    const BUILD_FIXTURE: &str = r#"class LolGetChampionAnalysis: champion,data
class Data: summary,core_items,boots,starter_items,fourth_items,fifth_items,sixth_items,counters_meta
class Summary: average_stats
class AverageStats: play,win_rate,pick_rate,ban_rate,kda,tier,rank,tier_data
class TierData: tier,rank,rank_prev,rank_prev_patch
class CoreItems: ids,ids_names,play,win,pick_rate
class CountersMeta: message

LolGetChampionAnalysis("AHRI",Data(Summary(AverageStats(712,0.53,0.11,0.02,2.95,3,21,TierData(3,21,23,27))),CoreItems([1082,2503,3100,3157],["Dark Seal","Blackfire Torch","Lich Bane","Zhonya's Hourglass"],19,12,0.05),CoreItems([3158],["Ionian Boots of Lucidity"],347,191,0.57),CoreItems([1056,2003,2003],["Doran's Ring","Health Potion","Health Potion"],613,324,0.99),[CoreItems([3089],["Rabadon's Deathcap"],45,32,0.3),CoreItems([3157],["Zhonya's Hourglass"],37,26,0.25),CoreItems([3041],["Mejai's Soulstealer"],16,14,0.11)],[CoreItems([3157],["Zhonya's Hourglass"],7,4,0.24)],[],CountersMeta("sample insuffisant")))
"#;

    fn parse_tier_fixture() -> Vec<TierRow> {
        let repr = PyRepr::parse(TIER_FIXTURE).expect("repr tier");
        tier_rows_from_repr(&repr).expect("lignes tier")
    }

    fn synthetic_champions() -> Vec<ddragon::RawChampion> {
        vec![
            ddragon::RawChampion {
                id: "Malphite".to_string(),
                key: "54".to_string(),
                name: "Malphite".to_string(),
                ..Default::default()
            },
            ddragon::RawChampion {
                id: "Kaisa".to_string(),
                key: "145".to_string(),
                name: "Kai'Sa".to_string(),
                ..Default::default()
            },
            ddragon::RawChampion {
                id: "Ahri".to_string(),
                key: "103".to_string(),
                name: "Ahri".to_string(),
                ..Default::default()
            },
            ddragon::RawChampion {
                id: "MonkeyKing".to_string(),
                key: "62".to_string(),
                name: "Wukong".to_string(),
                ..Default::default()
            },
            ddragon::RawChampion {
                id: "KSante".to_string(),
                key: "897".to_string(),
                name: "K'Sante".to_string(),
                ..Default::default()
            },
            ddragon::RawChampion {
                id: "DrMundo".to_string(),
                key: "86".to_string(),
                name: "Dr. Mundo".to_string(),
                ..Default::default()
            },
        ]
    }

    fn preparer_cache_champions(cache: &Cache) {
        cache.ensure_root().expect("création du cache");
        cache
            .write_meta(&CacheMeta {
                version: Some(VERSION.to_string()),
                updated_at: None,
                last_sync_error: None,
            })
            .expect("méta");
        let json = r#"{
            "data": {
                "MonkeyKing": {"id": "MonkeyKing", "key": "62", "name": "Wukong"},
                "KSante": {"id": "KSante", "key": "897", "name": "K'Sante"},
                "DrMundo": {"id": "DrMundo", "key": "86", "name": "Dr. Mundo"},
                "Belveth": {"id": "Belveth", "key": "200", "name": "Bel'Veth"},
                "Chogath": {"id": "Chogath", "key": "31", "name": "Cho'Gath"},
                "Ahri": {"id": "Ahri", "key": "103", "name": "Ahri"}
            }
        }"#;
        let path = cache.data_file(VERSION, CHAMPION_FILE).expect("chemin");
        cache
            .write_bytes(&path, json.as_bytes())
            .expect("champion.json");
    }

    // -- Parser repr Python ------------------------------------------------

    #[test]
    fn parser_repr_tier_list() {
        let rows = parse_tier_fixture();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].position, "top");
        assert_eq!(rows[0].champion, "Malphite");
        assert_eq!(rows[0].play, 135828);
        assert_eq!(rows[0].win_rate, 0.51);
        assert_eq!(rows[0].pick_rate, 0.07);
        assert_eq!(rows[0].ban_rate, 0.18);
        assert_eq!(rows[0].kda, 2.44);
        assert_eq!(rows[0].tier, 1);
        assert_eq!(rows[0].rank, 1);
        assert_eq!(rows[0].role_rate, 0.78);

        // Valeur de déclaration supplémentaire (is_rip) : l'ordre des champs est
        // bien celui des déclarations, pas un ordre codé en dur.
        assert_eq!(rows[1].champion, "Kai'Sa");
        assert_eq!(rows[1].position, "top");
        assert_eq!(rows[2].champion, "Ahri");
        assert_eq!(rows[2].position, "mid");
        assert_eq!(rows[2].win_rate, 0.52);
    }

    #[test]
    fn mapping_tier_vers_cles_data_dragon() {
        let entries = tier_entries_from_rows(parse_tier_fixture(), &synthetic_champions());
        assert_eq!(entries.len(), 3);
        assert_eq!(entries[0].champion_key, 54);
        assert_eq!(entries[1].champion_key, 145, "Kai'Sa → clé Data Dragon");
        assert_eq!(entries[2].champion_key, 103);

        // Champion inconnu du cache Data Dragon → clé 0, nom OP.GG conservé.
        let inconnu = TierRow {
            champion: "Champion Inconnu".to_string(),
            position: "top".to_string(),
            tier: 3,
            rank: 1,
            win_rate: 0.5,
            pick_rate: 0.01,
            ban_rate: 0.0,
            kda: 2.0,
            play: 10,
            role_rate: 0.5,
        };
        let entries = tier_entries_from_rows(vec![inconnu], &synthetic_champions());
        assert_eq!(entries[0].champion_key, 0);
        assert_eq!(entries[0].champion_name, "Champion Inconnu");
    }

    #[test]
    fn parser_repr_build_et_conversion() {
        let repr = PyRepr::parse(BUILD_FIXTURE).expect("repr build");
        let rows = build_rows_from_repr(&repr).expect("lignes build");

        let moyenne = rows.average.as_ref().expect("summary");
        assert_eq!(moyenne.play, 712);
        assert_eq!(moyenne.win_rate, 0.53);
        assert_eq!(moyenne.pick_rate, 0.11);
        assert_eq!(moyenne.ban_rate, 0.02);
        assert_eq!(moyenne.tier, 3);
        assert_eq!(moyenne.rank, 21);

        assert_eq!(rows.core.len(), 1);
        assert_eq!(rows.core[0].ids, vec![1082, 2503, 3100, 3157]);
        assert_eq!(rows.core[0].names[0], "Dark Seal");
        assert_eq!(rows.core[0].play, 19);
        assert_eq!(rows.core[0].win, 12);
        assert_eq!(rows.core[0].pick_rate, 0.05);
        assert_eq!(rows.boots[0].ids, vec![3158]);
        assert_eq!(rows.starter[0].ids, vec![1056, 2003, 2003]);
        assert_eq!(rows.fourth.len(), 3);
        assert_eq!(rows.fourth[0].ids, vec![3089]);
        assert_eq!(rows.fifth.len(), 1);
        assert!(rows.sixth.is_empty());

        let build = meta_build_from_rows(
            rows,
            "Ahri".to_string(),
            "mid".to_string(),
            "EUW1".to_string(),
            "euw".to_string(),
            "challenger".to_string(),
            rfc3339(0),
        );
        assert_eq!(build.champion, "Ahri");
        assert_eq!(build.source, "OP.GG MCP");
        assert_eq!(build.win_rate, Some(0.53));
        assert_eq!(build.games, Some(712));
        assert_eq!(build.tier_label, Some(3));
        assert_eq!(build.rank, Some(21));
        assert_eq!(build.core.len(), 1);
        assert_eq!(build.core[0].games, 19);
        assert_eq!(build.core[0].wins, 12);
        assert_eq!(build.core[0].ids, vec![1082, 2503, 3100, 3157]);
        assert!(!build.from_cache);

        // Build sans summary ni items : valeurs Option à None, listes vides.
        let vide = meta_build_from_rows(
            BuildRows::default(),
            "Ahri".to_string(),
            "mid".to_string(),
            "EUW1".to_string(),
            "euw".to_string(),
            "all".to_string(),
            rfc3339(0),
        );
        assert_eq!(vide.win_rate, None);
        assert_eq!(vide.games, None);
        assert_eq!(vide.tier_label, None);
        assert!(vide.core.is_empty());
    }

    #[test]
    fn parser_rejette_repr_invalide() {
        assert!(PyRepr::parse("pas une repr").is_err());
        assert!(PyRepr::parse("class A: x").is_err());
        assert!(PyRepr::parse("class A: x\nA(").is_err());
        assert!(PyRepr::parse("class A: x\nA(\"chaine non terminee)").is_err());
        assert!(PyRepr::parse("").is_err());

        // Repr valide mais sans les champs attendus → erreur claire, pas de panique.
        let repr = PyRepr::parse("class Autre: x\nAutre(1)").expect("repr valide");
        assert!(tier_rows_from_repr(&repr).is_err());
        assert!(build_rows_from_repr(&repr).is_err());
    }

    #[test]
    fn parser_payload_json_et_sse() {
        let json_body =
            r#"{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"contenu"}]}}"#;
        let valeur = parse_jsonrpc_payload(json_body).expect("JSON direct");
        assert_eq!(extract_mcp_text(&valeur).as_deref(), Some("contenu"));

        let sse = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"sse\"}]}}\n\n";
        let valeur = parse_jsonrpc_payload(sse).expect("SSE");
        assert_eq!(extract_mcp_text(&valeur).as_deref(), Some("sse"));

        assert!(parse_jsonrpc_payload("").is_none());
        assert!(parse_jsonrpc_payload("pas du json").is_none());
        assert!(extract_mcp_text(&json!({"result": {"content": []}})).is_none());
    }

    // -- Plateformes / normalisation --------------------------------------

    #[test]
    fn mapping_plateformes_vers_slugs_opgg() {
        let attendus = [
            ("EUW1", "euw"),
            ("EUNE1", "eune"),
            ("TR1", "tr"),
            ("RU", "ru"),
            ("ME1", "me"),
            ("NA1", "na"),
            ("BR1", "br"),
            ("LA1", "lan"),
            ("LA2", "las"),
            ("KR", "kr"),
            ("JP1", "jp"),
            ("OC1", "oce"),
            ("PH2", "ph"),
            ("SG2", "sg"),
            ("TH2", "th"),
            ("TW2", "tw"),
            ("VN2", "vn"),
        ];
        for (platform, slug) in attendus {
            let (id, obtenu) = region_slug(platform).expect("plateforme valide");
            assert_eq!(id, platform);
            assert_eq!(obtenu, slug, "slug OP.GG de {platform}");
        }
        assert!(region_slug("EUW9").is_err());
        assert!(region_slug("../euw").is_err());
    }

    #[test]
    fn normalisation_des_champions() {
        for (nom, attendu) in [
            ("Ahri", "AHRI"),
            ("Dr. Mundo", "DR_MUNDO"),
            ("DrMundo", "DRMUNDO"),
            ("K'Sante", "KSANTE"),
            ("KSante", "KSANTE"),
            ("Bel'Veth", "BELVETH"),
            ("Cho'Gath", "CHOGATH"),
            ("Wukong", "WUKONG"),
            ("Nunu & Willump", "NUNU_WILLUMP"),
            ("Kai'Sa", "KAISA"),
            ("Lee Sin", "LEE_SIN"),
            ("  Aurelion Sol  ", "AURELION_SOL"),
            ("Aatrox", "AATROX"),
        ] {
            assert_eq!(
                normalize_champion_key(nom),
                attendu,
                "normalisation « {nom} »"
            );
        }
        assert!(normalize_champion_key("   ").is_empty());
    }

    #[test]
    fn resolution_champion_via_cache_data_dragon() {
        let dir = temp_dir("meta-champions");
        let cache = dir.cache();
        preparer_cache_champions(&cache);

        for (entree, attendu) in [
            ("MonkeyKing", ("Wukong", "WUKONG")),
            ("Wukong", ("Wukong", "WUKONG")),
            ("KSante", ("K'Sante", "KSANTE")),
            ("K'Sante", ("K'Sante", "KSANTE")),
            ("DrMundo", ("Dr. Mundo", "DR_MUNDO")),
            ("Dr. Mundo", ("Dr. Mundo", "DR_MUNDO")),
            ("Belveth", ("Bel'Veth", "BELVETH")),
            ("Chogath", ("Cho'Gath", "CHOGATH")),
            ("Ahri", ("Ahri", "AHRI")),
        ] {
            let resolu = resolve_champion(&cache, entree).expect("champion résolu");
            assert_eq!(
                resolu.display_name, attendu.0,
                "nom d'affichage de {entree}"
            );
            assert_eq!(resolu.opgg_key, attendu.1, "clé OP.GG de {entree}");
        }

        // Champion absent du cache Data Dragon : normalisation directe du nom.
        let resolu = resolve_champion(&cache, "Foo Bar").expect("champion inconnu");
        assert_eq!(resolu.display_name, "Foo Bar");
        assert_eq!(resolu.opgg_key, "FOO_BAR");
        assert!(resolve_champion(&cache, "   ").is_err());
    }

    #[test]
    fn validation_position_et_tier() {
        for position in ["top", "MID", "Jungle", "adc", "support"] {
            assert!(normalize_position(position).is_ok());
        }
        assert_eq!(normalize_position(" MID ").expect("mid"), "mid");
        for invalide in ["", "bot", "top/jungle", "../mid"] {
            assert!(matches!(
                normalize_position(invalide),
                Err(AppError::InvalidId(_))
            ));
        }

        assert_eq!(normalize_tier(None).expect("défaut"), "challenger");
        assert_eq!(normalize_tier(Some("")).expect("défaut"), "challenger");
        assert_eq!(normalize_tier(Some("ALL")).expect("all"), "all");
        assert!(normalize_tier(Some("master")).is_err());
    }

    // -- Cache méta ---------------------------------------------------------

    fn tier_list_exemple() -> MetaTierList {
        MetaTierList {
            platform: "EUW1".to_string(),
            region: "euw".to_string(),
            source: META_SOURCE.to_string(),
            fetched_at: rfc3339(1_000),
            from_cache: false,
            entries: vec![MetaTierEntry {
                champion_key: 54,
                champion_name: "Malphite".to_string(),
                position: "top".to_string(),
                tier: 1,
                rank: 1,
                win_rate: 0.51,
                pick_rate: 0.07,
                ban_rate: 0.18,
                kda: 2.44,
                play: 135_828,
                role_rate: 0.78,
            }],
            warning: None,
        }
    }

    #[test]
    fn chemins_et_ttl_du_cache_meta() {
        let dir = temp_dir("meta-cache");
        let root = dir.path();
        assert_eq!(
            tier_cache_path(root, "euw"),
            root.join("meta").join("tier").join("euw.json")
        );
        assert_eq!(
            build_cache_path(root, "euw", "challenger", "AHRI", "mid"),
            root.join("meta")
                .join("build")
                .join("euw")
                .join("challenger")
                .join("AHRI-mid.json")
        );

        let chemin = tier_cache_path(root, "euw");
        write_meta_cache(
            &chemin,
            &MetaCacheEntry {
                fetched_at_ms: 1_000,
                data: tier_list_exemple(),
            },
        )
        .expect("écriture cache méta");
        let relu = read_meta_cache::<MetaTierList>(&chemin).expect("cache relu");
        assert_eq!(relu.fetched_at_ms, 1_000);
        assert_eq!(relu.data.entries.len(), 1);
        assert_eq!(relu.data.entries[0].champion_key, 54);

        assert!(is_fresh(1_000, TIER_TTL_MS, 1_000 + TIER_TTL_MS));
        assert!(!is_fresh(1_000, TIER_TTL_MS, 1_001 + TIER_TTL_MS));

        std::fs::write(&chemin, b"{ pas du json").expect("corruption");
        assert!(read_meta_cache::<MetaTierList>(&chemin).is_none());
    }

    #[test]
    fn repli_cache_meta_sans_reseau() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("meta-repli");
            let path = tier_cache_path(dir.path(), "euw");
            let stale = MetaCacheEntry {
                fetched_at_ms: 1_000,
                data: tier_list_exemple(),
            };
            write_meta_cache(&path, &stale).expect("cache");

            // Cache expiré + échec MCP → cache réel servi avec warning.
            let (liste, from_cache, warning) =
                load_meta_with_fallback(path.clone(), TIER_TTL_MS, 10 * TIER_TTL_MS, || async {
                    Err::<MetaTierList, _>(AppError::Network("MCP KO (test)".to_string()))
                })
                .await
                .expect("repli cache");
            assert!(from_cache);
            assert_eq!(liste.entries.len(), 1);
            let warning = warning.expect("warning de repli");
            assert!(warning.contains("OP.GG MCP indisponible"), "{warning}");
            assert!(
                warning.contains("datant de"),
                "date réelle dans le warning : {warning}"
            );

            // Cache frais : la fermeture de fetch ne doit pas être appelée.
            let appelee = AtomicBool::new(false);
            let (liste, from_cache, warning) =
                load_meta_with_fallback(path.clone(), TIER_TTL_MS, 1_500, || async {
                    appelee.store(true, Ordering::Relaxed);
                    Err::<MetaTierList, _>(AppError::Network(
                        "ne devrait pas être appelé".to_string(),
                    ))
                })
                .await
                .expect("cache frais");
            assert!(!appelee.load(Ordering::Relaxed));
            assert!(from_cache);
            assert!(warning.is_none());
            assert_eq!(liste.entries.len(), 1);

            // Pas de cache + échec MCP → erreur claire.
            let inconnu = tier_cache_path(dir.path(), "na");
            let resultat = load_meta_with_fallback(inconnu, TIER_TTL_MS, 0, || async {
                Err::<MetaTierList, _>(AppError::Network("MCP KO".to_string()))
            })
            .await;
            assert!(matches!(resultat, Err(AppError::Network(_))));
        });
    }
    // -- Rune Builder (V0.7) ----------------------------------------------

    const RUNES_FIXTURE_CHALLENGER: &str = r#"class LolGetChampionAnalysis: champion,data
class Data: summary,runes,counters_meta
class Summary: average_stats
class AverageStats: play,win_rate,pick_rate,ban_rate,kda,tier,rank,tier_data
class TierData: tier,rank,rank_prev,rank_prev_patch
class Runes: id,primary_page_id,primary_page_name,primary_rune_ids,primary_rune_names,secondary_page_id,secondary_page_name,secondary_rune_ids,secondary_rune_names,stat_mod_ids,stat_mod_names,play,win,pick_rate
class CountersMeta: message

LolGetChampionAnalysis("AHRI",Data(Summary(AverageStats(712,0.53,0.11,0.02,2.95,3,21,TierData(3,21,23,27))),Runes(8112,8100,"Domination",[8112,8139,8140,8106],["Electrocute","Taste of Blood","Grisly Mementos","Ultimate Hunter"],8200,"Sorcery",[8226,8237],["Manaflow Band","Scorch"],[5005,5008,5011],[5005,5008,5011],129,69,0.2),CountersMeta("sample insuffisant")))
"#;

    /// Variante réelle `all` : `Data` ne déclare pas `counters_meta`.
    const RUNES_FIXTURE_ALL: &str = r#"class LolGetChampionAnalysis: champion,data
class Data: summary,runes
class Summary: average_stats
class AverageStats: play,win_rate,pick_rate,ban_rate,kda,tier,rank,tier_data
class TierData: tier,rank,rank_prev,rank_prev_patch
class Runes: id,primary_page_id,primary_page_name,primary_rune_ids,primary_rune_names,secondary_page_id,secondary_page_name,secondary_rune_ids,secondary_rune_names,stat_mod_ids,stat_mod_names,play,win,pick_rate

LolGetChampionAnalysis("AHRI",Data(Summary(AverageStats(794056,0.51,0.1,0.04,2.39,2,20,TierData(2,20,21,32))),Runes(8112,8100,"Domination",[8112,8139,8140,8106],["Electrocute","Taste of Blood","Grisly Mementos","Ultimate Hunter"],8200,"Sorcery",[8210,8226],["Transcendence","Manaflow Band"],[5005,5008,5001],[5005,5008,5001],397140,200090,0.56)))
"#;

    fn rune_row(play: u32, win: u32, noms_fragments: Vec<String>) -> RunesRow {
        RunesRow {
            primary_page_id: 8100,
            primary_page_name: "Domination".to_string(),
            primary_rune_ids: vec![8112, 8139, 8140, 8106],
            primary_rune_names: vec![
                "Electrocute".to_string(),
                "Taste of Blood".to_string(),
                "Grisly Mementos".to_string(),
                "Ultimate Hunter".to_string(),
            ],
            secondary_page_id: 8200,
            secondary_page_name: "Sorcery".to_string(),
            secondary_rune_ids: vec![8226, 8237],
            secondary_rune_names: vec!["Manaflow Band".to_string(), "Scorch".to_string()],
            stat_mod_ids: vec![5005, 5008, 5011],
            stat_mod_names: noms_fragments,
            play,
            win,
            pick_rate: 0.2,
        }
    }

    fn catalogue_fragments() -> HashMap<u32, String> {
        HashMap::from([
            (5005, "Attack Speed".to_string()),
            (5008, "Adaptive Force".to_string()),
            (5011, "Health Scaling".to_string()),
            (5001, "Health Scaling".to_string()),
        ])
    }

    #[test]
    fn parser_repr_runes() {
        let repr = PyRepr::parse(RUNES_FIXTURE_CHALLENGER).expect("repr runes challenger");
        let row = runes_from_repr(&repr).expect("page runes challenger");
        assert_eq!(row.primary_page_id, 8100);
        assert_eq!(row.primary_page_name, "Domination");
        assert_eq!(row.primary_rune_ids, vec![8112, 8139, 8140, 8106]);
        assert_eq!(row.primary_rune_names[0], "Electrocute");
        assert_eq!(row.primary_rune_names[3], "Ultimate Hunter");
        assert_eq!(row.secondary_page_id, 8200);
        assert_eq!(row.secondary_page_name, "Sorcery");
        assert_eq!(row.secondary_rune_ids, vec![8226, 8237]);
        assert_eq!(row.secondary_rune_names, vec!["Manaflow Band", "Scorch"]);
        assert_eq!(row.stat_mod_ids, vec![5005, 5008, 5011]);
        // `stat_mod_names` est numérique chez OP.GG : converti en chaînes, index
        // conservé pour le repli éventuel.
        assert_eq!(
            row.stat_mod_names,
            vec!["5005".to_string(), "5008".to_string(), "5011".to_string()]
        );
        assert_eq!(row.play, 129);
        assert_eq!(row.win, 69);
        assert_eq!(row.pick_rate, 0.2);

        // Variante `all` : déclaration Data sans counters_meta.
        let repr = PyRepr::parse(RUNES_FIXTURE_ALL).expect("repr runes all");
        let row = runes_from_repr(&repr).expect("page runes all");
        assert_eq!(row.primary_rune_ids.len(), 4);
        assert_eq!(row.stat_mod_ids, vec![5005, 5008, 5001]);
        assert_eq!(row.play, 397140);
        assert_eq!(row.win, 200090);

        // Repr sans runes → erreur claire, pas de panique.
        let repr = PyRepr::parse("class LolGetChampionAnalysis: champion,data\nclass Data: summary\nLolGetChampionAnalysis(\"AHRI\",Data(None))").expect("repr");
        assert!(runes_from_repr(&repr).is_err());
    }

    #[test]
    fn construction_trois_scopes_et_echec_partiel() {
        let catalogue = catalogue_fragments();
        let results = vec![
            (
                "challenger",
                Ok(rune_row(
                    129,
                    69,
                    vec!["5005".to_string(), "5008".to_string(), "5011".to_string()],
                )),
            ),
            (
                "grandmaster",
                Err::<RunesRow, _>(AppError::Network("MCP KO (test)".to_string())),
            ),
            (
                "all",
                Ok(rune_row(
                    0,
                    0,
                    vec!["5005".to_string(), "5008".to_string(), "5001".to_string()],
                )),
            ),
        ];
        let pages =
            rune_pages_from_results("Ahri", "mid", "EUW1", results, &catalogue, rfc3339(1_000))
                .expect("pages partielles");

        assert_eq!(pages.pages.len(), 2, "2 portées réussies sur 3");
        assert_eq!(pages.pages[0].scope, "challenger");
        assert_eq!(pages.pages[1].scope, "all");
        assert!(!pages.from_cache);
        let warning = pages.warning.clone().expect("warning échec partiel");
        assert!(warning.contains("grandmaster"), "{warning}");
        assert!(warning.contains("MCP KO"), "{warning}");

        // win_rate = win/play si play > 0, sinon None.
        assert!((pages.pages[0].win_rate.expect("win rate") - 69.0 / 129.0).abs() < 1e-9);
        assert_eq!(pages.pages[1].win_rate, None);
        assert_eq!(pages.pages[1].play, 0);

        // Fragments : libellés Community Dragon quand disponibles.
        assert_eq!(
            pages.pages[0].stat_mod_names,
            vec!["Attack Speed", "Adaptive Force", "Health Scaling"]
        );
        assert_eq!(pages.pages[0].stat_mod_ids, vec![5005, 5008, 5011]);

        // Sans catalogue : repli sur les valeurs OP.GG (index conservé).
        let pages = rune_pages_from_results(
            "Ahri",
            "mid",
            "EUW1",
            vec![(
                "challenger",
                Ok(rune_row(
                    10,
                    5,
                    vec!["5005".to_string(), "5008".to_string(), "5011".to_string()],
                )),
            )],
            &HashMap::new(),
            rfc3339(0),
        )
        .expect("pages sans catalogue");
        assert_eq!(
            pages.pages[0].stat_mod_names,
            vec!["5005", "5008", "5011"],
            "valeurs OP.GG conservées"
        );

        // Aucune page → Err claire.
        let erreur = rune_pages_from_results(
            "Ahri",
            "mid",
            "EUW1",
            vec![
                (
                    "challenger",
                    Err::<RunesRow, _>(AppError::Network("KO 1".to_string())),
                ),
                (
                    "grandmaster",
                    Err::<RunesRow, _>(AppError::Network("KO 2".to_string())),
                ),
                (
                    "all",
                    Err::<RunesRow, _>(AppError::Network("KO 3".to_string())),
                ),
            ],
            &catalogue,
            rfc3339(0),
        );
        match erreur {
            Err(AppError::Network(message)) => {
                assert!(message.contains("Aucune page de runes"), "{message}");
                assert!(message.contains("KO 1"), "{message}");
            }
            autre => panic!("erreur attendue, reçu : {autre:?}"),
        }
    }

    #[test]
    fn catalogue_fragments_et_repli() {
        let json = br#"[
            {"id": 5005, "name": "Attack Speed", "iconPath": "/x.png"},
            {"id": 5008, "name": "Adaptive Force", "iconPath": "/y.png"},
            {"id": 8112, "name": "Electrocute", "iconPath": "/z.png"},
            {"id": 0, "name": "Invalide"},
            {"id": 5002, "name": "   "}
        ]"#;
        let catalogue = parse_community_perks(json).expect("catalogue");
        assert_eq!(catalogue.len(), 3);
        assert_eq!(
            catalogue.get(&5005).map(String::as_str),
            Some("Attack Speed")
        );
        assert_eq!(
            catalogue.get(&5008).map(String::as_str),
            Some("Adaptive Force")
        );
        assert!(!catalogue.contains_key(&0));

        assert_eq!(
            fragment_names(
                &[5005, 9999],
                &["5005".to_string(), "OPGG".to_string()],
                &catalogue
            ),
            vec!["Attack Speed".to_string(), "OPGG".to_string()],
            "catalogue prioritaire, puis OP.GG"
        );
        assert_eq!(
            fragment_names(&[9999], &[], &catalogue),
            vec!["9999".to_string()],
            "dernier repli : id"
        );

        // Catalogue illisible → erreur claire.
        assert!(parse_community_perks(b"pas du json").is_err());
    }

    #[test]
    fn cache_et_ttl_runes_et_perks() {
        let dir = temp_dir("meta-runes-cache");
        let root = dir.path();
        assert_eq!(
            rune_cache_path(root, "euw", "AHRI", "mid"),
            root.join("meta")
                .join("runes")
                .join("euw")
                .join("AHRI-mid.json")
        );
        assert_eq!(
            community_cache_path(root),
            root.join("meta").join("community").join("perks.json")
        );

        let pages = rune_pages_from_results(
            "Ahri",
            "mid",
            "EUW1",
            vec![(
                "challenger",
                Ok(rune_row(
                    129,
                    69,
                    vec!["5005".to_string(), "5008".to_string(), "5011".to_string()],
                )),
            )],
            &catalogue_fragments(),
            rfc3339(0),
        )
        .expect("pages");
        let chemin = rune_cache_path(root, "euw", "AHRI", "mid");
        write_meta_cache(
            &chemin,
            &MetaCacheEntry {
                fetched_at_ms: 1_000,
                data: pages.clone(),
            },
        )
        .expect("écriture cache runes");
        let relu = read_meta_cache::<MetaRunePages>(&chemin).expect("cache relu");
        assert_eq!(relu.fetched_at_ms, 1_000);
        assert_eq!(relu.data.pages.len(), 1);
        assert!(is_fresh(1_000, RUNES_TTL_MS, 1_000 + RUNES_TTL_MS));
        assert!(!is_fresh(1_000, RUNES_TTL_MS, 1_001 + RUNES_TTL_MS));

        std::fs::write(&chemin, b"{ corrompu").expect("corruption");
        assert!(read_meta_cache::<MetaRunePages>(&chemin).is_none());

        // Cache des perks : écriture/lecture/corruption.
        let perks_path = community_cache_path(root);
        write_meta_cache(
            &perks_path,
            &MetaCacheEntry {
                fetched_at_ms: 2_000,
                data: catalogue_fragments(),
            },
        )
        .expect("écriture perks");
        let relu = read_meta_cache::<HashMap<u32, String>>(&perks_path).expect("perks relus");
        assert_eq!(relu.data.len(), 4);
        assert!(is_fresh(2_000, PERKS_TTL_MS, 2_000 + PERKS_TTL_MS));
        std::fs::write(&perks_path, b"nope").expect("corruption perks");
        assert!(read_meta_cache::<HashMap<u32, String>>(&perks_path).is_none());
    }

    #[test]
    fn rune_pages_avec_fetch_injecte_et_repli() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("meta-runes-fetch");
            let cache = dir.cache();
            let plus_maintenant = 1_700_000_000_000i64;
            let catalogue = catalogue_fragments();

            // 1. Trois portées OK + catalogue OK → 3 pages + cache écrit.
            let pages = rune_pages_with(
                &cache,
                "Ahri",
                "mid",
                "EUW1",
                |_champion: String, _position: String, scope: String| async move {
                    match scope.as_str() {
                        "challenger" => Ok(rune_row(
                            129,
                            69,
                            vec!["5005".to_string(), "5008".to_string(), "5011".to_string()],
                        )),
                        "grandmaster" => Ok(rune_row(
                            549,
                            279,
                            vec!["5005".to_string(), "5008".to_string(), "5001".to_string()],
                        )),
                        _ => Ok(rune_row(
                            397140,
                            200090,
                            vec!["5005".to_string(), "5008".to_string(), "5001".to_string()],
                        )),
                    }
                },
                || async { Ok(catalogue.clone()) },
            )
            .await
            .expect("pages réelles");
            assert_eq!(pages.pages.len(), 3);
            assert!(!pages.from_cache);
            assert_eq!(pages.warning, None);
            assert_eq!(pages.pages[0].scope, "challenger");
            assert_eq!(pages.pages[1].scope, "grandmaster");
            assert_eq!(pages.pages[2].scope, "all");
            assert_eq!(pages.pages[0].stat_mod_names[0], "Attack Speed");
            assert!(pages.pages[1].win_rate.is_some());
            let chemin = rune_cache_path(cache.root(), "euw", "AHRI", "mid");
            assert!(chemin.is_file(), "cache runes écrit");

            // 2. Cache frais : aucun fetch (page ni perks) n'est appelé.
            let pages_attendu = pages.clone();
            let page_appele = AtomicBool::new(false);
            let perk_appele = AtomicBool::new(false);
            let pages = rune_pages_with(
                &cache,
                "Ahri",
                "mid",
                "EUW1",
                |_c: String, _p: String, _s: String| {
                    page_appele.store(true, Ordering::Relaxed);
                    async {
                        Err::<RunesRow, _>(AppError::Network("ne doit pas être appelé".to_string()))
                    }
                },
                || {
                    perk_appele.store(true, Ordering::Relaxed);
                    async {
                        Err::<HashMap<u32, String>, _>(AppError::Network(
                            "ne doit pas être appelé".to_string(),
                        ))
                    }
                },
            )
            .await
            .expect("cache runes frais");
            assert!(!page_appele.load(Ordering::Relaxed));
            assert!(!perk_appele.load(Ordering::Relaxed));
            assert!(pages.from_cache);
            assert_eq!(pages.pages.len(), pages_attendu.pages.len());

            // 3. Échec d'une portée : 2 pages + warning, pas de cache mis à jour.
            std::fs::remove_file(&chemin).expect("suppression cache");
            let pages = rune_pages_with(
                &cache,
                "Ahri",
                "mid",
                "EUW1",
                |_c: String, _p: String, scope: String| async move {
                    if scope == "grandmaster" {
                        Err(AppError::Network("GM KO".to_string()))
                    } else {
                        Ok(rune_row(
                            10,
                            5,
                            vec!["5005".to_string(), "5008".to_string(), "5011".to_string()],
                        ))
                    }
                },
                || async { Ok(catalogue.clone()) },
            )
            .await
            .expect("pages partielles");
            assert_eq!(pages.pages.len(), 2);
            assert!(!chemin.exists(), "pages partielles non mises en cache");
            let warning = pages.warning.clone().expect("warning");
            assert!(warning.contains("grandmaster"), "{warning}");

            // 4. Toutes portées KO + cache expiré → cache réel + warning.
            let cache_ok = pages.clone();
            write_meta_cache(
                &chemin,
                &MetaCacheEntry {
                    fetched_at_ms: plus_maintenant - 10 * RUNES_TTL_MS,
                    data: cache_ok,
                },
            )
            .expect("cache expiré");
            let perk_appele = AtomicBool::new(false);
            let pages = rune_pages_with(
                &cache,
                "Ahri",
                "mid",
                "EUW1",
                |_c: String, _p: String, _s: String| async {
                    Err::<RunesRow, _>(AppError::Network("MCP KO".to_string()))
                },
                || {
                    perk_appele.store(true, Ordering::Relaxed);
                    async {
                        Err::<HashMap<u32, String>, _>(AppError::Network(
                            "ne doit pas être appelé".to_string(),
                        ))
                    }
                },
            )
            .await
            .expect("repli cache runes");
            assert!(pages.from_cache);
            assert_eq!(pages.pages.len(), 2, "pages réelles du cache");
            assert!(!perk_appele.load(Ordering::Relaxed), "perks non appelés");
            let warning = pages.warning.clone().expect("warning repli");
            assert!(warning.contains("OP.GG MCP indisponible"), "{warning}");
            assert!(warning.contains("MCP KO"), "{warning}");

            // 5. Aucun cache + toutes portées KO → Err claire.
            let dir_vide = temp_dir("meta-runes-vide");
            let cache_vide = dir_vide.cache();
            let resultat = rune_pages_with(
                &cache_vide,
                "Ahri",
                "mid",
                "EUW1",
                |_c: String, _p: String, _s: String| async {
                    Err::<RunesRow, _>(AppError::Network("MCP KO".to_string()))
                },
                || async { Ok(HashMap::new()) },
            )
            .await;
            match resultat {
                Err(AppError::Network(message)) => {
                    assert!(message.contains("Aucune page de runes"), "{message}");
                }
                autre => panic!("erreur attendue, reçu : {autre:?}"),
            }

            // 6. Paramètres invalides refusés avant tout fetch.
            let page_appele = AtomicBool::new(false);
            let resultat = rune_pages_with(
                &cache,
                "Ahri",
                "bot",
                "EUW1",
                |_c: String, _p: String, _s: String| {
                    page_appele.store(true, Ordering::Relaxed);
                    async { Err::<RunesRow, _>(AppError::Network("KO".to_string())) }
                },
                || async { Ok(HashMap::new()) },
            )
            .await;
            assert!(matches!(resultat, Err(AppError::InvalidId(_))));
            assert!(!page_appele.load(Ordering::Relaxed));
        });
    }

    #[test]
    fn load_perk_catalog_cache_et_repli() {
        tauri::async_runtime::block_on(async {
            let dir = temp_dir("meta-perks");
            let cache = dir.cache();
            let path = community_cache_path(cache.root());
            let catalogue = catalogue_fragments();

            // Cache frais : fetch non appelé.
            write_meta_cache(
                &path,
                &MetaCacheEntry {
                    fetched_at_ms: 1_000,
                    data: catalogue.clone(),
                },
            )
            .expect("cache perks");
            let appele = AtomicBool::new(false);
            let (catalogue_relu, warning) = load_perk_catalog(&cache, 1_500, || {
                appele.store(true, Ordering::Relaxed);
                async { Ok(HashMap::new()) }
            })
            .await;
            assert!(!appele.load(Ordering::Relaxed));
            assert_eq!(catalogue_relu.len(), 4);
            assert!(warning.is_none());

            // Cache expiré + fetch KO → cache réel + warning.
            let (catalogue_relu, warning) =
                load_perk_catalog(&cache, 10 * PERKS_TTL_MS, || async {
                    Err::<HashMap<u32, String>, _>(AppError::Network("CDN KO".to_string()))
                })
                .await;
            assert_eq!(catalogue_relu.len(), 4);
            let warning = warning.expect("warning");
            assert!(warning.contains("Community Dragon"), "{warning}");

            // Aucun cache + fetch KO → catalogue vide + warning.
            std::fs::remove_file(&path).expect("suppression cache perks");
            let (catalogue_vide, warning) = load_perk_catalog(&cache, 0, || async {
                Err::<HashMap<u32, String>, _>(AppError::Network("CDN KO".to_string()))
            })
            .await;
            assert!(catalogue_vide.is_empty());
            let warning = warning.expect("warning");
            assert!(warning.contains("Community Dragon"), "{warning}");
        });
    }
}
