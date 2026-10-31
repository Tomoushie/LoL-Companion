/**
 * Contrats de données exposés par le backend Rust (`src-tauri/src/model.rs`).
 * Toute évolution doit être synchronisée des deux côtés (même forme, mêmes noms).
 */

export interface DatasetCounts {
  champions: number;
  items: number;
  runeTrees: number;
  /** Icônes PNG de champions réellement lisibles dans le cache. */
  iconsCached: number;
  /** Icônes PNG d'objets réellement lisibles dans le cache. */
  itemIconsCached: number;
  /** Icônes PNG de runes/arbres de runes réellement lisibles dans le cache. */
  runeIconsCached: number;
}

export interface DataStatus {
  /** Version Data Dragon réellement en cache (ex. « 16.21.1 »), sinon null. */
  version: string | null;
  /** Dossier de cache local absolu. */
  cacheDir: string;
  /** Dernière synchronisation réussie (RFC 3339), sinon null. */
  updatedAt: string | null;
  /** Vrai si le réseau a échoué et que la version en cache a été conservée. */
  offline: boolean;
  /** Message réel expliquant le mode hors ligne / un téléchargement partiel. */
  warning: string | null;
  /** Compteurs calculés depuis les fichiers réellement en cache. */
  counts: DatasetCounts;
}

export interface Champion {
  id: string;
  key: string;
  name: string;
  title: string;
  tags: string[];
  /** Chemin absolu de l'icône en cache, null si l'icône n'est pas disponible. */
  iconPath: string | null;
}

/**
 * Statistique brute d'un objet : clé Data Dragon (`FlatPhysicalDamageMod`,
 * `PercentAttackSpeedMod`, …) et valeur exacte fournie par Riot.
 */
export interface ItemStat {
  key: string;
  value: number;
}

export interface Item {
  id: string;
  name: string;
  plainText: string;
  description: string;
  goldTotal: number;
  /** Prix de base Data Dragon (`gold.base`). */
  goldBase: number;
  /** Prix de revente (`gold.sell`). */
  goldSell: number;
  /** Vrai si l'objet est achetable (`gold.purchasable`). */
  purchasable: boolean;
  tags: string[];
  onSummonersRift: boolean;
  /** Niveau de recette Data Dragon (`depth`), null si non fourni. */
  depth: number | null;
  /** Vrai si l'objet est vendu en boutique (`inStore`), null si non fourni. */
  inStore: boolean | null;
  /** Vrai si l'objet est consommable (`consumed`), null si non fourni. */
  consumed: boolean | null;
  /** Identifiants Data Dragon des composants de la recette (`from`). */
  from: string[];
  /** Identifiants Data Dragon des objets dans lesquels celui-ci se transforme (`into`). */
  into: string[];
  /** Chemin absolu de l'icône en cache, null si l'icône n'est pas disponible. */
  iconPath: string | null;
  /** Statistiques non nulles fournies par Riot, dans l'ordre du JSON. */
  stats: ItemStat[];
}

export interface ChampionStats {
  hp: number;
  hpPerLevel: number;
  mp: number;
  mpPerLevel: number;
  armor: number;
  armorPerLevel: number;
  magicResist: number;
  magicResistPerLevel: number;
  attackDamage: number;
  attackDamagePerLevel: number;
  attackSpeed: number;
  attackSpeedPerLevel: number;
  moveSpeed: number;
  attackRange: number;
  hpRegen: number;
  mpRegen: number;
}

export interface ChampionSpell {
  id: string;
  name: string;
  description: string;
  /** Cooldown(s) réels, ex. « 12/11/10/9/8 » (chaîne conservée telle quelle). */
  cooldown: string;
  /** Coût réel, ex. « 60/65/70/75/80 » (chaîne conservée telle quelle). */
  cost: string;
  /** Ressource du coût (Mana, Energy, Rage…). */
  costType: string;
  /** Portée réelle fournie par Riot, ex. « 650 ». */
  range: string;
  /** Chemin absolu de l'icône en cache, null si absente. */
  iconPath: string | null;
}

export interface ChampionPassive {
  name: string;
  description: string;
  iconPath: string | null;
}

export interface ChampionDetail {
  id: string;
  key: string;
  name: string;
  title: string;
  tags: string[];
  /** Courte biographie officielle Data Dragon (`blurb`), en anglais. */
  blurb: string;
  /** Chemin absolu du splash art en cache, null si absent. */
  splashPath: string | null;
  stats: ChampionStats;
  spells: ChampionSpell[];
  passive: ChampionPassive | null;
}

