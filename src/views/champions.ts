/**
 * Vue « Champions » : grille issue du cache local Data Dragon.
 *
 * - aucune donnée en dur : tout vient de `api.getChampions()` ;
 * - icônes uniquement via `api.assetUrl()` (PNG locaux) ; une icône absente
 *   affiche le placeholder « — », jamais une image inventée ;
 * - chaque carte est un bouton accessible (`data-champion-id`) ouvrant la
 *   fiche détaillée (V0.2) ;
 * - recherche instantanée nom + titre, insensible à la casse et aux accents.
 */

import { api } from "../api";
import { buildLoadingState, buildPanelState } from "../components/states";
import type { Champion } from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE, formatCount, normalizeForSearch } from "../ui/format";
import { icon } from "../ui/icons";
import { panelId, tabId } from "../ui/view";

export interface ChampionsViewOptions {
  readonly onSync: () => void;
  /** Ouvre la fiche détaillée du champion, au clic ou au clavier. */
  readonly onOpenChampion: (championId: string, trigger: HTMLElement) => void;
}

export interface ChampionsViewHandle {
  readonly element: HTMLElement;
  setLoading(message: string): void;
  setChampions(champions: readonly Champion[]): void;
  setError(title: string, message: string, retryLabel: string, onRetry: () => void): void;
}

interface CardEntry {
  readonly element: HTMLButtonElement;
  readonly haystack: string;
  readonly tags: readonly string[];
}

/** Ordre d'affichage des classes Data Dragon (les inconnues sont ajoutées après). */
const CLASS_ORDER = ["Fighter", "Tank", "Mage", "Assassin", "Marksman", "Support"] as const;

function buildHaystack(champion: Champion): string {
  return normalizeForSearch(`${champion.name} ${champion.title}`);
}

