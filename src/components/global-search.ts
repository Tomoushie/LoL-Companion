/**
 * Barre de recherche globale persistante (champions, objets, runes).
 *
 * Le composant ne connaît aucune donnée : l'appelant fournit `onSearch`, qui
 * renvoie les résultats réels déjà chargés. Navigation clavier (flèches,
 * Début/Fin, Entrée), fermeture par Échap (gérée par le contrôleur) ou bouton.
 * Aucune donnée n'est inventée.
 */

import { api } from "../api";
import { append, el, replaceContent } from "../ui/dom";
import { formatCount } from "../ui/format";
import { icon } from "../ui/icons";

export type GlobalResultType = "champion" | "item" | "rune";

export interface GlobalSearchResult {
  readonly type: GlobalResultType;
  readonly id: string;
  readonly name: string;
  readonly secondary: string | null;
  readonly iconPath: string | null;
}

export interface GlobalSearchCallbacks {
  /** Recherche réelle sur les données chargées, pour la requête saisie. */
  readonly onSearch: (query: string) => readonly GlobalSearchResult[];
  /** Sélection d'un résultat (clic ou Entrée). */
  readonly onSelect: (result: GlobalSearchResult, trigger: HTMLElement) => void;
}

export interface GlobalSearchHandle {
  readonly element: HTMLElement;
  isOpen(): boolean;
  /** Ferme le panneau et vide la requête. */
  close(): void;
}

/**
 * Limite d'affichage par type (30 résultats visibles au total maximum) :
 * une requête large doit laisser apparaître les trois catégories.
 */
const MAX_RESULTS_PER_TYPE = 10;

const TYPE_LABELS: Readonly<Record<GlobalResultType, string>> = {
  champion: "Champion",
  item: "Objet",
  rune: "Rune",
};

const TYPE_GROUPS: readonly { readonly type: GlobalResultType; readonly label: string }[] = [
  { type: "champion", label: "Champions" },
  { type: "item", label: "Objets" },
  { type: "rune", label: "Runes" },
];

function resultCountLabel(total: number): string {
  return total > 1 ? `${formatCount(total)} résultats` : `${formatCount(total)} résultat`;
}

