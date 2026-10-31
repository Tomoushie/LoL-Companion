/**
 * Vue « Runes » : arbres officiels Data Dragon et Rune Builder OP.GG (V0.7).
 *
 * Deux sous-onglets : « Arbres » (vue historique, 5 arbres, recherche FR/EN) et
 * « Rune Builder » (trois pages réelles OP.GG pour un champion et un rôle).
 * Les noms et descriptions français proviennent de la localisation officielle
 * fr_FR fournie par le backend ; fallback en_US si null, « — » si la
 * description manque. Aucun texte n'est inventé côté interface.
 * Chaque carte de rune est un bouton accessible (`data-rune-id`) qui ouvre la
 * fiche rune détaillée (V0.4).
 */

import { api } from "../api";
import { buildPanelState } from "../components/states";
import type { Champion, Rune, RuneTree } from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE, formatCount, normalizeForSearch } from "../ui/format";
import { icon } from "../ui/icons";
import {
  optionalString,
  runeDisplayName,
  runeSecondaryName,
  runeShortDescription,
  runeTreeDisplayName,
  sortRuneTrees,
} from "../ui/rune-labels";
import { panelId, tabId } from "../ui/view";
import { createRuneBuilder } from "./rune-builder";

export interface RunesViewOptions {
  readonly onSync: () => void;
  /** Ouvre la fiche rune détaillée (clic ou clavier). */
  readonly onOpenRune: (runeId: number, trigger: HTMLElement) => void;
  /** Champions chargés (utilisés par le Rune Builder). */
  readonly getChampions: () => readonly Champion[];
}

export interface RunesViewHandle {
  readonly element: HTMLElement;
  setLoading(message: string): void;
  setRuneTrees(trees: readonly RuneTree[]): void;
  setError(title: string, message: string, retryLabel: string, onRetry: () => void): void;
  /** Sélectionne un arbre par clé (utilisé par la fiche rune / recherche globale). */
  selectTreeByKey(treeKey: string): void;
  /** Reconstruit la liste des champions du Rune Builder. */
  refreshChampionOptions(): void;
}

interface SearchMatch {
  readonly tree: RuneTree;
  readonly rune: Rune;
}

