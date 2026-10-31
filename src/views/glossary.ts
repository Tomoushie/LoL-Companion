/**
 * Vue « Glossaire » (V0.8).
 *
 * Dictionnaire éditorial local : définitions rédigées, recherche FR/EN,
 * filtres par catégorie et liens entre termes. Aucune requête réseau, aucune
 * statistique inventée : le glossaire explique le vocabulaire, il ne remplace
 * pas les données Data Dragon / Riot / OP.GG.
 */

import { GLOSSARY, GLOSSARY_CATEGORIES, type GlossaryEntry } from "../data/glossary";
import { append, el, replaceContent } from "../ui/dom";
import { normalizeForSearch } from "../ui/format";
import { icon } from "../ui/icons";
import { panelId, tabId } from "../ui/view";

const ALL_CATEGORY = "all";

const CATEGORY_LABELS = new Map(
  GLOSSARY_CATEGORIES.map((category) => [category.id, category.label]),
);

const SORTED_ENTRIES = [...GLOSSARY].sort((left, right) =>
  left.term.localeCompare(right.term, "fr", { sensitivity: "base" }),
);

const ENTRY_BY_ID = new Map(SORTED_ENTRIES.map((entry) => [entry.id, entry]));

/** Texte indexé pour la recherche : terme, alias et définition. */
function searchableText(entry: GlossaryEntry): string {
  return normalizeForSearch([entry.term, ...entry.aliases, entry.definition].join(" "));
}

const SEARCH_INDEX = new Map(
  SORTED_ENTRIES.map((entry) => [entry.id, searchableText(entry)]),
);

export interface GlossaryViewHandle {
  readonly element: HTMLElement;
}

