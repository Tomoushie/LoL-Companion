/**
 * Libellés français des statistiques et catégories d'objets Data Dragon.
 *
 * Aucune donnée n'est inventée : les clés inconnues sont affichées telles
 * quelles (clé Riot brute + valeur) et les tags inconnus gardent leur nom brut.
 */

import type { Item, ItemStat } from "../types";
import { formatDecimal } from "./format";

type StatFormat = "flat" | "percent";

interface StatDefinition {
  /** Libellé affiché après la valeur (« +40 AD », « +15 % AS »). */
  readonly label: string;
  /**
   * `flat` : valeur affichée telle quelle.
   * `percent` : valeur Riot fractionnaire (0.15) affichée ×100, le libellé
   * portant déjà le symbole « % ».
   */
  readonly format: StatFormat;
}

const STAT_DEFINITIONS: Readonly<Record<string, StatDefinition>> = {
  FlatPhysicalDamageMod: { label: "AD", format: "flat" },
  FlatMagicDamageMod: { label: "AP", format: "flat" },
  FlatArmorMod: { label: "Armure", format: "flat" },
  FlatSpellBlockMod: { label: "RM", format: "flat" },
  FlatHPPoolMod: { label: "PV", format: "flat" },
  FlatMPPoolMod: { label: "Mana", format: "flat" },
  PercentAttackSpeedMod: { label: "% AS", format: "percent" },
  FlatCritChanceMod: { label: "% Crit", format: "percent" },
  FlatMovementSpeedMod: { label: "Vit. dépl.", format: "flat" },
  PercentMovementSpeedMod: { label: "% Vit. dépl.", format: "percent" },
  PercentLifeStealMod: { label: "% Vol de vie", format: "percent" },
  FlatHPRegenMod: { label: "Régén. PV", format: "flat" },
};

const ITEM_TAG_LABELS: Readonly<Record<string, string>> = {
  Damage: "Dégâts",
  SpellDamage: "Magie",
  Defense: "Défense",
  AttackSpeed: "Vitesse d'attaque",
  CriticalStrike: "Critique",
  Health: "PV",
  Mana: "Mana",
  Armor: "Armure",
  MagicResist: "Résistance magique",
  SpellBlock: "Résistance magique",
  Boots: "Bottes",
  Consumable: "Consommables",
  Vision: "Vision",
  Trinket: "Balises",
  Gold: "Or",
  GoldPer: "Or par seconde",
  NonbootsMovement: "Déplacement",
  LifeSteal: "Vol de vie",
  SpellVamp: "Vol de sort",
  Active: "Actifs",
  Aura: "Aura",
  Slow: "Ralentissement",
  Stealth: "Furtivité",
  Tenacity: "Ténacité",
  OnHit: "Effets à l'impact",
  Jungle: "Jungle",
  Lane: "Voie",
  HealthRegen: "Régénération PV",
  ManaRegen: "Régénération mana",
  CooldownReduction: "Réduction de recharge",
  AbilityHaste: "Hâte de compétence",
  ArmorPenetration: "Pénétration d'armure",
  MagicPenetration: "Pénétration magique",
};

/** Balises de rareté présentes dans certains noms Data Dragon. */
const ITEM_NAME_MARKUP = /<[^>]*>/g;

const BASIC_ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};

/**
 * Texte Data Dragon affichable : retire le balisage fourni par Riot
 * (`<mainText>`, `<rarityLegendary>`, `<br>`…) et les entités de base.
 * Le contenu réel est conservé, aucune valeur n'est inventée.
 */
export function cleanItemText(value: string): string {
  let cleaned = value.replace(ITEM_NAME_MARKUP, " ");
  for (const [entity, replacement] of Object.entries(BASIC_ENTITIES)) {
    cleaned = cleaned.split(entity).join(replacement);
  }
  return cleaned.replace(/\s+/g, " ").trim();
}

/**
 * Nom d'objet affichable : retire uniquement le balisage de rareté fourni par
 * Riot (`<rarityLegendary>…`) et les entités de base. Le nom réel est conservé,
 * aucune valeur n'est inventée ; si le nettoyage vide tout, le nom brut reste.
 */
export function displayItemName(item: Item): string {
  const cleaned = cleanItemText(item.name);
  return cleaned === "" ? item.name : cleaned;
}

/** Texte court (`plainText`) affichable, nettoyé du balisage Riot. */
export function displayItemPlainText(item: Item): string {
  const raw = typeof item.plainText === "string" ? item.plainText : "";
  const cleaned = cleanItemText(raw);
  return cleaned === "" ? raw.trim() : cleaned;
}

/** Libellé français d'un tag Data Dragon ; tag inconnu → nom brut. */
export function itemTagLabel(tag: string): string {
  return ITEM_TAG_LABELS[tag] ?? tag;
}

/** Texte d'une puce de statistique réelle d'objet (« +40 AD », « +15 % AS »). */
export function formatItemStat(stat: ItemStat): string {
  const definition = STAT_DEFINITIONS[stat.key];
  if (definition === undefined) {
    // Clé Riot inconnue : affichage brut, jamais de conversion inventée.
    return `${stat.key} ${formatDecimal(stat.value)}`;
  }

  const scaled = definition.format === "percent" ? stat.value * 100 : stat.value;
  const sign = scaled > 0 ? "+" : "";
  return `${sign}${formatDecimal(scaled)} ${definition.label}`;
}

/**
 * Puces de statistiques principales d'un objet (2 à 4 quand les données le
 * permettent, moins si Riot n'en fournit pas davantage — sans compléter).
 */
export function itemStatChips(item: Item, maximum: number): readonly string[] {
  const chips: string[] = [];
  for (const stat of item.stats) {
    if (chips.length >= maximum) {
      break;
    }
    chips.push(formatItemStat(stat));
  }
  return chips;
}
