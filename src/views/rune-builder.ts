/**
 * Rune Builder (V0.7) : trois pages de runes réelles proposées par OP.GG
 * (Challenger / Grandmaster / Tous niveaux) pour un champion et un rôle.
 *
 * Les icônes/noms de runes et d'arbres sont résolus dans les arbres Data Dragon
 * déjà chargés ; à défaut, le nom fourni par OP.GG est affiché. Les fragments
 * numériques sont affichés « Fragment <id> » sans inventer de libellé.
 */

import { api } from "../api";
import type { Champion, MetaRunePage, MetaRunePages, Rune, RuneTree } from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE, errorMessage, formatCount, formatDateTime } from "../ui/format";
import { icon } from "../ui/icons";
import { formatRate } from "../ui/rates";
import { optionalString, runeDisplayName, runeTreeDisplayName } from "../ui/rune-labels";

export interface RuneBuilderOptions {
  /** Champions chargés (nom Data Dragon → valeur envoyée au backend). */
  readonly getChampions: () => readonly Champion[];
  /** Arbres de runes chargés (résolution locale des ids/noms/icônes). */
  readonly getRuneTrees: () => readonly RuneTree[];
}

export interface RuneBuilderHandle {
  readonly element: HTMLElement;
  /** Reconstruit la liste des champions après chargement/synchronisation. */
  refreshChampionOptions(): void;
  /** Re-rend les pages visibles quand les arbres de runes changent. */
  refreshRuneData(): void;
}

interface BuildRole {
  readonly value: string;
  readonly label: string;
}

const BUILD_ROLES: readonly BuildRole[] = [
  { value: "top", label: "Top" },
  { value: "mid", label: "Mid" },
  { value: "jungle", label: "Jungle" },
  { value: "adc", label: "ADC" },
  { value: "support", label: "Support" },
];

const SCOPE_LABELS: Readonly<Record<string, string>> = {
  challenger: "Challenger",
  grandmaster: "Grandmaster",
  all: "Tous niveaux",
};

const PROVIDER_LABEL = "OP.GG (MCP public)";
const PLATFORM = "EUW1";

function scopeLabel(scope: unknown): string {
  if (typeof scope !== "string" || scope.trim() === "") {
    return EMPTY_VALUE;
  }
  return SCOPE_LABELS[scope] ?? scope;
}

function roleLabel(position: unknown): string {
  if (typeof position !== "string" || position.trim() === "") {
    return EMPTY_VALUE;
  }
  const needle = position.trim().toLowerCase();
  const known = BUILD_ROLES.find((role) => role.value === needle);
  return known !== undefined ? known.label : position;
}

function statModLabel(runeId: number, name: unknown): string {
  const raw = typeof name === "string" ? name.trim() : "";
  if (raw !== "" && /^\d+$/.test(raw)) {
    return `Fragment ${raw}`;
  }
  if (raw !== "") {
    return raw;
  }
  return Number.isFinite(runeId) && runeId > 0 ? `Fragment ${runeId}` : EMPTY_VALUE;
}

function optionalCount(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? formatCount(value) : EMPTY_VALUE;
}

