//! Cache local des données statiques Data Dragon.
//!
//! Arborescence (racine par défaut `%APPDATA%\LoL BOT\cache`) :
//!
//! ```text
//! <racine>/
//!   meta.json                       # version active, dernière sync, dernière erreur
//!   ddragon/<version>/
//!     champion.json
//!     item.json
//!     runesReforged.json
//!     champion/<Id>.json           # fiches détaillées (à la demande)
//!     img/champion/<icône>.png
//!     img/champion/splash/<Id>_0.jpg
//!     img/item/<icône>.png
//!     img/spell/<icône>.png
//!     img/passive/<icône>.png
//! ```
//!
//! Chaque écriture passe par un fichier temporaire dans le même dossier puis un
//! renommage atomique : une interruption ne laisse jamais un fichier tronqué à
//! la place d'un fichier valide. `meta.json` est toujours écrit en dernier par
//! la synchronisation.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::ddragon;
use crate::error::{AppError, AppResult};
use crate::model::{DataStatus, DatasetCounts};

/// Variable d'environnement permettant de remplacer la racine du cache
/// (tests unitaires et scénarios e2e). Le chemin doit être absolu.
pub const CACHE_DIR_ENV: &str = "LOL_BOT_CACHE_DIR";

/// Nom du fichier de méta du cache.
pub const META_FILE: &str = "meta.json";

/// Sous-dossier contenant une arborescence par version Data Dragon.
const DDRAGON_DIR: &str = "ddragon";

/// Sous-dossier des icônes de champions (relatif à une version).
const ICONS_SUBDIR: &str = "img/champion";

/// Sous-dossier des splash arts de champions (relatif à une version).
const SPLASH_SUBDIR: &str = "img/champion/splash";

/// Sous-dossier des icônes d'objets.
const ITEM_ICONS_SUBDIR: &str = "img/item";

/// Sous-dossier des icônes de sorts.
const SPELL_ICONS_SUBDIR: &str = "img/spell";

/// Sous-dossier des icônes de passifs.
const PASSIVE_ICONS_SUBDIR: &str = "img/passive";

/// Sous-dossier des fiches champion détaillées.
const CHAMPION_DETAIL_SUBDIR: &str = "champion";

/// Sous-dossier de la localisation `fr_FR` des runes.
const RUNES_LOCALE_DIR: &str = "fr_FR";

/// Racine des icônes servies par le CDN sans version (runes, splash…).
const IMG_SUBDIR: &str = "img";

/// Fichiers de données critiques de Data Dragon.
pub const CHAMPION_FILE: &str = "champion.json";
pub const ITEM_FILE: &str = "item.json";
pub const RUNES_FILE: &str = "runesReforged.json";

/// Compteur utilisé pour nommer les fichiers temporaires d'écriture atomique.
static TEMP_FILE_COUNTER: AtomicU64 = AtomicU64::new(0);

/// Contenu de `meta.json`.
///
/// La forme sérialisée est figée (`camelCase`) :
/// `{ "version": "16.21.1", "updatedAt": "…", "lastSyncError": null }`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CacheMeta {
    /// Version Data Dragon active, `None` tant qu'aucune synchronisation n'a réussi.
    pub version: Option<String>,
    /// Horodatage RFC 3339 UTC de la dernière synchronisation réussie.
    pub updated_at: Option<String>,
    /// Message réel de la dernière synchronisation en échec (mode hors ligne).
    pub last_sync_error: Option<String>,
}

/// Résout la racine du cache local.
///
/// Priorité à la variable d'environnement `LOL_BOT_CACHE_DIR` (chemin absolu),
/// sinon `app.path().data_dir()/LoL BOT/cache` (≈ `%APPDATA%\LoL BOT\cache`).
/// Aucun dossier n'est créé ici : la lecture du statut doit rester sans effet de bord.
pub fn resolve_cache_root(app: &tauri::AppHandle) -> AppResult<PathBuf> {
    if let Some(raw) = std::env::var_os(CACHE_DIR_ENV) {
        if !raw.is_empty() {
            let root = PathBuf::from(raw);
            if !root.is_absolute() {
                return Err(AppError::Io(format!(
                    "{CACHE_DIR_ENV} doit être un chemin absolu ; valeur reçue : « {} »",
                    root.display()
                )));
            }
            return Ok(root);
        }
    }

    let data_dir = app
        .path()
        .data_dir()
        .map_err(|err| AppError::io("dossier de données de l'application", err))?;
    Ok(data_dir.join("LoL BOT").join("cache"))
}

