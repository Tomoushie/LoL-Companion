//! Erreur applicative unique, convertie en chaîne lisible côté commandes Tauri.

use std::fmt;

#[derive(Debug)]
pub enum AppError {
    /// Lecture/écriture du cache local.
    Io(String),
    /// Appel réseau Data Dragon.
    Network(String),
    /// JSON Data Dragon illisible ou inattendu.
    Parse(String),
    /// Donnée attendue absente du cache.
    CacheAbsent(String),
    /// Version Data Dragon refusée (forme inattendue, path traversal…).
    InvalidVersion(String),
    /// Identifiant demandé refusé (inconnu du cache, vide, path traversal…).
    InvalidId(String),
    /// Configuration locale invalide (clé API Riot, chemins…).
    Config(String),
    /// Erreur renvoyée par l'API Riot (401, 403, 404, 429…).
    Riot(String),
}

impl AppError {
    pub fn io(context: &str, err: impl fmt::Display) -> Self {
        Self::Io(format!("{context} : {err}"))
    }

    pub fn network(context: &str, err: impl fmt::Display) -> Self {
        Self::Network(format!("{context} : {err}"))
    }

    pub fn parse(context: &str, err: impl fmt::Display) -> Self {
        Self::Parse(format!("{context} : {err}"))
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io(msg) | Self::Network(msg) | Self::Parse(msg) => f.write_str(msg),
            Self::CacheAbsent(msg)
            | Self::InvalidVersion(msg)
            | Self::InvalidId(msg)
            | Self::Config(msg)
            | Self::Riot(msg) => f.write_str(msg),
        }
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::Io(format!("accès disque : {err}"))
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::Parse(format!("JSON invalide : {err}"))
    }
}

pub type AppResult<T> = Result<T, AppError>;