function createIconPlaceholder(className: string): HTMLElement {
  return el("span", {
    className,
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

function buildTreeIcon(tree: RuneTree, large: boolean): HTMLElement {
  const wrapper = el("span", {
    className: large ? "rune-tree-icon-wrap rune-tree-icon-wrap--large" : "rune-tree-icon-wrap",
  });
  const iconPath = optionalString(tree.iconPath);

  if (iconPath !== null) {
    const image = el("img", {
      className: "rune-tree-icon",
      attrs: {
        alt: `Icône de l'arbre ${runeTreeDisplayName(tree)}`,
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: large ? "56" : "40",
        height: large ? "56" : "40",
      },
    });
    image.src = api.assetUrl(iconPath);
    image.addEventListener("error", () => {
      image.replaceWith(createIconPlaceholder("rune-tree-icon rune-tree-icon--placeholder"));
    });
    wrapper.appendChild(image);
  } else {
    wrapper.appendChild(createIconPlaceholder("rune-tree-icon rune-tree-icon--placeholder"));
  }

  return wrapper;
}

function buildRuneIcon(rune: Rune): HTMLElement {
  const wrapper = el("span", { className: "rune-icon-wrap" });
  const iconPath = optionalString(rune.iconPath);

  if (iconPath !== null) {
    const image = el("img", {
      className: "rune-icon",
      attrs: {
        alt: runeDisplayName(rune),
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "48",
        height: "48",
      },
    });
    image.src = api.assetUrl(iconPath);
    image.addEventListener("error", () => {
      image.replaceWith(createIconPlaceholder("rune-icon rune-icon--placeholder"));
    });
    wrapper.appendChild(image);
  } else {
    wrapper.appendChild(createIconPlaceholder("rune-icon rune-icon--placeholder"));
  }

  return wrapper;
}

function buildTreeCard(
  tree: RuneTree,
  pressed: boolean,
  onSelect: (tree: RuneTree) => void,
): HTMLButtonElement {
  const card = el("button", {
    className: "rune-tree-card",
    attrs: {
      type: "button",
      "data-rune-tree": tree.key,
      "aria-pressed": pressed ? "true" : "false",
      title: `${runeTreeDisplayName(tree)} — ${formatCount(tree.runes.length)} runes`,
    },
  });

  const body = el("span", { className: "rune-tree-card-body" });
  body.appendChild(el("span", { className: "rune-tree-name", text: runeTreeDisplayName(tree) }));

  const secondary = runeSecondaryName(optionalString(tree.localizedName), tree.name);
  if (secondary !== null) {
    body.appendChild(el("span", { className: "rune-tree-name-en", text: secondary }));
  }
  body.appendChild(
    el("span", {
      className: "rune-tree-rune-count",
      text: `${formatCount(tree.runes.length)} runes`,
    }),
  );

  append(card, buildTreeIcon(tree, false), body);
  card.addEventListener("click", () => {
    onSelect(tree);
  });
  return card;
}

function buildRuneCard(
  rune: Rune,
  parentTree: RuneTree | null,
  onOpen: (runeId: number, trigger: HTMLElement) => void,
): HTMLButtonElement {
  const isKeystone = rune.slot === 0;
  const name = runeDisplayName(rune);
  const card = el("button", {
    className: parentTree === null ? "rune-card" : "rune-card rune-card--result",
    attrs: {
      type: "button",
      "data-rune-id": String(rune.id),
      "aria-label": `Ouvrir la fiche de ${name}`,
      title: `Ouvrir la fiche de ${name}`,
    },
  });
  if (parentTree !== null) {
    card.setAttribute("data-rune-result", "true");
  }

  const body = el("span", { className: "rune-card-body" });
  const head = el("span", { className: "rune-card-head" });
  append(
    head,
    el("span", {
      className: "rune-name",
      text: name,
      attrs: { "data-rune-name": "true" },
    }),
    el("span", {
      className: isKeystone ? "rune-badge rune-badge--keystone" : "rune-badge",
      text: isKeystone ? "Majeure" : "Mineure",
    }),
  );
  body.appendChild(head);

  const secondary = runeSecondaryName(optionalString(rune.localizedName), rune.name);
  if (secondary !== null) {
    body.appendChild(el("span", { className: "rune-name-en", text: secondary }));
  }

  if (parentTree !== null) {
    body.appendChild(
      el("span", {
        className: "rune-parent",
        text: runeTreeDisplayName(parentTree),
        attrs: { "data-rune-tree-name": "true", title: "Arbre d'origine" },
      }),
    );
  }

  body.appendChild(el("span", { className: "rune-desc", text: runeShortDescription(rune) }));
  append(card, buildRuneIcon(rune), body);
  card.addEventListener("click", () => {
    onOpen(rune.id, card);
  });
  return card;
}

function buildSection(
  sectionId: string,
  title: string,
  runes: readonly Rune[],
  onOpen: (runeId: number, trigger: HTMLElement) => void,
): HTMLElement {
  const section = el("section", {
    className: "rune-section",
    attrs: { "data-rune-section": sectionId },
  });
  section.appendChild(el("h3", { className: "rune-section-title", text: title }));

  const grid = el("div", { className: "rune-card-grid" });
  for (const rune of runes) {
    grid.appendChild(buildRuneCard(rune, null, onOpen));
  }
  section.appendChild(grid);
  return section;
}

function buildTreePanel(
  tree: RuneTree,
  onOpen: (runeId: number, trigger: HTMLElement) => void,
): HTMLElement {
  const panel = el("section", {
    className: "rune-panel",
    attrs: { "data-selected-tree": tree.key },
  });

  const identity = el("div", { className: "rune-panel-identity" });
  append(
    identity,
    el("h2", { className: "rune-panel-title", text: runeTreeDisplayName(tree) }),
  );
  const secondary = runeSecondaryName(optionalString(tree.localizedName), tree.name);
  if (secondary !== null) {
    identity.appendChild(el("span", { className: "rune-panel-subtitle", text: secondary }));
  }
  identity.appendChild(
    el("span", {
      className: "rune-panel-count",
      text: `${formatCount(tree.runes.length)} runes`,
    }),
  );

  const head = el("header", { className: "rune-panel-head" });
  append(head, buildTreeIcon(tree, true), identity);
  panel.appendChild(head);

  const keystones = tree.runes.filter((rune) => rune.slot === 0);
  if (keystones.length > 0) {
    panel.appendChild(buildSection("keystones", "Runes majeures (Keystones)", keystones, onOpen));
  }

  for (const slot of [1, 2, 3]) {
    const minors = tree.runes.filter((rune) => rune.slot === slot);
    if (minors.length === 0) {
      continue;
    }
    panel.appendChild(
      buildSection(`minor-${slot}`, `Runes mineures — palier ${slot}`, minors, onOpen),
    );
  }

  return panel;
}

function buildSearchResults(
  matches: readonly SearchMatch[],
  rawQuery: string,
  onOpen: (runeId: number, trigger: HTMLElement) => void,
): HTMLElement {
  const container = el("div", {
    className: "rune-search-results",
    attrs: { "data-rune-results": "true" },
  });

  if (matches.length === 0) {
    container.appendChild(
      el("p", {
        className: "filter-empty",
        text: `Aucune rune ne correspond à « ${rawQuery.trim()} ».`,
      }),
    );
    return container;
  }

  const grid = el("div", { className: "rune-card-grid rune-card-grid--results" });
  for (const match of matches) {
    grid.appendChild(buildRuneCard(match.rune, match.tree, onOpen));
  }
  container.appendChild(grid);
  return container;
}

function buildLoading(message: string): HTMLElement {
  const container = el("div", { className: "state state--loading" });

  const line = el("div", { className: "loading-line" });
  append(
    line,
    el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "loading-text", text: message }),
  );

  const trees = el("div", { className: "rune-trees", attrs: { "aria-hidden": "true" } });
  for (let index = 0; index < 5; index += 1) {
    const skeleton = el("div", { className: "rune-tree-skeleton" });
    const lines = el("div", { className: "rune-tree-skeleton-lines" });
    append(
      lines,
      el("span", { className: "skeleton-line skeleton-line--wide" }),
      el("span", { className: "skeleton-line skeleton-line--short" }),
    );
    append(skeleton, el("span", { className: "skeleton-thumb rune-tree-skeleton-icon" }), lines);
    trees.appendChild(skeleton);
  }

  append(container, line, trees);
  return container;
}

export function createRunesView(options: RunesViewOptions): RunesViewHandle {
  let trees: readonly RuneTree[] = [];
  let treesReady = false;
  let activeSubtab: "trees" | "builder" = "trees";
  let treeButtons = new Map<string, HTMLButtonElement>();

  const builder = createRuneBuilder({
    getChampions: options.getChampions,
    getRuneTrees: () => trees,
  });

  // --- En-tête de vue : recherche + compteur --------------------------
  const searchField = el("label", { className: "search-field" });
  const searchInput = el("input", {
    className: "search-input",
    attrs: {
      type: "search",
      placeholder: "Rechercher une rune…",
      "aria-label": "Rechercher une rune par nom (français ou anglais)",
      "data-runes-search": "true",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  append(searchField, icon("search", 15), searchInput);

  const counter = el("span", { className: "champ-count runes-count", text: EMPTY_VALUE });

  const toolbar = el("div", { className: "champ-toolbar" });
  append(toolbar, searchField, counter);

  const heading = el("div", { className: "view-heading" });
  append(
    heading,
    el("h1", { className: "view-title", text: "Runes" }),
    el("p", {
      className: "view-sub",
      text: "Arbres et runes officiels Data Dragon fr_FR — cache local. Rune Builder : 3 pages réelles OP.GG, sans clé.",
    }),
  );

  const head = el("header", { className: "view-head" });
  append(head, heading, toolbar);

  // --- Sous-onglets Arbres / Rune Builder -----------------------------
  const subtabButtons = new Map<"trees" | "builder", HTMLButtonElement>();
  const subtabList = el("div", {
    className: "rune-subtabs",
    attrs: { role: "tablist", "aria-label": "Sections Runes" },
  });
  const subtabDefinitions: readonly { readonly id: "trees" | "builder"; readonly label: string }[] = [
    { id: "trees", label: "Arbres" },
    { id: "builder", label: "Rune Builder" },
  ];
  for (const definition of subtabDefinitions) {
    const active = definition.id === activeSubtab;
    const button = el("button", {
      className: "rune-subtab",
      text: definition.label,
      attrs: {
        type: "button",
        role: "tab",
        "data-runes-subtab": definition.id,
        "aria-selected": active ? "true" : "false",
        tabindex: active ? "0" : "-1",
      },
    });
    button.addEventListener("click", () => {
      setSubtab(definition.id);
    });
    subtabButtons.set(definition.id, button);
    subtabList.appendChild(button);
  }
  const subtabsBar = el("div", { className: "rune-subtabs-bar" });
  subtabsBar.appendChild(subtabList);
  subtabsBar.hidden = true;

  // --- Grille des arbres + panneau ------------------------------------
  const treesHost = el("div", {
    className: "rune-trees",
    attrs: { role: "group", "aria-label": "Arbres de runes" },
  });
  treesHost.hidden = true;

  const panelHost = el("div", { className: "rune-panel-host" });

  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "view view--runes",
    attrs: {
      role: "tabpanel",
      id: panelId("runes"),
      "data-view": "runes",
      "aria-labelledby": tabId("runes"),
    },
  });
  append(element, head, subtabsBar, treesHost, panelHost, builder.element, announcer);
  element.hidden = true;

  // --- État interne ----------------------------------------------------
  let selectedKey: string | null = null;
  let query = "";

  function selectedTree(): RuneTree | null {
    if (selectedKey !== null) {
      const found = trees.find((tree) => tree.key === selectedKey);
      if (found !== undefined) {
        return found;
      }
    }
    return trees[0] ?? null;
  }

  /** Applique la visibilité des deux sous-onglets et leur état ARIA. */
  function applySubtabUi(): void {
    for (const [id, button] of subtabButtons) {
      const active = id === activeSubtab;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    }
    if (!treesReady) {
      subtabsBar.hidden = true;
      builder.element.hidden = true;
      return;
    }
    subtabsBar.hidden = false;
    const isTrees = activeSubtab === "trees";
    toolbar.hidden = !isTrees;
    treesHost.hidden = !isTrees;
    panelHost.hidden = !isTrees;
    builder.element.hidden = isTrees;
  }

  function setSubtab(next: "trees" | "builder"): void {
    if (activeSubtab === next) {
      return;
    }
    activeSubtab = next;
    applySubtabUi();
    if (next === "builder") {
      builder.refreshChampionOptions();
      announcer.textContent = "Rune Builder : choisissez un champion et un rôle.";
    } else {
      announcer.textContent = "Arbres de runes.";
    }
  }

  function searchMatches(rawQuery: string): readonly SearchMatch[] | null {
    const normalized = normalizeForSearch(rawQuery.trim());
    if (normalized === "") {
      return null;
    }
    const matches: SearchMatch[] = [];
    for (const tree of trees) {
      for (const rune of tree.runes) {
        const haystack = normalizeForSearch(`${runeDisplayName(rune)} ${rune.name}`);
        if (haystack.includes(normalized)) {
          matches.push({ tree, rune });
        }
      }
    }
    return matches;
  }

  function updateCounter(matches: readonly SearchMatch[] | null): void {
    if (matches !== null) {
      counter.textContent =
        matches.length > 1
          ? `${formatCount(matches.length)} runes trouvées`
          : `${formatCount(matches.length)} rune trouvée`;
      return;
    }
    const totalRunes = trees.reduce((sum, tree) => sum + tree.runes.length, 0);
    counter.textContent = `${formatCount(trees.length)} arbres · ${formatCount(totalRunes)} runes`;
  }

  function updatePressed(): void {
    for (const [key, button] of treeButtons) {
      button.setAttribute("aria-pressed", key === selectedKey ? "true" : "false");
    }
  }

  function renderPanel(): void {
    const matches = searchMatches(query);
    if (matches !== null) {
      replaceContent(panelHost, buildSearchResults(matches, query, options.onOpenRune));
      updateCounter(matches);
      return;
    }

    const tree = selectedTree();
    if (tree === null) {
      replaceContent(panelHost);
      updateCounter(null);
      return;
    }
    replaceContent(panelHost, buildTreePanel(tree, options.onOpenRune));
    updateCounter(null);
  }

  function selectTree(tree: RuneTree): void {
    selectedKey = tree.key;
    if (query !== "") {
      query = "";
      searchInput.value = "";
    }
    updatePressed();
    renderPanel();
    announcer.textContent = `${runeTreeDisplayName(tree)} sélectionné, ${formatCount(tree.runes.length)} runes.`;
  }

  function selectTreeByKey(treeKey: string): void {
    const tree = trees.find((candidate) => candidate.key === treeKey);
    if (tree !== undefined) {
      if (treesReady) {
        setSubtab("trees");
      }
      selectTree(tree);
    }
  }

  function setLoading(message: string): void {
    toolbar.hidden = true;
    treesHost.hidden = true;
    treesReady = false;
    activeSubtab = "trees";
    applySubtabUi();
    trees = [];
    treeButtons = new Map();
    query = "";
    searchInput.value = "";
    replaceContent(panelHost, buildLoading(message));
    announcer.textContent = message;
  }

  function setError(title: string, message: string, retryLabel: string, onRetry: () => void): void {
    toolbar.hidden = true;
    treesHost.hidden = true;
    treesReady = false;
    activeSubtab = "trees";
    applySubtabUi();
    trees = [];
    treeButtons = new Map();
    replaceContent(
      panelHost,
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

  function setRuneTrees(nextTrees: readonly RuneTree[]): void {
    const ordered = sortRuneTrees(nextTrees);
    trees = ordered;

    if (ordered.length === 0) {
      toolbar.hidden = true;
      treesHost.hidden = true;
      treesReady = false;
      activeSubtab = "trees";
      applySubtabUi();
      treeButtons = new Map();
      replaceContent(
        panelHost,
        buildPanelState({
          tone: "empty",
          title: "Aucune rune en cache",
          message:
            "Le cache local Data Dragon ne contient aucun arbre de runes. Lancez une synchronisation pour remplir cette vue.",
          actionLabel: "Synchroniser",
          onAction: options.onSync,
          iconName: "grid",
        }),
      );
      announcer.textContent = "Aucun arbre de runes dans le cache local.";
      return;
    }

    const previousSelected = selectedKey;
    selectedKey =
      previousSelected !== null && ordered.some((tree) => tree.key === previousSelected)
        ? previousSelected
        : ordered[0]?.key ?? null;

    treeButtons = new Map();
    const fragment = document.createDocumentFragment();
    for (const tree of ordered) {
      const button = buildTreeCard(tree, tree.key === selectedKey, selectTree);
      treeButtons.set(tree.key, button);
      fragment.appendChild(button);
    }
    treesHost.replaceChildren(fragment);

    toolbar.hidden = false;
    treesHost.hidden = false;
    treesReady = true;
    searchInput.value = query;
    renderPanel();
    applySubtabUi();
    builder.refreshRuneData();
    announcer.textContent = `${formatCount(ordered.length)} arbres de runes chargés.`;
  }

  // --- Événements ------------------------------------------------------
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    renderPanel();
    const matches = searchMatches(query);
    if (matches !== null) {
      announcer.textContent =
        matches.length > 1
          ? `${formatCount(matches.length)} runes trouvées.`
          : `${formatCount(matches.length)} rune trouvée.`;
    }
  });

  searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchInput.value !== "") {
      event.preventDefault();
      searchInput.value = "";
      query = "";
      renderPanel();
      const tree = selectedTree();
      if (tree !== null) {
        announcer.textContent = `${runeTreeDisplayName(tree)} sélectionné, ${formatCount(tree.runes.length)} runes.`;
      }
    }
  });

  updateCounter(null);
  applySubtabUi();

  return {
    element,
    setLoading,
    setRuneTrees,
    setError,
    selectTreeByKey,
    refreshChampionOptions: () => {
      builder.refreshChampionOptions();
    },
  };
}