/// Accès typé au cache local Data Dragon.
#[derive(Debug, Clone)]
pub struct Cache {
    root: PathBuf,
}

impl Cache {
    /// Construit un cache à partir d'une racine déjà résolue.
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// Racine absolue du cache.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Crée la racine du cache si nécessaire.
    pub fn ensure_root(&self) -> AppResult<()> {
        fs::create_dir_all(&self.root)
            .map_err(|err| AppError::io(&format!("création du cache {}", self.root.display()), err))
    }

    /// Chemin du fichier de méta.
    pub fn meta_path(&self) -> PathBuf {
        self.root.join(META_FILE)
    }

    /// Dossier d'une version Data Dragon, après validation du nom de version.
    pub fn version_dir(&self, version: &str) -> AppResult<PathBuf> {
        ddragon::validate_version(version)?;
        Ok(self.root.join(DDRAGON_DIR).join(version))
    }

    /// Chemin d'un fichier de données (`champion.json`, `item.json`, …).
    pub fn data_file(&self, version: &str, file: &str) -> AppResult<PathBuf> {
        Ok(self.version_dir(version)?.join(file))
    }

    /// Chemin d'une icône de champion.
    ///
    /// `image_file` doit provenir de [`ddragon::champion_icon_file`] : ce nom est
    /// validé en amont et ne peut pas contenir de séparateur de chemin.
    pub fn icon_path(&self, version: &str, image_file: &str) -> PathBuf {
        self.root
            .join(DDRAGON_DIR)
            .join(version)
            .join(ICONS_SUBDIR)
            .join(image_file)
    }

    /// Vrai si l'icône de champion est réellement présente et ressemble à un PNG.
    pub fn icon_exists(&self, version: &str, image_file: &str) -> bool {
        self.png_exists(&self.icon_path(version, image_file))
    }

    /// Chemin d'une icône d'objet (`img/item/<image.full>`).
    pub fn item_icon_path(&self, version: &str, image_file: &str) -> PathBuf {
        self.root
            .join(DDRAGON_DIR)
            .join(version)
            .join(ITEM_ICONS_SUBDIR)
            .join(image_file)
    }

    /// Chemin d'une icône de sort (`img/spell/<image.full>`).
    pub fn spell_icon_path(&self, version: &str, image_file: &str) -> PathBuf {
        self.root
            .join(DDRAGON_DIR)
            .join(version)
            .join(SPELL_ICONS_SUBDIR)
            .join(image_file)
    }

    /// Chemin d'une icône de passif (`img/passive/<image.full>`).
    pub fn passive_icon_path(&self, version: &str, image_file: &str) -> PathBuf {
        self.root
            .join(DDRAGON_DIR)
            .join(version)
            .join(PASSIVE_ICONS_SUBDIR)
            .join(image_file)
    }

    /// Chemin du splash art d'un champion (`img/champion/splash/<Id>_0.jpg`).
    ///
    /// `champion_id` doit être validé en amont (connu de `champion.json` et
    /// conforme à [`ddragon::is_valid_champion_id`]).
    pub fn splash_path(&self, version: &str, champion_id: &str) -> PathBuf {
        self.root
            .join(DDRAGON_DIR)
            .join(version)
            .join(SPLASH_SUBDIR)
            .join(format!("{champion_id}_0.jpg"))
    }