export function createGlossaryView(): GlossaryViewHandle {
  const heading = el("div", { className: "view-heading" });
  append(
    heading,
    el("h1", { className: "view-title", text: "Glossaire" }),
    el("p", {
      className: "view-sub",
      text: "Le vocabulaire de League of Legends — définitions éditoriales locales, recherche FR/EN.",
    }),
  );

  const total = el("span", {
    className: "glossary-total",
    attrs: { "data-glossary-count": "true" },
  });

  const head = el("header", { className: "view-head" });
  append(head, heading, total);

  // --- Recherche -------------------------------------------------------
  const searchInput = el("input", {
    className: "search-input glossary-search-input",
    attrs: {
      type: "search",
      placeholder: "Rechercher un terme, un alias…",
      "aria-label": "Rechercher dans le glossaire",
      "data-glossary-search": "true",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const searchWrap = el("div", { className: "search-field glossary-search" });
  append(searchWrap, icon("search", 16), searchInput);

  // --- Catégories ------------------------------------------------------
  const categoryBar = el("div", {
    className: "glossary-categories",
    attrs: { role: "tablist", "aria-label": "Catégories du glossaire" },
  });
  const categoryButtons = new Map<string, HTMLButtonElement>();

  const addCategoryButton = (id: string, label: string): void => {
    const button = el("button", {
      className: "glossary-category-chip",
      text: label,
      attrs: {
        type: "button",
        role: "tab",
        "data-glossary-category": id,
        "aria-selected": id === ALL_CATEGORY ? "true" : "false",
        "aria-controls": "glossary-list",
      },
    });
    button.addEventListener("click", () => {
      setCategory(id);
    });
    categoryButtons.set(id, button);
    categoryBar.appendChild(button);
  };
  addCategoryButton(ALL_CATEGORY, "Tous");
  for (const category of GLOSSARY_CATEGORIES) {
    addCategoryButton(category.id, category.label);
  }

  const toolbar = el("div", { className: "glossary-toolbar" });
  append(toolbar, searchWrap, categoryBar);

  const hint = el("p", {
    className: "glossary-hint",
    text: "Définitions éditoriales de l'application (pas des données Riot) : les statistiques réelles restent dans les vues Champions, Objets, Runes, Profil et Méta.",
  });

  const list = el("div", {
    className: "glossary-list",
    attrs: { id: "glossary-list" },
  });

  const empty = el("div", {
    className: "state state--empty glossary-empty",
    attrs: { "data-glossary-empty": "true" },
  });
  empty.hidden = true;
  append(
    empty,
    el("p", { className: "state-title", text: "Aucun terme ne correspond" }),
    el("p", {
      className: "state-text",
      text: "Essayez un autre mot-clé ou revenez à la catégorie « Tous ».",
    }),
  );

  let category: string = ALL_CATEGORY;

  function setCategory(next: string): void {
    category = next;
    for (const [id, button] of categoryButtons) {
      button.setAttribute("aria-selected", id === next ? "true" : "false");
    }
    render();
  }

  function matchesCategory(entry: GlossaryEntry): boolean {
    return category === ALL_CATEGORY || entry.category === category;
  }

  function matchesQuery(entry: GlossaryEntry, query: string): boolean {
    if (query === "") {
      return true;
    }
    const index = SEARCH_INDEX.get(entry.id) ?? "";
    return index.includes(query);
  }

  function visibleEntries(): readonly GlossaryEntry[] {
    const query = normalizeForSearch(searchInput.value.trim());
    return SORTED_ENTRIES.filter(
      (entry) => matchesCategory(entry) && matchesQuery(entry, query),
    );
  }

  /** Ouvre un terme lié, même s'il est masqué par les filtres. */
  function focusTerm(termId: string): void {
    const target = ENTRY_BY_ID.get(termId);
    if (target === undefined) {
      return;
    }
    searchInput.value = "";
    category = ALL_CATEGORY;
    for (const [id, button] of categoryButtons) {
      button.setAttribute("aria-selected", id === ALL_CATEGORY ? "true" : "false");
    }
    render();
    const node = list.querySelector<HTMLElement>(
      `[data-glossary-entry][data-term-id="${cssEscape(termId)}"]`,
    );
    if (node === null) {
      return;
    }
    node.scrollIntoView({ block: "center" });
    node.classList.add("glossary-entry--highlight");
    window.setTimeout(() => {
      node.classList.remove("glossary-entry--highlight");
    }, 1600);
  }

  function buildEntry(entry: GlossaryEntry): HTMLElement {
    const article = el("article", {
      className: "glossary-entry",
      attrs: {
        "data-glossary-entry": "true",
        "data-term-id": entry.id,
        "data-category": entry.category,
      },
    });

    const entryHead = el("div", { className: "glossary-entry-head" });
    append(
      entryHead,
      el("h2", { className: "glossary-term", text: entry.term }),
      el("span", {
        className: "glossary-category",
        text: CATEGORY_LABELS.get(entry.category) ?? entry.category,
      }),
    );

    append(
      article,
      entryHead,
      el("p", { className: "glossary-definition", text: entry.definition }),
    );

    if (entry.example !== undefined && entry.example.trim() !== "") {
      const example = el("p", { className: "glossary-example" });
      append(
        example,
        el("span", { className: "glossary-example-label", text: "Exemple" }),
        document.createTextNode(` ${entry.example}`),
      );
      article.appendChild(example);
    }

    if (entry.aliases.length > 0) {
      article.appendChild(
        el("p", {
          className: "glossary-aliases",
          text: `Aussi appelé : ${entry.aliases.join(" · ")}`,
        }),
      );
    }

    const related = (entry.related ?? []).filter((id) => ENTRY_BY_ID.has(id));
    if (related.length > 0) {
      const relatedWrap = el("div", { className: "glossary-related" });
      append(relatedWrap, el("span", { className: "glossary-related-label", text: "Voir aussi" }));
      for (const relatedId of related) {
        const linked = ENTRY_BY_ID.get(relatedId);
        if (linked === undefined) {
          continue;
        }
        const button = el("button", {
          className: "glossary-related-link",
          text: linked.term,
          attrs: { type: "button", "data-glossary-related": relatedId },
        });
        button.addEventListener("click", () => {
          focusTerm(relatedId);
        });
        relatedWrap.appendChild(button);
      }
      article.appendChild(relatedWrap);
    }

    return article;
  }

  function render(): void {
    const entries = visibleEntries();
    total.textContent = `${entries.length} terme${entries.length > 1 ? "s" : ""}`;
    total.setAttribute("data-count", String(entries.length));
    empty.hidden = entries.length > 0;
    if (entries.length === 0) {
      replaceContent(list);
      return;
    }
    replaceContent(list, ...entries.map(buildEntry));
  }

  searchInput.addEventListener("input", render);

  const element = el("section", {
    className: "view view--glossary",
    attrs: {
      role: "tabpanel",
      id: panelId("glossary"),
      "aria-labelledby": tabId("glossary"),
    },
  });
  append(element, head, toolbar, hint, list, empty);
  element.hidden = true;

  render();

  return { element };
}

/** Échappe une valeur pour un sélecteur d'attribut simple. */
function cssEscape(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\]/g, "\\$&");
}