function placeholder(className: string): HTMLElement {
  return el("span", {
    className,
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

export function createRuneBuilder(options: RuneBuilderOptions): RuneBuilderHandle {
  // --- État -------------------------------------------------------------
  let state: "idle" | "loading" | "ready" | "error" = "idle";
  let data: MetaRunePages | null = null;
  let errorText: string | null = null;
  let requestToken = 0;

  function trees(): readonly RuneTree[] {
    return options.getRuneTrees();
  }

  function findTree(pageId: number): RuneTree | null {
    if (!Number.isFinite(pageId) || pageId <= 0) {
      return null;
    }
    return trees().find((tree) => tree.id === pageId) ?? null;
  }

  function findRune(runeId: number): Rune | null {
    if (!Number.isFinite(runeId) || runeId <= 0) {
      return null;
    }
    for (const tree of trees()) {
      const found = tree.runes.find((rune) => rune.id === runeId);
      if (found !== undefined) {
        return found;
      }
    }
    return null;
  }

  function treeName(pageId: number, fallbackName: unknown): string {
    const local = findTree(pageId);
    if (local !== null) {
      return runeTreeDisplayName(local);
    }
    return typeof fallbackName === "string" && fallbackName.trim() !== ""
      ? fallbackName
      : EMPTY_VALUE;
  }

  function runeName(runeId: number, fallbackName: unknown): string {
    const local = findRune(runeId);
    if (local !== null) {
      return runeDisplayName(local);
    }
    return typeof fallbackName === "string" && fallbackName.trim() !== ""
      ? fallbackName
      : EMPTY_VALUE;
  }

  // --- Formulaire -------------------------------------------------------
  const championSelect = el("select", {
    className: "riot-select",
    attrs: {
      "data-builder-champion": "true",
      "aria-label": "Champion pour le Rune Builder",
    },
  });
  championSelect.disabled = true;

  const roleSelect = el("select", {
    className: "riot-select",
    attrs: { "data-builder-role": "true", "aria-label": "Rôle pour le Rune Builder" },
  });
  for (const role of BUILD_ROLES) {
    roleSelect.appendChild(el("option", { text: role.label, attrs: { value: role.value } }));
  }
  roleSelect.value = "mid";

  const loadButton = el("button", {
    className: "btn btn-primary",
    attrs: { type: "button", "data-builder-load": "true" },
  });
  append(
    loadButton,
    icon("search", 15),
    el("span", { className: "btn-label", text: "Proposer 3 pages" }),
  );

  const championField = el("label", { className: "riot-field" });
  append(
    championField,
    el("span", { className: "riot-field-label", text: "Champion" }),
    championSelect,
  );
  const roleField = el("label", { className: "riot-field" });
  append(roleField, el("span", { className: "riot-field-label", text: "Rôle" }), roleSelect);

  const formGrid = el("div", { className: "builder-form-grid" });
  append(formGrid, championField, roleField);

  const formActions = el("div", { className: "builder-form-actions" });
  formActions.appendChild(loadButton);

  const form = el("div", { className: "builder-form" });
  append(
    form,
    el("p", {
      className: "builder-hint",
      text: "Champion + rôle → trois pages de runes réelles OP.GG (Challenger / Grandmaster / Tous niveaux).",
    }),
    formGrid,
    formActions,
  );

  // --- Bandeau source ---------------------------------------------------
  const sourceName = el("span", {
    className: "builder-source",
    text: PROVIDER_LABEL,
    attrs: { "data-builder-source-label": "true" },
  });
  const cacheBadge = el("span", { className: "builder-cache", text: EMPTY_VALUE });
  const fetchedAt = el("span", {
    className: "builder-fetched-at",
    text: EMPTY_VALUE,
    attrs: { "data-builder-fetched-at": "true" },
  });
  const warning = el("p", { className: "builder-warning" });
  warning.hidden = true;
  const sourceLine = el("div", { className: "builder-source-line" });
  append(
    sourceLine,
    el("span", { className: "builder-source-label", text: "Source :" }),
    sourceName,
    el("span", { className: "builder-source-sep", text: "·" }),
    cacheBadge,
    el("span", { className: "builder-source-sep", text: "·" }),
    el("span", { className: "builder-source-label", text: "Récupéré :" }),
    fetchedAt,
  );
  const sourceBar = el("div", { className: "builder-source-bar" });
  append(sourceBar, sourceLine, warning);
  sourceBar.hidden = true;

  const contentHost = el("div", { className: "builder-content" });
  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "rune-builder",
    attrs: { "data-rune-builder": "true", "aria-label": "Rune Builder OP.GG" },
  });
  append(element, form, sourceBar, contentHost, announcer);
  element.hidden = true;

  // --- Icônes -----------------------------------------------------------
  function buildTreeIcon(tree: RuneTree | null, pageName: string): HTMLElement {
    const wrapper = el("span", { className: "builder-tree-icon-wrap" });
    const iconPath = tree === null ? null : optionalString(tree.iconPath);
    if (iconPath !== null) {
      const image = el("img", {
        className: "builder-tree-icon",
        attrs: {
          alt: tree === null ? pageName : `Icône de l'arbre ${treeName(tree.id, pageName)}`,
          loading: "lazy",
          decoding: "async",
          draggable: "false",
          width: "32",
          height: "32",
        },
      });
      image.src = api.assetUrl(iconPath);
      image.addEventListener("error", () => {
        image.replaceWith(placeholder("builder-tree-icon builder-tree-icon--placeholder"));
      });
      wrapper.appendChild(image);
    } else {
      wrapper.appendChild(placeholder("builder-tree-icon builder-tree-icon--placeholder"));
    }
    return wrapper;
  }

  function buildRuneCell(
    runeId: number,
    fallbackName: unknown,
    keystone: boolean,
  ): HTMLElement {
    const local = findRune(runeId);
    const name = runeName(runeId, fallbackName);
    const cell = el("div", {
      className: keystone ? "builder-rune builder-rune--keystone" : "builder-rune",
      attrs: {
        "data-builder-rune": "true",
        "data-rune-id": String(runeId),
      },
    });

    const wrapper = el("span", { className: "builder-rune-icon-wrap" });
    const iconPath = local === null ? null : optionalString(local.iconPath);
    if (iconPath !== null) {
      const image = el("img", {
        className: "builder-rune-icon",
        attrs: {
          alt: name,
          loading: "lazy",
          decoding: "async",
          draggable: "false",
          width: "40",
          height: "40",
        },
      });
      image.src = api.assetUrl(iconPath);
      image.addEventListener("error", () => {
        image.replaceWith(placeholder("builder-rune-icon builder-rune-icon--placeholder"));
      });
      wrapper.appendChild(image);
    } else {
      wrapper.appendChild(placeholder("builder-rune-icon builder-rune-icon--placeholder"));
    }

    cell.appendChild(wrapper);
    const body = el("span", { className: "builder-rune-body" });
    append(
      body,
      el("span", { className: "builder-rune-name", text: name }),
      keystone
        ? el("span", { className: "builder-rune-badge", text: "Majeure" })
        : el("span", { className: "builder-rune-badge builder-rune-badge--minor", text: "Mineure" }),
    );
    cell.appendChild(body);
    return cell;
  }

  function buildRuneTreeBlock(
    page: MetaRunePage,
    kind: "primary" | "secondary",
  ): HTMLElement {
    const isPrimary = kind === "primary";
    const pageId = isPrimary ? page.primaryPageId : page.secondaryPageId;
    const fallbackName = isPrimary ? page.primaryPageName : page.secondaryPageName;
    const ids = isPrimary ? page.primaryRuneIds : page.secondaryRuneIds;
    const names = isPrimary ? page.primaryRuneNames : page.secondaryRuneNames;
    const tree = findTree(pageId);
    const name = treeName(pageId, fallbackName);

    const block = el("div", {
      className: isPrimary ? "builder-tree builder-tree--primary" : "builder-tree builder-tree--secondary",
      attrs: {
        [isPrimary ? "data-builder-primary-tree" : "data-builder-secondary-tree"]: "true",
      },
    });

    const head = el("div", { className: "builder-tree-head" });
    append(
      head,
      buildTreeIcon(tree, name),
      el("span", { className: "builder-tree-name", text: name }),
      el("span", {
        className: "builder-tree-role",
        text: isPrimary ? "Arbre principal" : "Arbre secondaire",
      }),
    );
    block.appendChild(head);

    const grid = el("div", { className: "builder-rune-grid" });
    const idList = Array.isArray(ids) ? ids : [];
    const nameList = Array.isArray(names) ? names : [];
    const total = Math.max(idList.length, nameList.length);
    if (total === 0) {
      grid.appendChild(el("span", { className: "builder-rune-name", text: EMPTY_VALUE }));
    } else {
      for (let index = 0; index < total; index += 1) {
        const rawId = idList[index];
        const rawName = nameList[index];
        grid.appendChild(
          buildRuneCell(
            typeof rawId === "number" ? rawId : 0,
            rawName,
            isPrimary && index === 0,
          ),
        );
      }
    }
    block.appendChild(grid);
    return block;
  }

  function buildStatMods(page: MetaRunePage): HTMLElement {
    const container = el("div", { className: "builder-stat-mods" });
    const ids = Array.isArray(page.statModIds) ? page.statModIds : [];
    const names = Array.isArray(page.statModNames) ? page.statModNames : [];
    const total = Math.max(ids.length, names.length);
    if (total === 0) {
      container.appendChild(
        el("span", { className: "builder-stat-mod", text: EMPTY_VALUE }),
      );
      return container;
    }
    for (let index = 0; index < total; index += 1) {
      const rawId = ids[index];
      const runeId = typeof rawId === "number" ? rawId : 0;
      const label = statModLabel(runeId, names[index]);
      const mod = el("div", {
        className: "builder-stat-mod",
        attrs: { "data-builder-stat-mod": "true" },
      });
      append(
        mod,
        el("span", { className: "builder-stat-mod-index", text: String(index + 1) }),
        el("span", { className: "builder-stat-mod-label", text: label }),
      );
      container.appendChild(mod);
    }
    return container;
  }

  function buildPageCard(page: MetaRunePage): HTMLElement {
    const card = el("article", {
      className: "builder-page",
      attrs: {
        "data-builder-page": "true",
        "data-page-scope": typeof page.scope === "string" ? page.scope : "",
      },
    });

    const head = el("header", { className: "builder-page-head" });
    append(
      head,
      el("span", { className: "builder-page-scope", text: scopeLabel(page.scope) }),
      el("span", {
        className: "builder-page-games",
        text: `${optionalCount(page.play)} parties`,
      }),
    );
    card.appendChild(head);

    const stats = el("div", { className: "builder-page-stats" });
    const winRate = el("div", { className: "builder-page-stat" });
    append(
      winRate,
      el("span", { className: "builder-page-stat-label", text: "Win rate" }),
      el("span", { className: "builder-page-winrate", text: formatRate(page.winRate) }),
    );
    const pickRate = el("div", { className: "builder-page-stat" });
    append(
      pickRate,
      el("span", { className: "builder-page-stat-label", text: "Pick rate" }),
      el("span", { className: "builder-page-pickrate", text: formatRate(page.pickRate) }),
    );
    const wins = el("div", { className: "builder-page-stat" });
    append(
      wins,
      el("span", { className: "builder-page-stat-label", text: "Victoires" }),
      el("span", {
        className: "builder-page-wins",
        text: optionalCount(page.win),
      }),
    );
    append(stats, winRate, pickRate, wins);
    card.appendChild(stats);

    card.appendChild(buildRuneTreeBlock(page, "primary"));
    card.appendChild(buildRuneTreeBlock(page, "secondary"));

    const modsBlock = el("div", { className: "builder-mods" });
    append(
      modsBlock,
      el("span", { className: "builder-mods-label", text: "Fragments" }),
      buildStatMods(page),
    );
    card.appendChild(modsBlock);
    return card;
  }

  function buildPages(pages: readonly MetaRunePage[]): HTMLElement {
    const container = el("div", {
      className: "builder-pages",
      attrs: { "data-builder-pages": "true" },
    });
    for (const page of pages) {
      container.appendChild(buildPageCard(page));
    }
    return container;
  }

  function buildError(): HTMLElement {
    const box = el("div", {
      className: "builder-error",
      attrs: { "data-builder-error": "true" },
    });
    append(
      box,
      el("p", { className: "builder-error-title", text: "Pages de runes indisponibles" }),
      el("p", {
        className: "builder-error-message",
        text: errorText ?? "Erreur inconnue.",
      }),
    );
    const retry = el("button", {
      className: "btn btn-ghost",
      attrs: { type: "button", "data-builder-retry": "true" },
    });
    append(retry, icon("sync", 15), el("span", { className: "btn-label", text: "Réessayer" }));
    retry.addEventListener("click", () => {
      void loadPages();
    });
    box.appendChild(retry);
    return box;
  }

  function buildLoading(): HTMLElement {
    const container = el("div", { className: "state state--loading builder-loading" });
    const line = el("div", { className: "loading-line" });
    append(
      line,
      el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "loading-text", text: "Chargement des pages de runes OP.GG…" }),
    );
    container.appendChild(line);
    return container;
  }

  function updateSourceBar(): void {
    if (data === null || state !== "ready") {
      sourceBar.hidden = true;
      return;
    }
    sourceBar.hidden = false;
    cacheBadge.textContent = data.fromCache ? "Données en cache" : "Données réseau";
    cacheBadge.setAttribute("data-cache", data.fromCache ? "true" : "false");
    fetchedAt.textContent = formatDateTime(
      typeof data.fetchedAt === "string" ? data.fetchedAt : null,
    );
    sourceName.title = data.source === "" ? PROVIDER_LABEL : data.source;
    const warningText =
      typeof data.warning === "string" && data.warning.trim() !== "" ? data.warning : null;
    warning.hidden = warningText === null;
    warning.textContent = warningText ?? "";
  }

  function render(): void {
    const loading = state === "loading";
    // Mettre à jour les sélecteurs AVANT le bouton : sinon, au render « ready »,
    // le bouton lirait l'ancien `championSelect.disabled = true` du chargement.
    championSelect.disabled = loading || options.getChampions().length === 0;
    roleSelect.disabled = loading;
    loadButton.disabled = loading || championSelect.disabled;
    updateSourceBar();

    switch (state) {
      case "loading":
        replaceContent(contentHost, buildLoading());
        break;
      case "error":
        replaceContent(contentHost, buildError());
        break;
      case "ready": {
        if (data === null) {
          replaceContent(contentHost, buildError());
          break;
        }
        const pages = Array.isArray(data.pages) ? data.pages : [];
        if (pages.length === 0) {
          replaceContent(contentHost, buildError());
          break;
        }
        const wrapper = el("div", { className: "builder-result" });
        const head = el("div", { className: "builder-result-head" });
        append(
          head,
          el("span", {
            className: "builder-result-title",
            text: `${data.champion} · ${roleLabel(data.position)}`,
          }),
          el("span", {
            className: "builder-result-count",
            text: `${formatCount(pages.length)} pages OP.GG`,
          }),
        );
        append(wrapper, head, buildPages(pages));
        replaceContent(contentHost, wrapper);
        break;
      }
      case "idle":
        replaceContent(
          contentHost,
          el("p", {
            className: "builder-empty",
            text: "Choisissez un champion et un rôle puis cliquez sur « Proposer 3 pages ».",
          }),
        );
        break;
    }
  }

  async function loadPages(): Promise<void> {
    if (state === "loading") {
      return;
    }
    const champion = championSelect.value;
    const position = roleSelect.value;
    if (champion === "") {
      state = "error";
      errorText = "Sélectionnez un champion pour proposer des pages de runes.";
      render();
      announcer.textContent = errorText;
      return;
    }

    const token = requestToken + 1;
    requestToken = token;
    state = "loading";
    errorText = null;
    render();
    announcer.textContent = "Chargement des pages de runes OP.GG…";

    try {
      const loaded = await api.getMetaRunePages(champion, position, PLATFORM);
      if (requestToken !== token) {
        return;
      }
      data = loaded;
      const pages = Array.isArray(loaded.pages) ? loaded.pages : [];
      if (pages.length === 0) {
        state = "error";
        errorText =
          "OP.GG n'a renvoyé aucune page de runes pour ce champion et ce rôle.";
        render();
        announcer.textContent = errorText;
        return;
      }
      state = "ready";
      render();
      announcer.textContent = `${formatCount(pages.length)} pages de runes OP.GG proposées pour ${loaded.champion}.`;
    } catch (error) {
      if (requestToken !== token) {
        return;
      }
      data = null;
      state = "error";
      errorText = errorMessage(error);
      render();
      announcer.textContent = `Pages de runes indisponibles. ${errorText}`;
    }
  }

  function refreshChampionOptions(): void {
    const champions = options.getChampions();
    if (champions.length === 0) {
      replaceContent(
        championSelect,
        el("option", { text: "Champions non chargés", attrs: { value: "" } }),
      );
      championSelect.disabled = true;
      loadButton.disabled = true;
      return;
    }
    championSelect.disabled = state === "loading";
    const previous = championSelect.value;
    replaceContent(
      championSelect,
      ...champions.map((champion) =>
        el("option", { text: champion.name, attrs: { value: champion.name } }),
      ),
    );
    const target =
      champions.find((champion) => champion.name === previous) ??
      champions.find((champion) => champion.name === "Ahri") ??
      champions[0];
    if (target !== undefined) {
      championSelect.value = target.name;
    }
    loadButton.disabled = state === "loading";
  }

  loadButton.addEventListener("click", () => {
    void loadPages();
  });

  refreshChampionOptions();
  render();

  return {
    element,
    refreshChampionOptions,
    refreshRuneData: () => {
      if (state === "ready") {
        render();
      }
    },
  };
}