export interface Rune {
  id: number;
  key: string;
  /** Nom officiel en_US Data Dragon. */
  name: string;
  /** Description courte en_US nettoyée du HTML. */
  shortDesc: string;
  /** Description longue en_US nettoyée du HTML, vide si non fournie. */
  longDesc: string;
  /** Nom officiel fr_FR Data Dragon, null si indisponible. */
  localizedName: string | null;
  /** Description courte fr_FR nettoyée, null si indisponible. */
  localizedShortDesc: string | null;
  /** Description longue fr_FR nettoyée, null si indisponible. */
  localizedLongDesc: string | null;
  /** Chemin d'icône relatif Data Dragon (`perk-images/...`). */
  icon: string;
  /** Chemin absolu de l'icône locale, null si non téléchargée. */
  iconPath: string | null;
  /** Palier (ligne) dans l'arbre de runes. */
  slot: number;
}

export interface RuneTree {
  id: number;
  key: string;
  /** Nom officiel en_US Data Dragon. */
  name: string;
  /** Nom officiel fr_FR Data Dragon, null si indisponible. */
  localizedName: string | null;
  /** Chemin d'icône relatif Data Dragon (`perk-images/...`). */
  icon: string;
  /** Chemin absolu de l'icône locale, null si non téléchargée. */
  iconPath: string | null;
  runes: Rune[];
}

// ---------------------------------------------------------------------------
// Riot API (V0.5) — la clé API n'est jamais exposée au frontend.
// ---------------------------------------------------------------------------

export type RiotKeySource = "environment" | "local";

export interface RiotKeyStatus {
  configured: boolean;
  /** Origine de la clé, null si aucune clé configurée. */
  source: RiotKeySource | null;
}

export interface RiotPlatformInfo {
  id: string;
  label: string;
}

export interface RiotLeagueEntry {
  /** `RANKED_SOLO_5x5`, `RANKED_FLEX_SR`, … */
  queueType: string;
  tier: string;
  rank: string;
  leaguePoints: number;
  wins: number;
  losses: number;
}

export interface RiotMatchSummary {
  matchId: string;
  /** Identifiant Data Dragon du champion joué. */
  championName: string;
  kills: number;
  deaths: number;
  assists: number;
  /** Sbires + monstres neutres. */
  cs: number;
  visionScore: number;
  durationSecs: number;
  win: boolean;
  queueId: number;
  gameCreationMs: number;
  position: string;
}

export interface RiotProfile {
  gameName: string;
  tagLine: string;
  puuid: string;
  /** Plateforme demandée (`EUW1`, `NA1`, …). */
  platform: string;
  ranks: RiotLeagueEntry[];
  matches: RiotMatchSummary[];
  /** Horodatage RFC 3339 des données (cache ou réseau). */
  fetchedAt: string;
  /** Vrai si aucun appel réseau n'a été nécessaire. */
  fromCache: boolean;
  /** Message réel (cache suite à une erreur, matchs partiels…). */
  warning: string | null;
}

export interface RiotMatchParticipant {
  puuid: string;
  displayName: string;
  championName: string;
  teamId: number;
  kills: number;
  deaths: number;
  assists: number;
  cs: number;
  visionScore: number;
  position: string;
  win: boolean;
}

export interface RiotMatchDetail {
  matchId: string;
  gameDurationSecs: number;
  gameMode: string;
  queueId: number;
  gameCreationMs: number;
  /** Équipe gagnante (100/200), null si non fournie. */
  winningTeam: number | null;
  participants: RiotMatchParticipant[];
  fetchedAt: string;
  fromCache: boolean;
}

// ---------------------------------------------------------------------------
// OP.GG (MCP public) — tier lists et builds méta (V0.6)
// ---------------------------------------------------------------------------

export interface MetaTierEntry {
  /** Clé numérique Data Dragon (86 pour Garen), 0 si introuvable. */
  championKey: number;
  /** Nom fourni par OP.GG (affichage de secours). */
  championName: string;
  /** top, mid, jungle, adc, support. */
  position: string;
  /** 1 = OP, 2 = Fort, 3 = Bon, 4 = Correct, 5 = Faible. */
  tier: number;
  rank: number;
  winRate: number;
  pickRate: number;
  banRate: number;
  kda: number;
  play: number;
  roleRate: number;
}

