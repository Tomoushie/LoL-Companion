/**
 * Vue « Fiche objet » : détail d'un objet déjà présent dans le cache local.
 *
 * Toutes les valeurs (noms, prix, statistiques, description, recette) viennent
 * des données Data Dragon fournies par le backend. Les champs absents sont
 * rendus par « — » ; aucune donnée (build, win rate, date, durée) n'est
 * inventée.
 */

import { api } from "../api";
import type { Item } from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE, formatCount } from "../ui/format";
import { icon } from "../ui/icons";
import { cleanItemText, displayItemName, formatItemStat, itemTagLabel } from "../ui/item-labels";

export interface ItemDetailViewOptions {
  readonly onClose: () => void;
  /** Ouvre la fiche d'un composant / d'une transformation. */
  readonly onOpenItem: (itemId: string, trigger: HTMLElement) => void;
}

export interface ItemDetailViewHandle {
  readonly element: HTMLElement;
  setItem(item: Item, allItems: readonly Item[]): void;
  clear(): void;
  focusBackButton(): void;
}

interface RecipeEntry {
  readonly id: string;
  readonly count: number;
  readonly item: Item | null;
}

const HONEST_NOTE =
  "Builds et win rates non fournis par Data Dragon — aucune donnée inventée.";

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function textOrEmpty(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text.trim() === "" ? EMPTY_VALUE : text;
}

function booleanLabel(value: boolean | null): string {
  return value === null ? EMPTY_VALUE : value ? "Oui" : "Non";
}

