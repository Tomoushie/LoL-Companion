/**
 * Vue « Fiche champion » : détail d'un champion déjà présent dans le cache.
 *
 * Toutes les valeurs (splash, statistiques, sorts, passif, biographie)
 * proviennent de `api.getChampionDetail(id)` : aucune donnée inventée.
 * Les images absentes ou illisibles sont remplacées par le placeholder « — ».
 */

import { api } from "../api";
import { buildPanelState } from "../components/states";
import type { ChampionDetail, ChampionPassive, ChampionSpell, ChampionStats } from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE, formatDecimal } from "../ui/format";
import { icon } from "../ui/icons";

export interface ChampionDetailViewOptions {
  readonly onClose: () => void;
}

export interface ChampionDetailViewHandle {
  readonly element: HTMLElement;
  setLoading(): void;
  setDetail(detail: ChampionDetail): void;
  setError(message: string, retryLabel: string, onRetry: () => void): void;
  clear(): void;
  focusBackButton(): void;
}

interface StatDefinition {
  readonly key: keyof ChampionStats;
  readonly label: string;
  /** Clé de la valeur « par niveau » associée, si elle a un sens ici. */
  readonly perLevel?: keyof ChampionStats;
}

const STAT_DEFINITIONS: readonly StatDefinition[] = [
  { key: "hp", label: "PV", perLevel: "hpPerLevel" },
  { key: "mp", label: "Mana", perLevel: "mpPerLevel" },
  { key: "armor", label: "Armure", perLevel: "armorPerLevel" },
  { key: "magicResist", label: "Résistance magique", perLevel: "magicResistPerLevel" },
  { key: "attackDamage", label: "Dégâts d'attaque", perLevel: "attackDamagePerLevel" },
  { key: "attackSpeed", label: "Vitesse d'attaque" },
  { key: "moveSpeed", label: "Vitesse de déplacement" },
  { key: "attackRange", label: "Portée" },
];

function createImagePlaceholder(className: string, titleText: string): HTMLElement {
  return el("span", {
    className,
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: titleText },
  });
}

/** Bandeau splash : image locale, ou fond sombre avec « — » si absente. */
function buildHero(detail: ChampionDetail): HTMLElement {
  const hero = el("div", { className: "detail-hero" });
  const splashPath = typeof detail.splashPath === "string" ? detail.splashPath : null;

  if (splashPath !== null && splashPath.trim() !== "") {
    const splash = el("img", {
      className: "champion-splash",
      attrs: {
        alt: `Splash art de ${detail.name}`,
        loading: "lazy",
        decoding: "async",
        draggable: "false",
      },
    });
    splash.src = api.assetUrl(splashPath);
    splash.addEventListener("error", () => {
      splash.replaceWith(createImagePlaceholder("champion-splash-placeholder", "Splash art absent du cache local"));
    });
    hero.appendChild(splash);
  } else {
    hero.appendChild(createImagePlaceholder("champion-splash-placeholder", "Splash art absent du cache local"));
  }

  const overlay = el("div", { className: "detail-hero-overlay" });
  const identity = el("div", { className: "detail-identity" });

  const tags = el("div", { className: "detail-tags" });
  if (detail.tags.length === 0) {
    tags.appendChild(el("span", { className: "champ-tag champ-tag--empty", text: EMPTY_VALUE }));
  } else {
    for (const tag of detail.tags) {
      tags.appendChild(el("span", { className: "champ-tag", text: tag }));
    }
  }

  append(
    identity,
    el("h1", { className: "detail-name", text: detail.name }),
    el("p", {
      className: "detail-title",
      text: detail.title.trim() === "" ? EMPTY_VALUE : detail.title,
    }),
    tags,
  );
  overlay.appendChild(identity);
  hero.appendChild(overlay);
  return hero;
}

function buildBlurb(detail: ChampionDetail): HTMLElement {
  const section = el("section", { className: "detail-section" });
  append(
    section,
    el("h2", { className: "detail-section-title", text: "Présentation" }),
    el("p", {
      className: "detail-blurb",
      text: detail.blurb.trim() === "" ? EMPTY_VALUE : detail.blurb,
    }),
  );
  return section;
}

function buildStats(stats: ChampionStats): HTMLElement {
  const section = el("section", { className: "detail-section" });
  section.appendChild(el("h2", { className: "detail-section-title", text: "Statistiques" }));

  const list = el("dl", { className: "stat-grid" });
  for (const definition of STAT_DEFINITIONS) {
    const row = el("div", { className: "stat-row" });
    const value = el("dd", { className: "stat-value" });
    value.appendChild(
      el("span", {
        className: "stat-base",
        text: formatDecimal(stats[definition.key]),
        attrs: { "data-stat": definition.key },
      }),
    );

    if (definition.perLevel !== undefined) {
      const perLevel = stats[definition.perLevel];
      if (perLevel !== 0) {
        value.appendChild(
          el("span", {
            className: "stat-per-level",
            text: `+${formatDecimal(perLevel)} / niv.`,
          }),
        );
      }
    }

    append(row, el("dt", { className: "stat-label", text: definition.label }), value);
    list.appendChild(row);
  }

  section.appendChild(list);
  return section;
}

