/**
 * Vue « Objets » : grille des objets Data Dragon du cache local.
 *
 * - données 100 % réelles via `api.getItems()` (aucun prix ni stat inventé) ;
 * - icônes locales via `api.assetUrl()` avec placeholder « — » si absentes ;
 * - jusqu'à 4 puces de statistiques réelles par carte, clés Riot inconnues
 *   affichées telles quelles ;
 * - catégories construites depuis les tags réellement présents, libellés FR
 *   (tag inconnu → nom brut), filtre unique + « Tous » ;
 * - chaque carte est un bouton accessible (`data-item-id`) qui ouvre la fiche
 *   objet détaillée (V0.4).
 */

import { api } from "../api";
import { buildLoadingState, buildPanelState } from "../components/states";
import type { Item } from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE, formatCount, normalizeForSearch } from "../ui/format";
import { icon } from "../ui/icons";
import {
  displayItemName,
  displayItemPlainText,
  itemStatChips,
  itemTagLabel,
} from "../ui/item-labels";
import { panelId, tabId } from "../ui/view";

export interface ItemsViewOptions {
  readonly onSync: () => void;
  /** Ouvre la fiche objet détaillée (clic ou clavier). */
  readonly onOpenItem: (itemId: string, trigger: HTMLElement) => void;
}

export interface ItemsViewHandle {
  readonly element: HTMLElement;
  setLoading(message: string): void;
  setItems(items: readonly Item[]): void;
  setError(title: string, message: string, retryLabel: string, onRetry: () => void): void;
}

interface ItemEntry {
  readonly element: HTMLButtonElement;
  readonly haystack: string;
  readonly tags: readonly string[];
}

interface FilterEntry {
  readonly tag: string;
  readonly label: string;
  readonly count: number;
}

const MAX_STAT_CHIPS = 4;

function itemHaystack(item: Item): string {
  return normalizeForSearch(`${displayItemName(item)} ${displayItemPlainText(item)}`);
}