    /// Chemin de la fiche détaillée d'un champion (`champion/<Id>.json`).
    ///
    /// `champion_id` doit être validé en amont (connu de `champion.json`).
    pub fn champion_detail_file(&self, version: &str, champion_id: &str) -> AppResult<PathBuf> {
        if !ddragon::is_valid_champion_id(champion_id) {
            return Err(AppError::InvalidId(format!(
                "identifiant de champion refusé : « {champion_id} »"
            )));
        }
        Ok(self
            .version_dir(version)?
            .join(CHAMPION_DETAIL_SUBDIR)
            .join(format!("{champion_id}.json")))
    }

    /// Chemin du fichier de runes localisé `fr_FR` (`fr_FR/runesReforged.json`).
    pub fn localized_runes_file(&self, version: &str) -> AppResult<PathBuf> {
        Ok(self
            .version_dir(version)?
            .join(RUNES_LOCALE_DIR)
            .join(RUNES_FILE))
    }

    /// Chemin local d'une icône de rune/arbre (`img/<chemin relatif>`).
    ///
    /// Renvoie `None` si le chemin relatif fourni par Riot n'est pas sûr : rien ne
    /// doit être lu ni écrit hors du cache.
    pub fn rune_icon_path(&self, version: &str, icon: &str) -> Option<PathBuf> {
        if !ddragon::is_valid_icon_rel_path(icon) {
            return None;
        }
        let mut path = self.version_dir(version).ok()?.join(IMG_SUBDIR);
        for segment in icon.split('/') {
            path.push(segment);
        }
        Some(path)
    }

    /// Chemin absolu d'une icône de rune présente et valide (PNG), sinon `None`.
    pub fn rune_icon_local_path(&self, version: &str, icon: &str) -> Option<String> {
        let path = self.rune_icon_path(version, icon)?;
        self.png_exists(&path)
            .then(|| path.to_string_lossy().into_owned())
    }

    /// Vrai si le fichier existe et ressemble à un PNG (signature vérifiée).
    pub fn png_exists(&self, path: &Path) -> bool {
        fs::read(path)
            .map(|bytes| ddragon::is_png(&bytes))
            .unwrap_or(false)
    }

    /// Vrai si le fichier existe et ressemble à un JPEG (signature vérifiée).
    pub fn jpeg_exists(&self, path: &Path) -> bool {
        fs::read(path)
            .map(|bytes| ddragon::is_jpeg(&bytes))
            .unwrap_or(false)
    }

    /// Lit des octets bruts, avec un contexte d'erreur lisible.
    pub fn read_bytes(&self, path: &Path) -> AppResult<Vec<u8>> {
        fs::read(path).map_err(|err| AppError::io(&format!("lecture de {}", path.display()), err))
    }

    /// Écrit des octets de façon atomique (fichier temporaire puis renommage).
    pub fn write_bytes(&self, path: &Path, bytes: &[u8]) -> AppResult<()> {
        write_bytes_atomic(path, bytes)
    }

    /// Sérialise puis écrit un fichier JSON de façon atomique.
    pub fn write_json<T: Serialize>(&self, path: &Path, value: &T) -> AppResult<()> {
        let bytes = serde_json::to_vec_pretty(value)
            .map_err(|err| AppError::parse(&format!("encodage de {}", path.display()), err))?;
        write_bytes_atomic(path, &bytes)
    }

    /// Lit la méta du cache. `Ok(None)` si le cache n'en contient pas encore.
    pub fn read_meta(&self) -> AppResult<Option<CacheMeta>> {
        let path = self.meta_path();
        match fs::read(&path) {
            Ok(bytes) => {
                let meta = serde_json::from_slice(&bytes).map_err(|err| {
                    AppError::parse(
                        &format!("méta du cache illisible ({})", path.display()),
                        err,
                    )
                })?;
                Ok(Some(meta))
            }
            Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(err) => Err(AppError::io(&format!("lecture de {}", path.display()), err)),
        }
    }

    /// Écrit la méta du cache de façon atomique.
    pub fn write_meta(&self, meta: &CacheMeta) -> AppResult<()> {
        self.write_json(&self.meta_path(), meta)
    }