/**
 * Types de coût neutres/techniques qui n'apportent aucune information après la
 * valeur réelle : ils sont omis (« 0 » au lieu de « 0 No Cost »).
 */
const NEUTRAL_COST_TYPES: ReadonlySet<string> = new Set([
  "",
  "no cost",
  "none",
  "aucun coût",
  "aucun cout",
]);

function sanitizeCostType(value: string): string {
  const trimmed = value.trim();
  // Modèle Data Dragon non résolu (« {{ abilityresourcename }} ») : masqué.
  if (trimmed.includes("{{") || trimmed.includes("}}")) {
    return "";
  }
  return NEUTRAL_COST_TYPES.has(trimmed.toLowerCase()) ? "" : trimmed;
}

/**
 * Coût d'un sort : la valeur réelle est toujours affichée (jamais masquée) ;
 * le type de ressource n'est ajouté que lorsqu'il est informatif
 * (« 60 Mana », « 50 Énergie »), pas pour « No Cost »/« None »/vide.
 */
function formatCost(spell: ChampionSpell): string {
  const cost = spell.cost.trim();
  if (cost === "") {
    return "";
  }
  const costType = sanitizeCostType(spell.costType);
  return costType === "" ? cost : `${cost} ${costType}`;
}

/**
 * Sentinelle Data Dragon : `rangeBurn` vaut exactement « 25000 » pour les
 * sorts sans portée de ciblage réelle (ex. Aatrox Q/E/R). On masque alors la
 * ligne Portée au lieu d'afficher cette valeur technique trompeuse.
 */
const NO_SPELL_RANGE_SENTINEL = "25000";

/** Portée brute à afficher, ou null si absente/technique (ligne masquée). */
function spellRangeLabel(spell: ChampionSpell): string | null {
  const range = spell.range.trim();
  if (range === "" || range === NO_SPELL_RANGE_SENTINEL) {
    return null;
  }
  return range;
}

function buildSpellMeta(label: string, value: string, dataAttribute: string | null): HTMLElement {
  const item = el("div", { className: "spell-meta-item" });
  const valueElement = el("span", {
    className: "spell-meta-value",
    text: value.trim() === "" ? EMPTY_VALUE : value,
  });
  if (dataAttribute !== null) {
    valueElement.setAttribute(dataAttribute, "true");
  }
  append(item, el("span", { className: "spell-meta-label", text: label }), valueElement);
  return item;
}

function buildSpellIcon(spell: ChampionSpell): HTMLElement {
  const wrapper = el("div", { className: "spell-icon-wrap" });
  const iconPath = typeof spell.iconPath === "string" ? spell.iconPath : null;

  if (iconPath !== null && iconPath.trim() !== "") {
    const image = el("img", {
      className: "spell-icon",
      attrs: {
        alt: spell.name,
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "48",
        height: "48",
      },
    });
    image.src = api.assetUrl(iconPath);
    image.addEventListener("error", () => {
      image.replaceWith(createImagePlaceholder("spell-icon-placeholder", "Icône du sort absente du cache"));
    });
    wrapper.appendChild(image);
  } else {
    wrapper.appendChild(
      createImagePlaceholder("spell-icon-placeholder", "Icône du sort absente du cache"),
    );
  }

  return wrapper;
}

function buildSpellCard(spell: ChampionSpell, index: number): HTMLElement {
  const card = el("article", {
    className: "spell-card",
    attrs: {
      "data-spell": "true",
      "data-spell-index": String(index),
    },
  });

  const body = el("div", { className: "spell-body" });
  append(
    body,
    el("h3", {
      className: "spell-name",
      text: spell.name,
      attrs: { "data-spell-name": "true" },
    }),
    el("p", {
      className: "spell-description",
      text: spell.description.trim() === "" ? EMPTY_VALUE : spell.description,
    }),
  );

  const meta = el("div", { className: "spell-meta" });
  meta.appendChild(buildSpellMeta("Recharge", spell.cooldown, "data-spell-cooldown"));
  meta.appendChild(buildSpellMeta("Coût", formatCost(spell), "data-spell-cost"));

  const range = spellRangeLabel(spell);
  if (range !== null) {
    meta.appendChild(buildSpellMeta("Portée", range, null));
  }
  body.appendChild(meta);

  append(card, buildSpellIcon(spell), body);
  return card;
}

