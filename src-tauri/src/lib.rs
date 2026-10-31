//! Backend Rust de LoL BOT (V0.6).
//!
//! Architecture : application 100 % locale, sans backend réseau dédié.
//! Le module `ddragon` télécharge et met en cache les données statiques Riot
//! (Data Dragon) dans `%APPDATA%\LoL BOT\cache`, le module `riot` interroge
//! l'API Riot officielle avec une clé locale, un rate-limiter strict et un cache
//! isolé, le module `meta` récupère la méta OP.GG (MCP public) avec son propre
//! cache, et `commands` expose le tout au frontend via des commandes Tauri.

use tauri::Manager;

pub mod error;
pub mod model;
pub mod riot;

mod cache;
mod commands;
mod ddragon;
mod esports;
mod meta;

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            // Le protocole `asset` sert les icônes du cache local à la WebView
            // (`http://asset.localhost/...`). On autorise explicitement le
            // dossier de cache courant, y compris quand il est remplacé par
            // `LOL_BOT_CACHE_DIR` (tests/e2e) : la portée statique de
            // `tauri.conf.json` ne connaît pas cette variable.
            // Un cache inaccessible ne doit pas empêcher l'app de démarrer :
            // l'UI affichera l'erreur réelle via les commandes.
            match cache::resolve_cache_root(app.handle()) {
                Ok(root) => {
                    if let Err(err) = std::fs::create_dir_all(&root) {
                        eprintln!("[lol-bot] cache inaccessible ({}) : {err}", root.display());
                    }
                    if let Err(err) = app.asset_protocol_scope().allow_directory(&root, true) {
                        eprintln!(
                            "[lol-bot] portée du protocole asset non configurée ({}) : {err}",
                            root.display()
                        );
                    }
                }
                Err(err) => eprintln!("[lol-bot] racine de cache invalide : {err}"),
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_data_status,
            commands::sync_ddragon,
            commands::get_champions,
            commands::get_items,
            commands::get_rune_trees,
            commands::get_champion_detail,
            commands::get_riot_key_status,
            commands::set_riot_api_key,
            commands::clear_riot_api_key,
            commands::get_riot_platforms,
            commands::get_riot_profile,
            commands::get_riot_match,
            commands::get_riot_progression,
            commands::get_meta_tier_list,
            commands::get_meta_builds,
            commands::get_meta_rune_pages,
            commands::get_esports_leagues,
            commands::get_esports_teams,
            commands::get_esports_team,
            commands::get_esports_tournaments,
            commands::get_esports_standings,
        ])
        .run(tauri::generate_context!())
        .expect("échec du lancement de LoL BOT");
}