    /// Version Data Dragon active (validée) si une méta en désigne une.
    pub fn active_version(&self) -> AppResult<Option<String>> {
        match self.read_meta()? {
            Some(meta) => match meta.version {
                Some(version) => {
                    ddragon::validate_version(&version)?;
                    Ok(Some(version))
                }
                None => Ok(None),
            },
            None => Ok(None),
        }
    }

    /// Lit un fichier de données critique ; `CacheAbsent` si le fichier manque.
    pub fn read_data_file(&self, version: &str, file: &str) -> AppResult<Vec<u8>> {
        let path = self.data_file(version, file)?;
        match fs::read(&path) {
            Ok(bytes) => Ok(bytes),
            Err(err) if err.kind() == io::ErrorKind::NotFound => Err(AppError::CacheAbsent(format!(
                "{file} absent du cache pour la version {version} : relancez une synchronisation Data Dragon."
            ))),
            Err(err) => Err(AppError::io(&format!("lecture de {}", path.display()), err)),
        }
    }

    /// Vrai si la méta pointe vers une version dont les trois fichiers critiques
    /// sont présents et lisibles : c'est la définition d'un cache « valide »
    /// utilisable en mode hors ligne.
    pub fn has_valid_dataset(&self) -> bool {
        let Some(version) = self.active_version().ok().flatten() else {
            return false;
        };
        [CHAMPION_FILE, ITEM_FILE, RUNES_FILE].iter().all(|file| {
            self.read_data_file(&version, file)
                .ok()
                .map(|bytes| dataset_is_valid(file, &bytes))
                == Some(true)
        })
    }

    /// Supprime les dossiers de versions autres que la version active.
    ///
    /// Renvoie la liste des messages d'échec (purge au mieux : un fichier
    /// verrouillé ne doit pas faire échouer une synchronisation réussie).
    pub fn purge_other_versions(&self, keep: &str) -> Vec<String> {
        let versions_root = self.root.join(DDRAGON_DIR);
        let entries = match fs::read_dir(&versions_root) {
            Ok(entries) => entries,
            Err(err) if err.kind() == io::ErrorKind::NotFound => return Vec::new(),
            Err(err) => {
                return vec![format!(
                    "purge des anciennes versions impossible ({} : {err})",
                    versions_root.display()
                )]
            }
        };

        let mut failures = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().into_owned();
            if name == keep || !path.is_dir() {
                continue;
            }
            if let Err(err) = fs::remove_dir_all(&path) {
                failures.push(format!(
                    "purge de l'ancienne version {} impossible : {err}",
                    path.display()
                ));
            }
        }
        failures
    }
}

/// Vrai si les octets correspondent au fichier Data Dragon attendu.
///
/// Partagé par le statut, la synchronisation et le repli hors ligne pour que la
/// notion de fichier « lisible » soit identique partout.
pub fn dataset_is_valid(file: &str, bytes: &[u8]) -> bool {
    match file {
        CHAMPION_FILE => ddragon::parse_champions(bytes).is_ok(),
        ITEM_FILE => ddragon::parse_items(bytes).is_ok(),
        RUNES_FILE => ddragon::parse_rune_trees(bytes).is_ok(),
        _ => false,
    }
}

/// Construit l'état de la donnée à partir du seul cache local (aucun réseau).
///
/// Un cache totalement absent n'est pas une erreur : le statut est renvoyé avec
/// une version nulle, des compteurs à zéro et `offline = false`.
pub fn status_from_cache(cache: &Cache) -> AppResult<DataStatus> {
    let mut status = DataStatus {
        version: None,
        cache_dir: cache.root().to_string_lossy().into_owned(),
        updated_at: None,
        offline: false,
        warning: None,
        counts: DatasetCounts::default(),
    };

    let Some(meta) = cache.read_meta()? else {
        return Ok(status);
    };

    status.offline = meta.last_sync_error.is_some();
    status.warning = meta.last_sync_error.clone();
    status.updated_at = meta.updated_at.clone();

    let Some(version) = meta.version else {
        return Ok(status);
    };
    ddragon::validate_version(&version)?;
    status.counts = counts_for_version(cache, &version);
    status.version = Some(version);
    Ok(status)
}