function createIconPlaceholder(): HTMLElement {
  return el("span", {
    className: "champ-icon champ-icon--placeholder",
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

function createThumb(champion: Champion): HTMLElement {
  const thumb = el("span", { className: "champ-thumb" });
  const iconPath = champion.iconPath;

  if (iconPath !== null && iconPath.trim() !== "") {
    const image = el("img", {
      className: "champ-icon",
      attrs: {
        alt: champion.name,
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "112",
        height: "112",
      },
    });
    image.src = api.assetUrl(iconPath);
    // Fichier absent/corrompu malgré un chemin en cache : placeholder honnête.
    image.addEventListener("error", () => {
      image.replaceWith(createIconPlaceholder());
    });
    thumb.appendChild(image);
  } else {
    thumb.appendChild(createIconPlaceholder());
  }

  if (champion.key.trim() !== "") {
    thumb.appendChild(
      el("span", {
        className: "champ-key",
        text: champion.key,
        attrs: { "aria-hidden": "true" },
      }),
    );
  }

  return thumb;
}

function createCard(
  champion: Champion,
  onOpen: (championId: string, trigger: HTMLElement) => void,
): HTMLButtonElement {
  const title = champion.title.trim();
  const card = el("button", {
    className: "champ-card",
    attrs: {
      type: "button",
      "data-champion-id": champion.id,
      "aria-label": title === "" ? champion.name : `${champion.name} — ${title}`,
      title: `Ouvrir la fiche de ${champion.name}`,
    },
  });

  const info = el("span", { className: "champ-info" });
  append(
    info,
    el("span", { className: "champ-name", text: champion.name }),
    el("span", {
      className: "champ-title",
      text: title === "" ? EMPTY_VALUE : champion.title,
      attrs: { title: title === "" ? "Titre non fourni par les données" : champion.title },
    }),
  );

  const tags = el("span", { className: "champ-tags" });
  if (champion.tags.length === 0) {
    tags.appendChild(el("span", { className: "champ-tag champ-tag--empty", text: EMPTY_VALUE }));
  } else {
    for (const tag of champion.tags) {
      tags.appendChild(el("span", { className: "champ-tag", text: tag }));
    }
  }
  info.appendChild(tags);

  append(card, createThumb(champion), info);
  card.addEventListener("click", () => {
    onOpen(champion.id, card);
  });
  return card;
}

export function createChampionsView(options: ChampionsViewOptions): ChampionsViewHandle {
  // --- En-tête de vue : recherche + compteur --------------------------
  const searchField = el("label", { className: "search-field" });
  const searchInput = el("input", {
    className: "search-input",
    attrs: {
      type: "search",
      placeholder: "Rechercher un champion…",
      "aria-label": "Rechercher un champion par nom ou titre",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  append(searchField, icon("search", 15), searchInput);

  const counter = el("span", { className: "champ-count", text: EMPTY_VALUE });

  const toolbar = el("div", { className: "champ-toolbar" });
  append(toolbar, searchField, counter);

  const tagBar = el("div", {
    className: "champ-class-filter",
    attrs: { role: "group", "aria-label": "Filtrer les champions par classe" },
  });
  tagBar.hidden = true;

  const heading = el("div", { className: "view-heading" });
  append(
    heading,
    el("h1", { className: "view-title", text: "Champions" }),
    el("p", {
      className: "view-sub",
      text: "Grille issue du cache local Data Dragon — aucune donnée distante.",
    }),
  );

  const head = el("header", { className: "view-head" });
  append(head, heading, toolbar, tagBar);

  // --- Contenu et annonceur -------------------------------------------
  const content = el("div", { className: "champ-content" });
  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "view view--champions",
    attrs: {
      role: "tabpanel",
      id: panelId("champions"),
      "aria-labelledby": tabId("champions"),
    },
  });
  append(element, head, content, announcer);

  // --- État interne ----------------------------------------------------
  let entries: readonly CardEntry[] = [];
  let query = "";
  let activeTag: string | null = null;
  let grid: HTMLDivElement | null = null;
  let filterEmpty: HTMLElement | null = null;
  const tagButtons = new Map<string, HTMLButtonElement>();

  function setTag(next: string | null): void {
    activeTag = next;
    const selectedKey = next ?? "all";
    for (const [tag, button] of tagButtons) {
      button.setAttribute("aria-pressed", tag === selectedKey ? "true" : "false");
    }
    applyFilter();
  }

  function buildTagBar(champions: readonly Champion[]): void {
    const available = new Set<string>();
    for (const champion of champions) {
      for (const tag of champion.tags) {
        if (tag.trim() !== "") {
          available.add(tag);
        }
      }
    }
    const ordered: string[] = CLASS_ORDER.filter((tag) => available.has(tag));
    for (const tag of available) {
      if (!ordered.includes(tag)) {
        ordered.push(tag);
      }
    }

    if (activeTag !== null && !available.has(activeTag)) {
      activeTag = null;
    }

    tagButtons.clear();
    replaceContent(tagBar);
    if (ordered.length === 0) {
      tagBar.hidden = true;
      return;
    }

    const addButton = (value: string | null, label: string): void => {
      const button = el("button", {
        className: "champ-class",
        text: label,
        attrs: {
          type: "button",
          "data-champion-tag": value ?? "all",
          "aria-pressed": activeTag === value ? "true" : "false",
        },
      });
      button.addEventListener("click", () => {
        setTag(value);
      });
      tagButtons.set(value ?? "all", button);
      tagBar.appendChild(button);
    };
    addButton(null, "Tous");
    for (const tag of ordered) {
      addButton(tag, tag);
    }
    tagBar.hidden = false;
  }

  function setLoading(message: string): void {
    toolbar.hidden = true;
    tagBar.hidden = true;
    entries = [];
    grid = null;
    filterEmpty = null;
    query = "";
    searchInput.value = "";
    replaceContent(content, buildLoadingState({ message, variant: "champions" }));
    announcer.textContent = message;
  }

  function setError(title: string, message: string, retryLabel: string, onRetry: () => void): void {
    toolbar.hidden = true;
    tagBar.hidden = true;
    entries = [];
    grid = null;
    filterEmpty = null;
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

  function applyFilter(): void {
    if (grid === null || filterEmpty === null) {
      return;
    }

    const trimmed = query.trim();
    const normalized = normalizeForSearch(trimmed);
    const matching = entries.filter((entry) => {
      const matchesText = normalized === "" || entry.haystack.includes(normalized);
      const matchesTag = activeTag === null || entry.tags.includes(activeTag);
      return matchesText && matchesTag;
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
      const filters: string[] = [];
      if (trimmed !== "") {
        filters.push(`« ${trimmed} »`);
      }
      if (activeTag !== null) {
        filters.push(`classe ${activeTag}`);
      }
      const label = filters.length > 0 ? filters.join(" + ") : "ces filtres";
      filterEmpty.textContent = `Aucun champion ne correspond à ${label}.`;
      announcer.textContent = `Aucun champion ne correspond à ${label}.`;
    }

    counter.textContent = `${formatCount(matching.length)} / ${formatCount(entries.length)} champions`;
  }

  function setChampions(champions: readonly Champion[]): void {
    if (champions.length === 0) {
      toolbar.hidden = true;
      tagBar.hidden = true;
      entries = [];
      grid = null;
      filterEmpty = null;
      replaceContent(
        content,
        buildPanelState({
          tone: "empty",
          title: "Aucun champion en cache",
          message:
            "Le cache local Data Dragon ne contient aucun champion. Lancez une synchronisation pour remplir la grille.",
          actionLabel: "Synchroniser",
          onAction: options.onSync,
          iconName: "grid",
        }),
      );
      announcer.textContent = "Aucun champion dans le cache local.";
      return;
    }

    const nextGrid = el("div", {
      className: "champ-grid",
      attrs: { "aria-label": `Champions du cache local (${formatCount(champions.length)})` },
    });
    const nextFilterEmpty = el("p", { className: "filter-empty" });
    nextFilterEmpty.hidden = true;

    const results = el("div", { className: "champ-results" });
    append(results, nextGrid, nextFilterEmpty);

    const nextEntries: CardEntry[] = [];
    for (const champion of champions) {
      nextEntries.push({
        element: createCard(champion, options.onOpenChampion),
        haystack: buildHaystack(champion),
        tags: champion.tags,
      });
    }

    entries = nextEntries;
    grid = nextGrid;
    filterEmpty = nextFilterEmpty;
    toolbar.hidden = false;
    buildTagBar(champions);
    searchInput.value = query;
    replaceContent(content, results);
    announcer.textContent = `${formatCount(champions.length)} champions chargés depuis le cache local.`;
    // Le filtre actif peut remplacer l'annonce par « aucun résultat ».
    applyFilter();
  }

  // --- Événements ------------------------------------------------------
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    applyFilter();
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchInput.value !== "") {
      event.preventDefault();
      searchInput.value = "";
      query = "";
      applyFilter();
    }
  });

  return { element, setLoading, setChampions, setError };
}