function createItemPlaceholder(): HTMLElement {
  return el("span", {
    className: "item-icon item-icon--placeholder",
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

function createThumb(item: Item): HTMLElement {
  const thumb = el("div", { className: "item-thumb" });
  const iconPath = typeof item.iconPath === "string" ? item.iconPath : null;

  if (iconPath !== null && iconPath.trim() !== "") {
    const image = el("img", {
      className: "item-icon",
      attrs: {
        alt: displayItemName(item),
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "112",
        height: "112",
      },
    });
    image.src = api.assetUrl(iconPath);
    image.addEventListener("error", () => {
      image.replaceWith(createItemPlaceholder());
    });
    thumb.appendChild(image);
  } else {
    thumb.appendChild(createItemPlaceholder());
  }

  return thumb;
}

function createItemCard(
  item: Item,
  onOpen: (itemId: string, trigger: HTMLElement) => void,
): HTMLButtonElement {
  const body = el("div", { className: "item-body" });
  const nameText = displayItemName(item);
  const card = el("button", {
    className: "item-card",
    attrs: {
      type: "button",
      "data-item-id": item.id,
      "aria-label": `Ouvrir la fiche de ${nameText}`,
      title: `Ouvrir la fiche de ${nameText}`,
    },
  });

  const name = el("span", {
    className: "item-name",
    text: nameText,
    attrs: { title: nameText },
  });

  const gold = el("span", { className: "item-gold", attrs: { title: "Prix total en or" } });
  append(
    gold,
    el("span", { className: "item-gold-value", text: formatCount(item.goldTotal) }),
    el("span", { className: "item-gold-label", text: "or" }),
  );

  const stats = el("div", { className: "item-stats" });
  const chips = itemStatChips(item, MAX_STAT_CHIPS);
  if (chips.length > 0) {
    for (const chip of chips) {
      stats.appendChild(el("span", { className: "item-stat", text: chip }));
    }
  } else if (item.tags.length > 0) {
    // Aucune statistique réelle : on n'invente rien, on affiche un tag réel.
    const tag = item.tags[0];
    if (tag !== undefined) {
      stats.appendChild(
        el("span", {
          className: "item-tag-chip",
          text: itemTagLabel(tag),
          attrs: { "data-item-tag": tag, title: tag },
        }),
      );
    }
  }

  append(body, name, gold, stats);
  append(card, createThumb(item), body);
  card.addEventListener("click", () => {
    onOpen(item.id, card);
  });
  return card;
}

function collectTags(items: readonly Item[]): FilterEntry[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of item.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }

  // Les catégories les plus fournies d'abord, puis ordre alphabétique.
  const tags = [...counts.keys()].sort((a, b) => {
    const difference = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
    return difference !== 0 ? difference : a.localeCompare(b, "fr");
  });

  // Deux tags peuvent partager le même libellé français : on désambiguïse
  // avec le tag brut plutôt que d'afficher deux puces identiques.
  const usedLabels = new Set<string>();
  const entries: FilterEntry[] = [];
  for (const tag of tags) {
    let label = itemTagLabel(tag);
    if (usedLabels.has(label)) {
      label = `${label} (${tag})`;
    }
    usedLabels.add(label);
    entries.push({ tag, label, count: counts.get(tag) ?? 0 });
  }
  return entries;
}

export function createItemsView(options: ItemsViewOptions): ItemsViewHandle {
  // --- En-tête de vue : recherche + compteur --------------------------
  const searchField = el("label", { className: "search-field" });
  const searchInput = el("input", {
    className: "search-input",
    attrs: {
      type: "search",
      placeholder: "Rechercher un objet…",
      "aria-label": "Rechercher un objet par nom",
      "data-items-search": "true",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  append(searchField, icon("search", 15), searchInput);

  const counter = el("span", { className: "champ-count items-count", text: EMPTY_VALUE });

  const toolbar = el("div", { className: "champ-toolbar" });
  append(toolbar, searchField, counter);

  const heading = el("div", { className: "view-heading" });
  append(
    heading,
    el("h1", { className: "view-title", text: "Objets" }),
    el("p", {
      className: "view-sub",
      text: "Objets issus du cache local Data Dragon — prix et statistiques réels.",
    }),
  );

  const head = el("header", { className: "view-head" });
  append(head, heading, toolbar);

  const filterBar = el("div", {
    className: "filter-bar",
    attrs: { role: "group", "aria-label": "Filtrer les objets par catégorie" },
  });
  filterBar.hidden = true;

  const content = el("div", { className: "champ-content" });
  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "view view--items",
    attrs: {
      role: "tabpanel",
      id: panelId("items"),
      "aria-labelledby": tabId("items"),
    },
  });
  append(element, head, filterBar, content, announcer);
  element.hidden = true;

  // --- État interne ----------------------------------------------------
  let entries: readonly ItemEntry[] = [];
  let query = "";
  let activeTag: string | null = null;
  let grid: HTMLDivElement | null = null;
  let filterEmpty: HTMLElement | null = null;
  let filterButtons: HTMLButtonElement[] = [];

  function setLoading(message: string): void {
    toolbar.hidden = true;
    filterBar.hidden = true;
    entries = [];
    grid = null;
    filterEmpty = null;
    query = "";
    activeTag = null;
    filterButtons = [];
    searchInput.value = "";
    replaceContent(content, buildLoadingState({ message, variant: "items" }));
    announcer.textContent = message;
  }

  function setError(title: string, message: string, retryLabel: string, onRetry: () => void): void {
    toolbar.hidden = true;
    filterBar.hidden = true;
    entries = [];
    grid = null;
    filterEmpty = null;
    filterButtons = [];
    replaceContent(
      content,
      buildPanelState({
        tone: "error",
        title,
        message,
        actionLabel: retryLabel,
        onAction: onRetry,
        iconName: "alert",
      }),
    );
    announcer.textContent = `${title}. ${message}`;
  }

  function syncFilterButtons(): void {
    for (const button of filterButtons) {
      const tag = button.dataset["itemTag"] ?? null;
      const pressed = tag === activeTag;
      button.setAttribute("aria-pressed", pressed ? "true" : "false");
    }
  }

  function buildFilters(filters: readonly FilterEntry[], totalCount: number): void {
    filterButtons = [];

    const allButton = el("button", {
      className: "filter-chip",
      attrs: { type: "button", "aria-pressed": activeTag === null ? "true" : "false" },
    });
    append(
      allButton,
      el("span", { className: "filter-label", text: "Tous" }),
      el("span", { className: "filter-count", text: formatCount(totalCount) }),
    );
    allButton.addEventListener("click", () => {
      activeTag = null;
      syncFilterButtons();
      applyFilters();
    });
    filterButtons.push(allButton);

    const buttons: HTMLElement[] = [allButton];
    for (const filter of filters) {
      const button = el("button", {
        className: "filter-chip",
        attrs: {
          type: "button",
          "data-item-tag": filter.tag,
          "aria-pressed": filter.tag === activeTag ? "true" : "false",
          title: `Tag Data Dragon : ${filter.tag}`,
        },
      });
      append(
        button,
        el("span", { className: "filter-label", text: filter.label }),
        el("span", { className: "filter-count", text: formatCount(filter.count) }),
      );
      button.addEventListener("click", () => {
        activeTag = filter.tag;
        syncFilterButtons();
        applyFilters();
      });
      filterButtons.push(button);
      buttons.push(button);
    }

    replaceContent(filterBar, ...buttons);
  }

  function noMatchMessage(search: string, tag: string | null): string {
    const label = tag === null ? null : itemTagLabel(tag);
    if (search !== "" && label !== null) {
      return `Aucun objet ne correspond à « ${search} » dans la catégorie « ${label} ».`;
    }
    if (search !== "") {
      return `Aucun objet ne correspond à « ${search} ».`;
    }
    if (label !== null) {
      return `Aucun objet dans la catégorie « ${label} ».`;
    }
    return "Aucun objet ne correspond aux filtres actifs.";
  }

  function applyFilters(): void {
    if (grid === null || filterEmpty === null) {
      return;
    }

    const trimmed = query.trim();
    const normalized = normalizeForSearch(trimmed);
    const matching = entries.filter((entry) => {
      if (activeTag !== null && !entry.tags.includes(activeTag)) {
        return false;
      }
      return normalized === "" || entry.haystack.includes(normalized);
    });

    const fragment = document.createDocumentFragment();
    for (const entry of matching) {
      fragment.appendChild(entry.element);
    }
    grid.replaceChildren(fragment);

    const noMatch = matching.length === 0 && entries.length > 0;
    grid.hidden = matching.length === 0;
    filterEmpty.hidden = !noMatch;

    if (noMatch) {
      const message = noMatchMessage(trimmed, activeTag);
      filterEmpty.textContent = message;
      announcer.textContent = message;
    }

    counter.textContent = `${formatCount(matching.length)} / ${formatCount(entries.length)} objets`;
  }

  function setItems(items: readonly Item[]): void {
    if (items.length === 0) {
      toolbar.hidden = true;
      filterBar.hidden = true;
      entries = [];
      grid = null;
      filterEmpty = null;
      filterButtons = [];
      replaceContent(
        content,
        buildPanelState({
          tone: "empty",
          title: "Aucun objet en cache",
          message:
            "Le cache local Data Dragon ne contient aucun objet. Lancez une synchronisation pour remplir la grille.",
          actionLabel: "Synchroniser",
          onAction: options.onSync,
          iconName: "grid",
        }),
      );
      announcer.textContent = "Aucun objet dans le cache local.";
      return;
    }

    const filters = collectTags(items);
    const filterTags = new Set(filters.map((filter) => filter.tag));
    if (activeTag !== null && !filterTags.has(activeTag)) {
      activeTag = null;
    }

    const nextGrid = el("div", {
      className: "item-grid",
      attrs: { "aria-label": `Objets du cache local (${formatCount(items.length)})` },
    });
    const nextFilterEmpty = el("p", { className: "filter-empty" });
    nextFilterEmpty.hidden = true;

    const results = el("div", { className: "item-results" });
    append(results, nextGrid, nextFilterEmpty);

    const nextEntries: ItemEntry[] = [];
    for (const item of items) {
      nextEntries.push({
        element: createItemCard(item, options.onOpenItem),
        haystack: itemHaystack(item),
        tags: item.tags,
      });
    }

    entries = nextEntries;
    grid = nextGrid;
    filterEmpty = nextFilterEmpty;
    toolbar.hidden = false;
    filterBar.hidden = false;
    searchInput.value = query;
    buildFilters(filters, items.length);
    replaceContent(content, results);
    announcer.textContent = `${formatCount(items.length)} objets chargés depuis le cache local.`;
    applyFilters();
  }

  // --- Événements ------------------------------------------------------
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    applyFilters();
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchInput.value !== "") {
      event.preventDefault();
      searchInput.value = "";
      query = "";
      applyFilters();
    }
  });

  return { element, setLoading, setItems, setError };
}