/// Compteurs calculés uniquement sur les fichiers réellement présents.
///
/// Un fichier absent ou illisible donne simplement un compteur à zéro : le
/// statut reste consultable même si le cache est incomplet.
fn counts_for_version(cache: &Cache, version: &str) -> DatasetCounts {
    let mut counts = DatasetCounts::default();

    if let Some(champions) = cache
        .read_data_file(version, CHAMPION_FILE)
        .ok()
        .and_then(|bytes| ddragon::parse_champions(&bytes).ok())
    {
        counts.champions = champions.len();
        counts.icons_cached = champions
            .iter()
            .filter_map(ddragon::champion_icon_file)
            .filter(|image_file| cache.icon_exists(version, image_file))
            .count();
    }

    if let Some(bytes) = cache.read_data_file(version, ITEM_FILE).ok() {
        if let Some(items) = ddragon::parse_items(&bytes).ok() {
            counts.items = items.len();
        }
        if let Some(fichiers) = ddragon::item_icon_files(&bytes).ok() {
            counts.item_icons_cached = fichiers
                .iter()
                .filter(|fichier| cache.png_exists(&cache.item_icon_path(version, fichier)))
                .count();
        }
    }

    if let Some(bytes) = cache.read_data_file(version, RUNES_FILE).ok() {
        if let Some(rune_trees) = ddragon::parse_rune_trees(&bytes).ok() {
            counts.rune_trees = rune_trees.len();
        }
        if let Some(icones) = ddragon::rune_icon_files(&bytes).ok() {
            counts.rune_icons_cached = icones
                .files
                .iter()
                .filter(|icone| {
                    cache
                        .rune_icon_path(version, icone)
                        .map(|path| cache.png_exists(&path))
                        .unwrap_or(false)
                })
                .count();
        }
    }

    counts
}

/// Écriture atomique : fichier temporaire dans le dossier cible, puis renommage.
pub(crate) fn write_bytes_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    let parent = path
        .parent()
        .ok_or_else(|| AppError::Io(format!("chemin de cache invalide : {}", path.display())))?;
    fs::create_dir_all(parent)
        .map_err(|err| AppError::io(&format!("création du dossier {}", parent.display()), err))?;

    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cache".to_string());
    let counter = TEMP_FILE_COUNTER.fetch_add(1, Ordering::Relaxed);
    let temp_path = parent.join(format!(".{file_name}.tmp-{}-{counter}", std::process::id()));

    let write_result = (|| -> io::Result<()> {
        use std::io::Write;
        let mut file = fs::File::create(&temp_path)?;
        file.write_all(bytes)?;
        file.sync_all()
    })();

    if let Err(err) = write_result {
        let _ = fs::remove_file(&temp_path);
        return Err(AppError::io(
            &format!("écriture de {}", path.display()),
            err,
        ));
    }

    if let Err(err) = fs::rename(&temp_path, path) {
        let _ = fs::remove_file(&temp_path);
        return Err(AppError::io(
            &format!("renommage vers {}", path.display()),
            err,
        ));
    }

    Ok(())
}