function buildSpells(spells: readonly ChampionSpell[]): HTMLElement | null {
  if (spells.length === 0) {
    return null;
  }
  const section = el("section", { className: "detail-section" });
  section.appendChild(el("h2", { className: "detail-section-title", text: "Sorts" }));

  const list = el("div", { className: "spell-list" });
  spells.forEach((spell, index) => {
    list.appendChild(buildSpellCard(spell, index));
  });
  section.appendChild(list);
  return section;
}

function buildPassive(passive: ChampionPassive): HTMLElement {
  const section = el("section", { className: "detail-section" });
  section.appendChild(el("h2", { className: "detail-section-title", text: "Passif" }));

  const card = el("article", { className: "passive-card", attrs: { "data-passive": "true" } });

  const wrapper = el("div", { className: "passive-icon-wrap" });
  const iconPath = typeof passive.iconPath === "string" ? passive.iconPath : null;
  if (iconPath !== null && iconPath.trim() !== "") {
    const image = el("img", {
      className: "passive-icon",
      attrs: {
        alt: passive.name,
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "48",
        height: "48",
      },
    });
    image.src = api.assetUrl(iconPath);
    image.addEventListener("error", () => {
      image.replaceWith(createImagePlaceholder("passive-icon-placeholder", "Icône du passif absente du cache"));
    });
    wrapper.appendChild(image);
  } else {
    wrapper.appendChild(
      createImagePlaceholder("passive-icon-placeholder", "Icône du passif absente du cache"),
    );
  }

  const body = el("div", { className: "spell-body" });
  append(
    body,
    el("h3", {
      className: "spell-name",
      text: passive.name,
      attrs: { "data-passive-name": "true" },
    }),
    el("p", {
      className: "spell-description",
      text: passive.description.trim() === "" ? EMPTY_VALUE : passive.description,
    }),
  );

  append(card, wrapper, body);
  section.appendChild(card);
  return section;
}

function buildLoadingContent(): HTMLElement {
  const container = el("div", { className: "detail-loading" });

  const line = el("div", { className: "loading-line" });
  append(
    line,
    el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
    el("span", { text: "Chargement de la fiche…" }),
  );

  const hero = el("div", {
    className: "detail-hero detail-hero--skeleton",
    attrs: { "aria-hidden": "true" },
  });

  const lines = el("div", { className: "detail-skeleton-lines", attrs: { "aria-hidden": "true" } });
  append(
    lines,
    el("span", { className: "skeleton-line skeleton-line--wide" }),
    el("span", { className: "skeleton-line" }),
    el("span", { className: "skeleton-line skeleton-line--short" }),
  );

  append(container, line, hero, lines);
  return container;
}

export function createChampionDetailView(
  options: ChampionDetailViewOptions,
): ChampionDetailViewHandle {
  const backButton = el("button", {
    className: "btn btn-ghost detail-back",
    attrs: { type: "button", "data-action": "back", title: "Revenir à la grille des champions" },
  });
  append(
    backButton,
    icon("arrowLeft", 15),
    el("span", { className: "btn-label", text: "Retour aux champions" }),
  );
  backButton.addEventListener("click", options.onClose);

  const topbar = el("div", { className: "detail-topbar" });
  topbar.appendChild(backButton);

  const content = el("div", { className: "detail-content" });
  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "view view--champion-detail",
    attrs: {
      id: "view-champion-detail",
      "data-view": "champion-detail",
      "aria-label": "Fiche champion",
      role: "region",
    },
  });
  append(element, topbar, content, announcer);
  element.hidden = true;

  function setLoading(): void {
    replaceContent(content, buildLoadingContent());
    announcer.textContent = "Chargement de la fiche…";
  }

  function setDetail(detail: ChampionDetail): void {
    const layout = el("div", { className: "detail-layout" });
    append(layout, buildHero(detail), buildBlurb(detail), buildStats(detail.stats));

    const spells = buildSpells(detail.spells);
    if (spells !== null) {
      layout.appendChild(spells);
    }
    if (detail.passive !== null) {
      layout.appendChild(buildPassive(detail.passive));
    }

    replaceContent(content, layout);
    announcer.textContent = `Fiche de ${detail.name} chargée.`;
  }

  function setError(message: string, retryLabel: string, onRetry: () => void): void {
    replaceContent(
      content,
      buildPanelState({
        tone: "error",
        title: "Fiche champion indisponible",
        message,
        actionLabel: retryLabel,
        onAction: onRetry,
        iconName: "alert",
      }),
    );
    announcer.textContent = `Fiche champion indisponible. ${message}`;
  }

  function clear(): void {
    replaceContent(content);
    announcer.textContent = "";
  }

  function focusBackButton(): void {
    backButton.focus();
  }

  return { element, setLoading, setDetail, setError, clear, focusBackButton };
}
