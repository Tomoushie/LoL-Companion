/**
 * Formatage des taux (win rate, pick rate, ban rate) fournis par OP.GG ou Riot.
 *
 * Les valeurs de ces sources sont souvent des fractions 0..1 ; certains
 * backends peuvent exposer des pourcentages 0..100. Le formatage reste donc
 * tolérant aux deux échelles : une valeur ≤ 1 est traitée comme une fraction,
 * une valeur > 1 est déjà en pourcentage. Aucune valeur n'est inventée.
 */

import { EMPTY_VALUE, formatDecimal } from "./format";

export function formatRate(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return EMPTY_VALUE;
  }
  const percent = Math.abs(value) <= 1 ? value * 100 : value;
  return `${formatDecimal(percent)} %`;
}
