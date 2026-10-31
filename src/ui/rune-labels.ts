/**
 * Libellés et fallbacks des runes Data Dragon.
 *
 * Les noms/descriptions français viennent de la localisation officielle fr_FR
 * fournie par le backend ; à défaut on retombe sur l'anglais (en_US), puis sur
 * « — ». Aucun texte n'est inventé côté interface.
 */

import type { Rune, RuneTree } from "../types";
import { EMPTY_VALUE } from "./format";

/**
 * Ordre de présentation conventionnel des arbres (clés Data Dragon).
 * L'ordre du fichier Riot est alphabétique ; l'interface présente d'abord
 * Précision, l'arbre le plus utilisé, puis les autres. Les arbres inconnus
 * sont ajoutés à la suite, dans l'ordre fourni par le backend.
 */
const TREE_PRESENTATION_ORDER: readonly string[] = [
  "Precision",
  "Domination",
  "Sorcery",
  "Resolve",
  "Inspiration",
];

/** Chaîne exploitable ou null (tolère un backend transitoire sans le champ). */
export function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

export function localizedOrFallback(localized: string | null, fallback: string): string {
  return localized !== null && localized.trim() !== "" ? localized : fallback;
}

export function runeTreeDisplayName(tree: RuneTree): string {
  return localizedOrFallback(optionalString(tree.localizedName), tree.name);
}

export function runeDisplayName(rune: Rune): string {
  return localizedOrFallback(optionalString(rune.localizedName), rune.name);
}

/** Nom anglais affiché en secondaire, uniquement s'il diffère du nom principal. */
export function runeSecondaryName(localizedName: string | null, englishName: string): string | null {
  const primary = localizedOrFallback(localizedName, englishName);
  const english = englishName.trim();
  return english !== "" && english !== primary ? english : null;
}

/** Description courte : FR si disponible, sinon EN, sinon « — ». */
export function runeShortDescription(rune: Rune): string {
  const localized = optionalString(rune.localizedShortDesc);
  if (localized !== null) {
    return localized;
  }
  const english = optionalString(rune.shortDesc);
  return english ?? EMPTY_VALUE;
}

/** Description longue : FR si disponible, sinon EN, sinon « — ». */
export function runeLongDescription(rune: Rune): string {
  const localized = optionalString(rune.localizedLongDesc);
  if (localized !== null) {
    return localized;
  }
  const english = optionalString(rune.longDesc);
  return english ?? EMPTY_VALUE;
}

export function sortRuneTrees(trees: readonly RuneTree[]): RuneTree[] {
  const rank = (tree: RuneTree): number => {
    const index = TREE_PRESENTATION_ORDER.indexOf(tree.key);
    return index < 0 ? TREE_PRESENTATION_ORDER.length : index;
  };
  return [...trees].sort((a, b) => {
    const difference = rank(a) - rank(b);
    return difference !== 0 ? difference : a.name.localeCompare(b.name, "fr");
  });
}
