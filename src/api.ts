import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  Champion,
  ChampionDetail,
  DataStatus,
  EsportsLeague,
  EsportsStanding,
  EsportsTeam,
  EsportsTeamDetail,
  EsportsTournament,
  Item,
  MetaBuild,
  MetaRunePages,
  MetaTierList,
  RiotKeyStatus,
  RiotMatchDetail,
  RiotPlatformInfo,
  RiotProfile,
  RiotProgression,
  RuneTree,
} from "./types";

/**
 * Pont unique entre l'interface et le backend Rust.
 * Aucune commande Tauri ne doit être appelée en dehors de ce module.
 */
export const api = {
  getDataStatus: (): Promise<DataStatus> => invoke<DataStatus>("get_data_status"),
  syncDdragon: (): Promise<DataStatus> => invoke<DataStatus>("sync_ddragon"),
  getChampions: (): Promise<Champion[]> => invoke<Champion[]>("get_champions"),
  getItems: (): Promise<Item[]> => invoke<Item[]>("get_items"),
  getRuneTrees: (): Promise<RuneTree[]> => invoke<RuneTree[]>("get_rune_trees"),
  /**
   * Fiche complète d'un champion (stats, splash, sorts) depuis le cache local.
   * Télécharge la fiche et ses assets à la première ouverture si nécessaire.
   */
  getChampionDetail: (id: string): Promise<ChampionDetail> =>
    invoke<ChampionDetail>("get_champion_detail", { id }),

  // --- Riot API (V0.5) ---------------------------------------------------
  /** État de la clé API Riot (la clé n'est jamais renvoyée au frontend). */
  getRiotKeyStatus: (): Promise<RiotKeyStatus> => invoke<RiotKeyStatus>("get_riot_key_status"),
  /** Enregistre la clé API localement (fichier hors dépôt, jamais dans le code). */
  setRiotApiKey: (key: string): Promise<RiotKeyStatus> =>
    invoke<RiotKeyStatus>("set_riot_api_key", { key }),
  /** Supprime la clé locale (une clé fournie par l'environnement reste active). */
  clearRiotApiKey: (): Promise<RiotKeyStatus> => invoke<RiotKeyStatus>("clear_riot_api_key"),
  /** Plateformes Riot supportées (identifiant + libellé). */
  getRiotPlatforms: (): Promise<RiotPlatformInfo[]> =>
    invoke<RiotPlatformInfo[]>("get_riot_platforms"),
  /**
   * Profil Riot : identité, classements et 10 derniers matchs.
   * Cache local 30 min minimum (rang/liste), 24 h pour les matchs immuables.
   * `forceRefresh` contourne le cache (rate-limit Riot respecté par le backend).
   */
  getRiotProfile: (
    riotId: string,
    platform: string,
    forceRefresh = false,
  ): Promise<RiotProfile> =>
    invoke<RiotProfile>("get_riot_profile", { riotId, platform, forceRefresh }),
  /** Détail d'un match (10 participants) depuis le cache ou l'API Riot. */
  getRiotMatch: (matchId: string): Promise<RiotMatchDetail> =>
    invoke<RiotMatchDetail>("get_riot_match", { matchId }),

  // --- Progression personnelle (50 derniers matchs) -----------------------
  /** Win rate par champion/rôle/serveur sur les 50 derniers matchs (Riot API). */
  getRiotProgression: (
    riotId: string,
    platform: string,
    forceRefresh = false,
  ): Promise<RiotProgression> =>
    invoke<RiotProgression>("get_riot_progression", { riotId, platform, forceRefresh }),

  // --- Méta OP.GG (MCP public, sans clé) ----------------------------------
  /** Tier list réelle OP.GG pour une plateforme (`EUW1`, `NA1`, …). */
  getMetaTierList: (platform: string): Promise<MetaTierList> =>
    invoke<MetaTierList>("get_meta_tier_list", { platform }),
  /** Builds méta OP.GG (objets achetés par les meilleurs joueurs). */
  getMetaBuilds: (
    champion: string,
    position: string,
    platform: string,
    tier: string,
  ): Promise<MetaBuild> =>
    invoke<MetaBuild>("get_meta_builds", { champion, position, platform, tier }),
  /** Trois pages de runes réelles OP.GG (Challenger / Grandmaster / Tous niveaux). */
  getMetaRunePages: (
    champion: string,
    position: string,
    platform: string,
  ): Promise<MetaRunePages> =>
    invoke<MetaRunePages>("get_meta_rune_pages", { champion, position, platform }),

  // --- Esport (Riot Esports API, sans clé utilisateur) --------------------
  getEsportsLeagues: (): Promise<EsportsLeague[]> =>
    invoke<EsportsLeague[]>("get_esports_leagues"),
  getEsportsTeams: (): Promise<EsportsTeam[]> =>
    invoke<EsportsTeam[]>("get_esports_teams"),
  getEsportsTeam: (teamId: string): Promise<EsportsTeamDetail> =>
    invoke<EsportsTeamDetail>("get_esports_team", { teamId }),
  getEsportsTournaments: (leagueId: string): Promise<EsportsTournament[]> =>
    invoke<EsportsTournament[]>("get_esports_tournaments", { leagueId }),
  getEsportsStandings: (tournamentId: string): Promise<EsportsStanding[]> =>
    invoke<EsportsStanding[]>("get_esports_standings", { tournamentId }),

  /**
   * Convertit un chemin absolu du cache en URL servie par le protocole
   * `asset` de Tauri (aucune requête réseau : fichier local uniquement).
   */
  assetUrl: (absolutePath: string): string => convertFileSrc(absolutePath),
};
