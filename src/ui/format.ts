/**
 * Formatage et normalisation des valeurs affichées.
 * Toute absence de donnée est rendue par le caractère « — » : jamais de
 * valeur inventée pour combler un champ manquant.
 */

const DIACRITICS = /\p{Diacritic}/gu;
const DATE_FORMATTER = new Intl.DateTimeFormat("fr-FR", {
  dateStyle: "short",
  timeStyle: "short",
});
const NUMBER_FORMATTER = new Intl.NumberFormat("fr-FR");
const DECIMAL_FORMATTER = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 3 });

const UNKNOWN_ERROR = "Erreur inconnue.";

export const EMPTY_VALUE = "—";

/** Casse et accents neutralisés pour une recherche simple (nom, titre, texte). */
export function normalizeForSearch(value: string): string {
  return value.normalize("NFD").replace(DIACRITICS, "").toLowerCase();
}

/** Horodatage RFC 3339 → date locale lisible ; « — » si absent. */
export function formatDateTime(iso: string | null): string {
  if (iso === null || iso.trim() === "") {
    return EMPTY_VALUE;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    // Valeur non standard : on l'affiche telle quelle plutôt que d'inventer.
    return iso;
  }
  return DATE_FORMATTER.format(date);
}

/** Entier lisible en français ; « — » si la valeur n'est pas exploitable. */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) {
    return EMPTY_VALUE;
  }
  return NUMBER_FORMATTER.format(count);
}

/** Nombre décimal (stats Riot) sans arrondi inventé : jusqu'à 3 décimales. */
export function formatDecimal(value: number): string {
  if (!Number.isFinite(value)) {
    return EMPTY_VALUE;
  }
  return DECIMAL_FORMATTER.format(value);
}

/** Chemin local : « — » si vide, sinon le chemin réel. */
export function formatPath(path: string): string {
  return path.trim() === "" ? EMPTY_VALUE : path;
}

/**
 * Message réel d'une erreur backend.
 * Les commandes Tauri rejettent le plus souvent avec une chaîne simple.
 */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") {
    return error.trim() === "" ? UNKNOWN_ERROR : error;
  }
  if (error instanceof Error) {
    return error.message.trim() === "" ? UNKNOWN_ERROR : error.message;
  }
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return String(error);
  }
  if (error === null || error === undefined) {
    return UNKNOWN_ERROR;
  }
  try {
    const serialized: unknown = JSON.stringify(error);
    if (typeof serialized === "string" && serialized !== "{}") {
      return serialized;
    }
    return UNKNOWN_ERROR;
  } catch {
    return UNKNOWN_ERROR;
  }
}