/// Support de test partagé (dossiers temporaires uniques, nettoyés en fin de test).
#[cfg(test)]
pub(crate) mod test_support {
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};

    use crate::cache::Cache;

    static TEMP_DIR_COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Dossier temporaire supprimé automatiquement au drop.
    pub(crate) struct TempDir {
        path: PathBuf,
    }

    impl TempDir {
        /// Cache adossé à ce dossier (les sous-dossiers sont créés à l'écriture).
        pub(crate) fn cache(&self) -> Cache {
            Cache::new(&self.path)
        }

        /// Chemin absolu du dossier temporaire.
        pub(crate) fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    /// Crée un dossier temporaire unique pour un test.
    pub(crate) fn temp_dir(label: &str) -> TempDir {
        let unique = TEMP_DIR_COUNTER.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "lol-bot-test-{label}-{}-{unique}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&path);
        if let Err(err) = fs::create_dir_all(&path) {
            panic!("impossible de créer le dossier temporaire de test : {err}");
        }
        TempDir { path }
    }
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::Path;

    use super::test_support::temp_dir;
    use super::*;

    const CHAMPIONS_JSON: &str = r#"{
        "type": "champion",
        "format": "standAloneComplex",
        "version": "16.21.1",
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
                "image": { "full": "Zed.png" }
            }
        }
    }"#;

    const ITEMS_JSON: &str = r#"{
        "data": {
            "1001": {
                "name": "Bottes de vitesse",
                "plaintext": "Vitesse de déplacement",
                "description": "<mainText>+<speed>25</speed> vitesse &amp; détails<br>suite</mainText>",
                "gold": { "total": 300 },
                "purchasable": true,
                "tags": ["Boots"],
                "maps": { "11": true, "12": false },
                "image": { "full": "1001.png" },
                "stats": { "FlatMovementSpeedMod": 25, "FlatHPPoolMod": 150.5 }
            },
            "1002": {
                "name": "",
                "description": "objet sans nom",
                "maps": { "11": true }
            },
            "1003": {
                "name": "Épée longue",
                "description": "<i>dégâts</i>",
                "gold": { "total": 350.0 },
                "purchasable": true,
                "tags": ["Damage"],
                "maps": { "11": false },
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
                            "icon": "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png"
                        }
                    ]
                }
            ]
        }
    ]"#;

    const VERSION: &str = "16.21.1";

    fn ecrire_datasets(cache: &Cache) {
        let champion_path = cache
            .data_file(VERSION, CHAMPION_FILE)
            .expect("chemin champions");
        cache
            .write_bytes(&champion_path, CHAMPIONS_JSON.as_bytes())
            .expect("écriture champion.json");
        let item_path = cache.data_file(VERSION, ITEM_FILE).expect("chemin objets");
        cache
            .write_bytes(&item_path, ITEMS_JSON.as_bytes())
            .expect("écriture item.json");
        let runes_path = cache.data_file(VERSION, RUNES_FILE).expect("chemin runes");
        cache
            .write_bytes(&runes_path, RUNES_JSON.as_bytes())
            .expect("écriture runesReforged.json");
    }

    #[test]
    fn meta_et_fichiers_roundtrip_atomique() {
        let dir = temp_dir("meta");
        let cache = dir.cache();
        cache.ensure_root().expect("création du cache");

        assert_eq!(cache.read_meta().expect("méta absente"), None);

        let meta = CacheMeta {
            version: Some(VERSION.to_string()),
            updated_at: Some("2026-10-30T10:00:00Z".to_string()),
            last_sync_error: None,
        };
        cache.write_meta(&meta).expect("écriture de la méta");
        assert_eq!(cache.read_meta().expect("lecture de la méta"), Some(meta));

        let data_path = cache.data_file(VERSION, CHAMPION_FILE).expect("chemin");
        cache
            .write_bytes(&data_path, b"premier contenu")
            .expect("première écriture");
        cache
            .write_bytes(&data_path, b"second contenu")
            .expect("écriture de remplacement");
        assert_eq!(
            cache.read_bytes(&data_path).expect("lecture"),
            b"second contenu".to_vec()
        );

        // Aucun fichier temporaire ne doit rester après des écritures réussies.
        let mut restes = Vec::new();
        for entry in fs::read_dir(&data_path.parent().expect("dossier parent"))
            .expect("lecture du dossier")
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.contains(".tmp-") {
                restes.push(name);
            }
        }
        assert!(
            restes.is_empty(),
            "fichiers temporaires restants : {restes:?}"
        );
    }

    #[test]
    fn statut_cache_absent_est_un_succes_vide() {
        let dir = temp_dir("statut-vide");
        let cache = dir.cache();

        let status = status_from_cache(&cache).expect("statut sans cache");
        assert_eq!(status.version, None);
        assert_eq!(status.updated_at, None);
        assert!(!status.offline);
        assert_eq!(status.warning, None);
        assert_eq!(status.counts, DatasetCounts::default());
        assert!(Path::new(&status.cache_dir).is_absolute());
    }

    #[test]
    fn statut_compte_les_fichiers_et_signale_le_hors_ligne() {
        let dir = temp_dir("statut-complet");
        let cache = dir.cache();
        cache.ensure_root().expect("création du cache");
        ecrire_datasets(&cache);

        // Deux icônes de champions réellement présentes dans le cache.
        let ahri = cache.icon_path(VERSION, "Ahri.png");
        cache
            .write_bytes(&ahri, b"\x89PNG\r\n\x1a\nahri")
            .expect("icône Ahri");
        let zed = cache.icon_path(VERSION, "Zed.png");
        cache
            .write_bytes(&zed, b"\x89PNG\r\n\x1a\nzed")
            .expect("icône Zed");

        // Deux icônes d'objets réellement présentes dans le cache.
        for image_file in ["1001.png", "1003.png"] {
            cache
                .write_bytes(
                    &cache.item_icon_path(VERSION, image_file),
                    b"\x89PNG\r\n\x1a\nobjet",
                )
                .expect("icône d'objet");
        }

        // Icône d'arbre + icône de rune réellement présentes dans le cache.
        for icone in [
            "perk-images/Styles/7201_Precision.png",
            "perk-images/Styles/Precision/PressTheAttack/PressTheAttack.png",
        ] {
            let path = cache
                .rune_icon_path(VERSION, icone)
                .expect("chemin d'icône de rune");
            cache
                .write_bytes(&path, b"\x89PNG\r\n\x1a\nrune")
                .expect("icône de rune");
        }

        let meta = CacheMeta {
            version: Some(VERSION.to_string()),
            updated_at: Some("2026-10-30T10:00:00Z".to_string()),
            last_sync_error: Some("réseau indisponible (test)".to_string()),
        };
        cache.write_meta(&meta).expect("écriture de la méta");

        let status = status_from_cache(&cache).expect("statut complet");
        assert_eq!(status.version.as_deref(), Some(VERSION));
        assert_eq!(status.updated_at.as_deref(), Some("2026-10-30T10:00:00Z"));
        assert!(status.offline);
        assert_eq!(
            status.warning.as_deref(),
            Some("réseau indisponible (test)")
        );
        assert_eq!(status.counts.champions, 2);
        assert_eq!(status.counts.icons_cached, 2);
        assert_eq!(status.counts.items, 2);
        assert_eq!(status.counts.item_icons_cached, 2);
        assert_eq!(status.counts.rune_trees, 1);
        assert_eq!(status.counts.rune_icons_cached, 2);
    }

    #[test]
    fn chemins_d_assets_v0_2() {
        let dir = temp_dir("chemins-assets");
        let cache = dir.cache();
        let racine_version = cache.version_dir(VERSION).expect("dossier version");

        assert_eq!(
            cache.item_icon_path(VERSION, "1001.png"),
            racine_version.join("img").join("item").join("1001.png")
        );
        assert_eq!(
            cache.spell_icon_path(VERSION, "AatroxQ.png"),
            racine_version.join("img").join("spell").join("AatroxQ.png")
        );
        assert_eq!(
            cache.passive_icon_path(VERSION, "Aatrox_Passive.png"),
            racine_version
                .join("img")
                .join("passive")
                .join("Aatrox_Passive.png")
        );
        assert_eq!(
            cache.splash_path(VERSION, "Aatrox"),
            racine_version
                .join("img")
                .join("champion")
                .join("splash")
                .join("Aatrox_0.jpg")
        );
        assert_eq!(
            cache
                .champion_detail_file(VERSION, "Aatrox")
                .expect("fiche valide"),
            racine_version.join("champion").join("Aatrox.json")
        );
        assert_eq!(
            cache.localized_runes_file(VERSION).expect("chemin fr_FR"),
            racine_version.join("fr_FR").join(RUNES_FILE)
        );
        assert_eq!(
            cache
                .rune_icon_path(VERSION, "perk-images/Styles/7201_Precision.png")
                .expect("chemin d'icône de rune"),
            racine_version
                .join("img")
                .join("perk-images")
                .join("Styles")
                .join("7201_Precision.png")
        );

        // Chemins relatifs d'icônes de runes refusés : rien hors du cache.
        for icone in [
            "",
            ".",
            "..",
            "/perk-images/Styles/x.png",
            "../perk-images/x.png",
            "perk-images/../../x.png",
            "perk-images//x.png",
            "perk-images\\Styles\\x.png",
            "perk-images/Styles/x é.png",
        ] {
            assert!(
                cache.rune_icon_path(VERSION, icone).is_none(),
                "« {icone} » aurait dû être refusé"
            );
            assert!(
                !ddragon::is_valid_icon_rel_path(icone),
                "validation directe : « {icone} »"
            );
        }

        // Identifiants de fiche refusés avant toute construction de chemin.
        for id in ["", "..", "../Aatrox", "Aatrox/../../etc", "a\\b"] {
            assert!(
                matches!(
                    cache.champion_detail_file(VERSION, id),
                    Err(AppError::InvalidId(_))
                ),
                "id « {id} » aurait dû être refusé"
            );
        }

        // Signatures : un fichier absent n'existe pas ; un faux PNG non plus.
        let faux_png = cache.item_icon_path(VERSION, "faux.png");
        cache
            .write_bytes(&faux_png, b"pas un png")
            .expect("faux png");
        assert!(!cache.png_exists(&faux_png));
        let splash = cache.splash_path(VERSION, "Aatrox");
        assert!(!cache.jpeg_exists(&splash));
        cache
            .write_bytes(&splash, b"pas un jpeg")
            .expect("faux jpeg");
        assert!(!cache.jpeg_exists(&splash));
        cache
            .write_bytes(&splash, b"\xFF\xD8\xFF\xE0vrai jpeg")
            .expect("jpeg");
        assert!(cache.jpeg_exists(&splash));
    }

    #[test]
    fn meta_illisible_est_une_erreur_explicite() {
        let dir = temp_dir("meta-corrompue");
        let cache = dir.cache();
        cache.ensure_root().expect("création du cache");
        fs::write(cache.meta_path(), b"{ pas du json").expect("écriture corrompue");

        let erreur = status_from_cache(&cache).expect_err("méta corrompue");
        assert!(
            matches!(erreur, AppError::Parse(_)),
            "erreur inattendue : {erreur}"
        );
        assert!(!cache.has_valid_dataset());
    }

    #[test]
    fn purge_conserve_la_version_courante() {
        let dir = temp_dir("purge");
        let cache = dir.cache();

        for version in ["16.1.1", "16.2.1"] {
            let ancien = cache.data_file(version, CHAMPION_FILE).expect("chemin");
            cache
                .write_bytes(&ancien, b"{}")
                .expect("écriture d'une ancienne version");
        }

        let echecs = cache.purge_other_versions("16.2.1");
        assert!(echecs.is_empty(), "échecs de purge : {echecs:?}");
        assert!(!dir.path().join("ddragon").join("16.1.1").exists());
        assert!(dir.path().join("ddragon").join("16.2.1").exists());
    }

    #[test]
    fn cache_valide_exige_les_trois_fichiers() {
        let dir = temp_dir("validite");
        let cache = dir.cache();
        cache.ensure_root().expect("création du cache");
        ecrire_datasets(&cache);
        cache
            .write_meta(&CacheMeta {
                version: Some(VERSION.to_string()),
                updated_at: None,
                last_sync_error: None,
            })
            .expect("méta");

        assert!(cache.has_valid_dataset());

        fs::remove_file(cache.data_file(VERSION, ITEM_FILE).expect("chemin"))
            .expect("suppression item.json");
        assert!(!cache.has_valid_dataset());
    }
}