export interface MetaTierList {
  platform: string;
  region: string;
  source: string;
  fetchedAt: string;
  fromCache: boolean;
  entries: MetaTierEntry[];
  warning: string | null;
}

export interface MetaItemBuild {
  ids: number[];
  names: string[];
  pickRate: number;
  games: number;
  wins: number;
}

export interface MetaBuild {
  champion: string;
  position: string;
  platform: string;
  region: string;
  tier: string;
  source: string;
  fetchedAt: string;
  fromCache: boolean;
  winRate: number | null;
  pickRate: number | null;
  banRate: number | null;
  games: number | null;
  tierLabel: number | null;
  rank: number | null;
  starter: MetaItemBuild[];
  boots: MetaItemBuild[];
  core: MetaItemBuild[];
  fourth: MetaItemBuild[];
  fifth: MetaItemBuild[];
  sixth: MetaItemBuild[];
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Progression personnelle (Riot API, 50 derniers matchs) — V0.6
// ---------------------------------------------------------------------------

export interface RiotProgressionOverall {
  games: number;
  wins: number;
  losses: number;
  /** Taux de victoire entre 0 et 1 (0 si aucun match). */
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  csPerGame: number;
  visionPerGame: number;
}

export interface RiotChampionProgress {
  championName: string;
  games: number;
  wins: number;
  winRate: number;
  kills: number;
  deaths: number;
  assists: number;
  kda: number;
  csPerGame: number;
  visionPerGame: number;
}

export interface RiotRoleProgress {
  position: string;
  games: number;
  wins: number;
  winRate: number;
  kda: number;
}

export interface RiotProgression {
  gameName: string;
  tagLine: string;
  puuid: string;
  platform: string;
  matchesRequested: number;
  matchesAnalyzed: number;
  overall: RiotProgressionOverall;
  byChampion: RiotChampionProgress[];
  byRole: RiotRoleProgress[];
  serverWinRate: number;
  serverGames: number;
  fetchedAt: string;
  fromCache: boolean;
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Rune Builder (V0.7) — trois pages de runes réelles OP.GG
// ---------------------------------------------------------------------------

export interface MetaRunePage {
  /** challenger, grandmaster ou all. */
  scope: string;
  primaryPageId: number;
  primaryPageName: string;
  /** Keystone en premier, puis les 3 runes majeures. */
  primaryRuneIds: number[];
  primaryRuneNames: string[];
  secondaryPageId: number;
  secondaryPageName: string;
  secondaryRuneIds: number[];
  secondaryRuneNames: string[];
  statModIds: number[];
  /** Libellés réels (Community Dragon) ; ids en chaîne si indisponibles. */
  statModNames: string[];
  play: number;
  win: number;
  pickRate: number;
  /** win / play, null si échantillon nul. */
  winRate: number | null;
}

export interface MetaRunePages {
  champion: string;
  position: string;
  platform: string;
  source: string;
  fetchedAt: string;
  fromCache: boolean;
  pages: MetaRunePage[];
  warning: string | null;
}

// ---------------------------------------------------------------------------
// Esport (Riot Esports API) — équipes et compétitions (V1.0)
// ---------------------------------------------------------------------------

export interface EsportsLeague {
  id: string;
  slug: string;
  name: string;
  region: string;
  imageUrl: string;
}

export interface EsportsTeam {
  id: string;
  slug: string;
  name: string;
  code: string;
  imageUrl: string;
  homeLeague: string | null;
  region: string | null;
  status: string;
  playerCount: number;
}

export interface EsportsPlayer {
  id: string;
  summonerName: string;
  firstName: string;
  lastName: string;
  role: string;
  imageUrl: string;
  /** Non fournis par l'API Riot Esports : null, affiché « — ». */
  age: number | null;
  country: string | null;
  language: string | null;
  handedness: string | null;
}

export interface EsportsTeamDetail {
  team: EsportsTeam;
  players: EsportsPlayer[];
  fetchedAt: string;
  fromCache: boolean;
  warning: string | null;
}

export interface EsportsTournament {
  id: string;
  slug: string;
  startDate: string;
  endDate: string;
}

export interface EsportsStanding {
  stage: string;
  section: string;
  ordinal: number;
  teamName: string;
  teamCode: string;
  teamImageUrl: string;
  wins: number | null;
  losses: number | null;
}