export function createGlobalSearch(callbacks: GlobalSearchCallbacks): GlobalSearchHandle {
  const input = el("input", {
    className: "global-search-input",
    attrs: {
      type: "search",
      "data-global-search": "true",
      placeholder: "Rechercher champions, objets, runes…",
      "aria-label": "Recherche globale (champions, objets, runes)",
      role: "combobox",
      "aria-expanded": "false",
      "aria-controls": "global-search-results",
      "aria-autocomplete": "list",
      autocomplete: "off",
      spellcheck: "false",
    },
  });

  const field = el("label", { className: "global-search-field" });
  append(field, icon("search", 16), input);

  const counter = el("span", {
    className: "champ-count global-search-count",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const closeButton = el("button", {
    className: "btn btn-ghost global-search-close",
    text: "Fermer",
    attrs: { type: "button", "aria-label": "Fermer la recherche" },
  });
  closeButton.hidden = true;
  closeButton.addEventListener("click", () => {
    close();
    input.focus();
  });

  const panel = el("div", {
    className: "global-search-panel",
    attrs: {
      id: "global-search-results",
      "data-search-results": "true",
      role: "listbox",
      "aria-label": "Résultats de la recherche globale",
    },
  });
  panel.hidden = true;

  const element = el("div", { className: "command-bar" });
  append(element, field, counter, closeButton, panel);

  let resultButtons: HTMLButtonElement[] = [];
  let results: readonly GlobalSearchResult[] = [];
  let activeIndex = -1;

  function setExpanded(expanded: boolean): void {
    input.setAttribute("aria-expanded", expanded ? "true" : "false");
    if (!expanded) {
      input.removeAttribute("aria-activedescendant");
    }
  }

  function openPanel(): void {
    panel.hidden = false;
    closeButton.hidden = false;
    setExpanded(true);
  }

  function setActive(index: number): void {
    if (resultButtons.length === 0) {
      activeIndex = -1;
      input.removeAttribute("aria-activedescendant");
      return;
    }
    const bounded = index < 0 ? resultButtons.length - 1 : index >= resultButtons.length ? 0 : index;
    activeIndex = bounded;
    resultButtons.forEach((button, buttonIndex) => {
      const active = buttonIndex === bounded;
      button.classList.toggle("search-result--active", active);
      button.setAttribute("aria-selected", active ? "true" : "false");
    });
    const activeButton = resultButtons[bounded];
    if (activeButton !== undefined) {
      input.setAttribute("aria-activedescendant", activeButton.id);
      activeButton.scrollIntoView({ block: "nearest" });
    }
  }

  function buildResultButton(
    result: GlobalSearchResult,
    index: number,
  ): HTMLButtonElement {
    const button = el("button", {
      className: "search-result",
      attrs: {
        type: "button",
        id: `global-search-result-${index}`,
        role: "option",
        "aria-selected": "false",
        "data-search-result": "true",
        "data-result-type": result.type,
        "data-result-id": result.id,
        "aria-label": `${TYPE_LABELS[result.type]} : ${result.name}`,
      },
    });

    const iconWrap = el("span", { className: "search-result-icon-wrap" });
    const iconPath =
      typeof result.iconPath === "string" && result.iconPath.trim() !== ""
        ? result.iconPath
        : null;
    if (iconPath !== null) {
      const image = el("img", {
        className: "search-result-icon",
        attrs: {
          alt: result.name,
          loading: "lazy",
          decoding: "async",
          draggable: "false",
          width: "32",
          height: "32",
        },
      });
      image.src = api.assetUrl(iconPath);
      image.addEventListener("error", () => {
        image.replaceWith(
          el("span", {
            className: "search-result-icon search-result-icon--placeholder",
            text: "—",
            attrs: { "aria-hidden": "true" },
          }),
        );
      });
      iconWrap.appendChild(image);
    } else {
      iconWrap.appendChild(
        el("span", {
          className: "search-result-icon search-result-icon--placeholder",
          text: "—",
          attrs: { "aria-hidden": "true" },
        }),
      );
    }

    const body = el("span", { className: "search-result-body" });
    body.appendChild(el("span", { className: "search-result-name", text: result.name }));
    if (result.secondary !== null && result.secondary.trim() !== "") {
      body.appendChild(
        el("span", { className: "search-result-secondary", text: result.secondary }),
      );
    }

    const typeBadge = el("span", {
      className: "search-result-type",
      text: TYPE_LABELS[result.type],
    });

    append(button, iconWrap, body, typeBadge);
    button.addEventListener("click", () => {
      callbacks.onSelect(result, button);
    });
    return button;
  }

  function renderResults(rawQuery: string): void {
    const trimmed = rawQuery.trim();
    if (trimmed === "") {
      close();
      return;
    }

    results = callbacks.onSearch(trimmed);
    counter.textContent = resultCountLabel(results.length);
    replaceContent(panel);
    resultButtons = [];
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");

    if (results.length === 0) {
      panel.appendChild(
        el("p", { className: "global-search-empty", text: `Aucun résultat pour « ${trimmed} ».` }),
      );
      openPanel();
      return;
    }

    let shown = 0;
    for (const group of TYPE_GROUPS) {
      const groupResults = results.filter((result) => result.type === group.type);
      if (groupResults.length === 0) {
        continue;
      }

      const groupElement = el("div", {
        className: "global-search-group",
        attrs: { role: "group", "aria-label": `${group.label} (${formatCount(groupResults.length)})` },
      });
      groupElement.appendChild(
        el("p", {
          className: "global-search-group-title",
          text: `${group.label} · ${formatCount(groupResults.length)}`,
        }),
      );

      const list = el("div", { className: "global-search-group-list" });
      for (const result of groupResults.slice(0, MAX_RESULTS_PER_TYPE)) {
        list.appendChild(buildResultButton(result, shown));
        shown += 1;
      }
      groupElement.appendChild(list);
      panel.appendChild(groupElement);
    }

    if (results.length > shown) {
      panel.appendChild(
        el("p", {
          className: "global-search-more",
          text: `${formatCount(results.length)} résultats au total — affichage des ${formatCount(shown)} premiers, précisez la recherche.`,
        }),
      );
    }

    resultButtons = [...panel.querySelectorAll<HTMLButtonElement>("[data-search-result]")];
    openPanel();
  }

  function close(): void {
    input.value = "";
    replaceContent(panel);
    panel.hidden = true;
    closeButton.hidden = true;
    counter.textContent = "";
    resultButtons = [];
    results = [];
    activeIndex = -1;
    input.removeAttribute("aria-activedescendant");
    setExpanded(false);
  }

  function pickResult(index: number): void {
    const button = resultButtons[index];
    const result = results[index];
    if (button !== undefined && result !== undefined) {
      callbacks.onSelect(result, button);
    }
  }

  input.addEventListener("input", () => {
    renderResults(input.value);
  });

  input.addEventListener("keydown", (event) => {
    if (panel.hidden) {
      return;
    }
    const key = event.key;
    if (key === "ArrowDown") {
      event.preventDefault();
      setActive(activeIndex + 1);
    } else if (key === "ArrowUp") {
      event.preventDefault();
      setActive(activeIndex - 1);
    } else if (key === "Home") {
      event.preventDefault();
      setActive(0);
    } else if (key === "End") {
      event.preventDefault();
      setActive(resultButtons.length - 1);
    } else if (key === "Enter") {
      if (resultButtons.length > 0) {
        event.preventDefault();
        pickResult(activeIndex >= 0 ? activeIndex : 0);
      }
    }
  });

  // Fermeture au clic hors de la barre (Échap est géré par le contrôleur).
  document.addEventListener("pointerdown", (event) => {
    if (panel.hidden) {
      return;
    }
    const target = event.target;
    if (target instanceof Node && element.contains(target)) {
      return;
    }
    close();
  });

  return { element, isOpen: () => !panel.hidden, close };
}
