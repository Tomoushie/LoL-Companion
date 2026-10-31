/**
 * Libellés et formatages des données Riot API (V0.5).
 *
 * Aucune donnée n'est inventée : les valeurs absentes sont rendues par « — »
 * et les identifiants inconnus (file, type de classement) restent bruts.
 */

import { EMPTY_VALUE } from "./format";

const QUEUE_LABELS: Readonly<Record<number, string>> = {
  400: "Normal (Draft)",
  420: "Solo/Duo",
  430: "Normal (Aveugle)",
  440: "Flex",
  450: "ARAM",
  490: "Quickplay",
  700: "Clash",
  900: "URF",
  1020: "Un pour tous",
  1300: "Nexus Blitz",
  1700: "Arena",
};

const QUEUE_TYPE_LABELS: Readonly<Record<string, string>> = {
  RANKED_SOLO_5x5: "Solo/Duo",
  RANKED_FLEX_SR: "Flex",
  RANKED_TFT: "TFT",
  RANKED_TFT_DOUBLE_UP: "TFT Double Up",
  CHERRY: "Arena",
};

/** File de jeu à partir de `queueId` ; file inconnue → « File <id> ». */
export function riotQueueLabel(queueId: number): string {
  if (!Number.isFinite(queueId)) {
    return EMPTY_VALUE;
  }
  return QUEUE_LABELS[queueId] ?? `File ${queueId}`;
}

/** Type de classement lisible ; type inconnu → identifiant brut (honnête). */
export function riotQueueTypeLabel(queueType: string): string {
  const trimmed = queueType.trim();
  if (trimmed === "") {
    return EMPTY_VALUE;
  }
  return QUEUE_TYPE_LABELS[trimmed] ?? trimmed;
}

/** Tier et division réels (« CHALLENGER I », « GOLD IV ») ; absents → « — ». */
export function riotRankLabel(tier: string, rank: string): string {
  const tierText = tier.trim().toUpperCase();
  const rankText = rank.trim().toUpperCase();
  if (tierText === "" && rankText === "") {
    return EMPTY_VALUE;
  }
  return `${tierText} ${rankText}`.trim();
}

/** Durée en secondes → « 32:15 » ; absente/invalide → « — ». */
export function formatDuration(totalSecs: number): string {
  if (typeof totalSecs !== "number" || !Number.isFinite(totalSecs) || totalSecs < 0) {
    return EMPTY_VALUE;
  }
  const seconds = Math.floor(totalSecs);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

const MATCH_DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
});

/** Horodatage Riot (ms) → date locale lisible ; absent/invalide → « — ». */
export function formatMatchDate(epochMs: number): string {
  if (typeof epochMs !== "number" || !Number.isFinite(epochMs) || epochMs <= 0) {
    return EMPTY_VALUE;
  }
  const date = new Date(epochMs);
  if (Number.isNaN(date.getTime())) {
    return EMPTY_VALUE;
  }
  return MATCH_DATE_FORMATTER.format(date);
}

/** Nombre Riot affichable ; absent/NaN → « — » (0 reste 0). */
export function riotNumber(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : EMPTY_VALUE;
}

const POSITION_LABELS: Readonly<Record<string, string>> = {
  TOP: "Top",
  JUNGLE: "Jungle",
  MIDDLE: "Mid",
  MID: "Mid",
  BOTTOM: "ADC",
  BOT: "ADC",
  ADC: "ADC",
  UTILITY: "Support",
  SUPPORT: "Support",
};

/** Rôle/position Riot lisible en français ; inconnu → valeur brute. */
export function riotPositionLabel(position: unknown): string {
  if (typeof position !== "string") {
    return EMPTY_VALUE;
  }
  const trimmed = position.trim();
  if (trimmed === "") {
    return EMPTY_VALUE;
  }
  return POSITION_LABELS[trimmed.toUpperCase()] ?? trimmed;
}

/** Résultat d'un match ; booléen absent → « — ». */
export function riotResultLabel(win: unknown): string {
  return typeof win === "boolean" ? (win ? "Victoire" : "Défaite") : EMPTY_VALUE;
}