function createIconPlaceholder(className: string): HTMLElement {
  return el("span", {
    className,
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

function buildLargeIcon(item: Item): HTMLElement {
  const wrapper = el("span", { className: "detail-icon-wrap detail-icon-wrap--large" });
  const iconPath = asString(item.iconPath);

  if (iconPath !== null) {
    const image = el("img", {
      className: "detail-icon detail-icon--large",
      attrs: {
        alt: displayItemName(item),
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "96",
        height: "96",
      },
    });
    image.src = api.assetUrl(iconPath);
    image.addEventListener("error", () => {
      image.replaceWith(createIconPlaceholder("detail-icon detail-icon--placeholder"));
    });
    wrapper.appendChild(image);
  } else {
    wrapper.appendChild(createIconPlaceholder("detail-icon detail-icon--placeholder"));
  }

  return wrapper;
}

function buildTags(item: Item): HTMLElement {
  const tags = el("span", { className: "detail-tag-row" });
  if (item.tags.length === 0) {
    tags.appendChild(el("span", { className: "champ-tag champ-tag--empty", text: EMPTY_VALUE }));
    return tags;
  }
  for (const tag of item.tags) {
    tags.appendChild(
      el("span", {
        className: "champ-tag",
        text: itemTagLabel(tag),
        attrs: { title: `Tag Data Dragon : ${tag}` },
      }),
    );
  }
  return tags;
}

function buildGoldBlock(item: Item): HTMLElement {
  const block = el("div", { className: "item-detail-gold" });

  function addRow(label: string, value: number | null): void {
    const row = el("div", { className: "item-detail-gold-row" });
    append(
      row,
      el("span", { className: "item-detail-gold-label", text: label }),
      el("span", {
        className: "item-detail-gold-value",
        text: value === null ? EMPTY_VALUE : `${formatCount(value)} or`,
      }),
    );
    block.appendChild(row);
  }

  addRow("Or total", asNumber(item.goldTotal));
  addRow("Revente", asNumber(item.goldSell));

  // Prix de base affiché uniquement s'il est réellement fourni et non nul.
  const base = asNumber(item.goldBase);
  if (base !== null && base > 0) {
    addRow("Prix de base", base);
  }

  return block;
}

function buildInfoSection(item: Item): HTMLElement {
  const section = el("section", { className: "detail-section" });
  section.appendChild(
    el("h2", { className: "detail-section-title", text: "Informations" }),
  );

  const grid = el("div", { className: "detail-info-grid" });
  const rows: readonly (readonly [string, string])[] = [
    ["Achetable", booleanLabel(asBoolean(item.purchasable))],
    ["En boutique", booleanLabel(asBoolean(item.inStore))],
    ["Consommable", booleanLabel(asBoolean(item.consumed))],
    [
      "Niveau de recette",
      asNumber(item.depth) === null ? EMPTY_VALUE : formatCount(asNumber(item.depth) ?? 0),
    ],
    ["Faille de l'invocateur", booleanLabel(asBoolean(item.onSummonersRift))],
  ];
  for (const [label, value] of rows) {
    const row = el("div", { className: "detail-info-row" });
    append(
      row,
      el("span", { className: "detail-info-label", text: label }),
      el("span", { className: "detail-info-value", text: value }),
    );
    grid.appendChild(row);
  }
  section.appendChild(grid);
  return section;
}

function buildStatsSection(item: Item): HTMLElement {
  const section = el("section", { className: "detail-section" });
  section.appendChild(
    el("h2", { className: "detail-section-title", text: "Statistiques" }),
  );

  const stats = Array.isArray(item.stats) ? item.stats : [];
  if (stats.length === 0) {
    append(
      section,
      el("p", { className: "detail-empty", text: EMPTY_VALUE }),
      el("p", {
        className: "detail-empty-hint",
        text: "Aucune statistique fournie par Data Dragon pour cet objet.",
      }),
    );
    return section;
  }

  const list = el("ul", { className: "detail-stat-list" });
  for (const stat of stats) {
    list.appendChild(el("li", { className: "detail-stat", text: formatItemStat(stat) }));
  }
  section.appendChild(list);
  return section;
}

function buildDescriptionSection(item: Item): HTMLElement {
  const section = el("section", { className: "detail-section" });
  section.appendChild(
    el("h2", { className: "detail-section-title", text: "Description" }),
  );
  section.appendChild(
    el("p", { className: "detail-desc", text: textOrEmpty(cleanItemText(item.description)) }),
  );
  return section;
}

function resolveRecipe(ids: unknown, allItems: readonly Item[]): RecipeEntry[] {
  const source = Array.isArray(ids) ? ids : [];
  const counts = new Map<string, number>();
  for (const id of source) {
    if (typeof id !== "string" || id === "") {
      continue;
    }
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const entries: RecipeEntry[] = [];
  for (const [id, count] of counts) {
    entries.push({ id, count, item: allItems.find((candidate) => candidate.id === id) ?? null });
  }
  return entries;
}

function buildRecipeEntry(
  entry: RecipeEntry,
  onOpen: (itemId: string, trigger: HTMLElement) => void,
): HTMLElement {
  const resolved = entry.item;
  if (resolved === null) {
    // Identifiant absent du cache : aucun nom inventé, l'id brut reste visible.
    const row = el("div", { className: "item-recipe item-recipe--missing" });
    append(
      row,
      createIconPlaceholder("item-recipe-icon item-recipe-icon--placeholder"),
      el("span", {
        className: "item-recipe-id",
        text: `#${entry.id}`,
        attrs: { title: "Objet introuvable dans les données chargées" },
      }),
      el("span", { className: "item-recipe-missing-value", text: EMPTY_VALUE }),
    );
    return row;
  }

  const name = displayItemName(resolved);
  const button = el("button", {
    className: "item-recipe",
    attrs: {
      type: "button",
      "data-recipe-item-id": resolved.id,
      "aria-label": `Ouvrir la fiche de ${name}`,
      title: `Ouvrir la fiche de ${name}`,
    },
  });

  const iconWrap = el("span", { className: "item-recipe-icon-wrap" });
  const iconPath = asString(resolved.iconPath);
  if (iconPath !== null) {
    const image = el("img", {
      className: "item-recipe-icon",
      attrs: {
        alt: name,
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "32",
        height: "32",
      },
    });
    image.src = api.assetUrl(iconPath);
    image.addEventListener("error", () => {
      image.replaceWith(createIconPlaceholder("item-recipe-icon item-recipe-icon--placeholder"));
    });
    iconWrap.appendChild(image);
  } else {
    iconWrap.appendChild(createIconPlaceholder("item-recipe-icon item-recipe-icon--placeholder"));
  }

  const body = el("span", { className: "item-recipe-body" });
  append(
    body,
    el("span", { className: "item-recipe-name", text: name }),
    el("span", {
      className: "item-recipe-gold",
      text: `${formatCount(asNumber(resolved.goldTotal) ?? 0)} or`,
    }),
  );
  append(button, iconWrap, body);
  if (entry.count > 1) {
    button.appendChild(
      el("span", { className: "item-recipe-count", text: `×${entry.count}` }),
    );
  }
  button.addEventListener("click", () => {
    onOpen(resolved.id, button);
  });
  return button;
}

function buildRecipeSection(
  title: string,
  ids: unknown,
  allItems: readonly Item[],
  emptyHint: string,
  onOpen: (itemId: string, trigger: HTMLElement) => void,
): HTMLElement {
  const section = el("section", { className: "detail-section" });
  section.appendChild(el("h2", { className: "detail-section-title", text: title }));

  const entries = resolveRecipe(ids, allItems);
  if (entries.length === 0) {
    append(
      section,
      el("p", { className: "detail-empty", text: EMPTY_VALUE }),
      el("p", { className: "detail-empty-hint", text: emptyHint }),
    );
    return section;
  }

  const grid = el("div", { className: "item-recipe-grid" });
  for (const entry of entries) {
    grid.appendChild(buildRecipeEntry(entry, onOpen));
  }
  section.appendChild(grid);
  return section;
}

function buildDetailLayout(
  item: Item,
  allItems: readonly Item[],
  options: ItemDetailViewOptions,
): HTMLElement {
  const layout = el("div", { className: "item-detail-layout" });

  const head = el("header", { className: "detail-hero-row" });
  const identity = el("div", { className: "detail-identity" });
  append(
    identity,
    el("h1", {
      className: "detail-entity-name item-detail-name",
      text: displayItemName(item),
    }),
    buildTags(item),
  );
  append(head, buildLargeIcon(item), identity, buildGoldBlock(item));
  layout.appendChild(head);

  layout.appendChild(buildInfoSection(item));
  layout.appendChild(buildStatsSection(item));
  layout.appendChild(buildDescriptionSection(item));
  layout.appendChild(
    buildRecipeSection(
      "Recette",
      item.from,
      allItems,
      "Aucun composant fourni par Data Dragon pour cet objet.",
      options.onOpenItem,
    ),
  );
  layout.appendChild(
    buildRecipeSection(
      "Se transforme en",
      item.into,
      allItems,
      "Aucune transformation fournie par Data Dragon pour cet objet.",
      options.onOpenItem,
    ),
  );

  layout.appendChild(el("p", { className: "detail-note", text: HONEST_NOTE }));
  return layout;
}

export function createItemDetailView(
  options: ItemDetailViewOptions,
): ItemDetailViewHandle {
  const backButton = el("button", {
    className: "btn btn-ghost detail-back",
    attrs: {
      type: "button",
      "data-action": "back-item",
      title: "Revenir à la grille des objets",
    },
  });
  append(
    backButton,
    icon("arrowLeft", 15),
    el("span", { className: "btn-label", text: "Retour aux objets" }),
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
    className: "view view--item-detail",
    attrs: {
      id: "view-item-detail",
      "data-view": "item-detail",
      "aria-label": "Fiche objet",
      role: "region",
    },
  });
  append(element, topbar, content, announcer);
  element.hidden = true;

  function setItem(item: Item, allItems: readonly Item[]): void {
    element.setAttribute("data-item-detail-id", item.id);
    replaceContent(content, buildDetailLayout(item, allItems, options));
    announcer.textContent = `Fiche de ${displayItemName(item)}.`;
  }

  function clear(): void {
    element.removeAttribute("data-item-detail-id");
    replaceContent(content);
    announcer.textContent = "";
  }

  function focusBackButton(): void {
    backButton.focus();
  }

  return { element, setItem, clear, focusBackButton };
}
