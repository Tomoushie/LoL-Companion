/**
 * Vue « Méta » (V0.6) : tier list et builds OP.GG via le backend Rust.
 *
 * Les données affichées sont fournies par OP.GG (MCP public) à travers les
 * commandes Tauri ; aucune valeur n'est inventée. Les icônes de champions et
 * d'objets proviennent du cache Data Dragon local.
 */

import { api } from "../api";
import { buildPanelState } from "../components/states";
import type {
  Champion,
  MetaBuild,
  MetaItemBuild,
  MetaTierEntry,
  MetaTierList,
  RiotPlatformInfo,
} from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE, errorMessage, formatCount, formatDateTime, formatDecimal } from "../ui/format";
import { icon } from "../ui/icons";
import { formatRate } from "../ui/rates";
import { riotPositionLabel } from "../ui/riot-labels";
import { panelId, tabId } from "../ui/view";

export interface MetaViewOptions {
  /** Champions réellement chargés (pour le sélecteur des builds). */
  readonly getChampions: () => readonly Champion[];
  /** Icône locale d'un champion par clé numérique Data Dragon. */
  readonly getChampionIconPathByKey: (championKey: number) => string | null;
  /** Nom local d'un champion par clé numérique Data Dragon. */
  readonly getChampionNameByKey: (championKey: number) => string | null;
  /** Icône locale d'un objet par identifiant Data Dragon. */
  readonly getItemIconPathById: (itemId: number) => string | null;
  /** Nom local d'un objet par identifiant Data Dragon. */
  readonly getItemNameById: (itemId: number) => string | null;
}

export interface MetaViewHandle {
  readonly element: HTMLElement;
  /** Appelé quand l'onglet Méta devient actif : charge la tier list au besoin. */
  onShown(): void;
  /** Reconstruit la liste des champions (après chargement Data Dragon). */
  refreshChampionOptions(): void;
}

type MetaSubtab = "tier" | "builds";
type TierState = "idle" | "loading" | "ready" | "error";
type BuildState = "idle" | "loading" | "ready" | "error";
type RoleFilter = "all" | "top" | "mid" | "jungle" | "adc" | "support";

const ROLE_FILTERS: readonly { readonly value: RoleFilter; readonly label: string }[] = [
  { value: "all", label: "Tous" },
  { value: "top", label: "Top" },
  { value: "mid", label: "Mid" },
  { value: "jungle", label: "Jungle" },
  { value: "adc", label: "ADC" },
  { value: "support", label: "Support" },
];

const BUILD_ROLES: readonly { readonly value: RoleFilter; readonly label: string }[] = [
  { value: "top", label: "Top" },
  { value: "mid", label: "Mid" },
  { value: "jungle", label: "Jungle" },
  { value: "adc", label: "ADC" },
  { value: "support", label: "Support" },
];

const BUILD_TIERS: readonly { readonly value: string; readonly label: string }[] = [
  { value: "challenger", label: "Challenger" },
  { value: "all", label: "Tous" },
];

/** Libellés FR de la sémantique de tiers OP.GG (1 = meilleur, 5 = plus faible). */
const TIER_LABELS: Readonly<Record<number, string>> = {
  1: "OP",
  2: "Fort",
  3: "Bon",
  4: "Correct",
  5: "Faible",
};

interface BuildSection {
  readonly key: "starter" | "boots" | "core" | "fourth" | "fifth" | "sixth";
  readonly hook: string;
  readonly label: string;
}

const BUILD_SECTIONS: readonly BuildSection[] = [
  { key: "starter", hook: "starter", label: "Objets de départ" },
  { key: "boots", hook: "boots", label: "Bottes" },
  { key: "core", hook: "core", label: "Cœur de build" },
  { key: "fourth", hook: "fourth", label: "4e objet" },
  { key: "fifth", hook: "fifth", label: "5e objet" },
  { key: "sixth", hook: "sixth", label: "6e objet" },
];

/** Taux considéré comme un échantillon faible (information d'affichage). */
const LOW_SAMPLE_GAMES = 50;

function normalizePosition(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const key = value.trim().toLowerCase();
  if (key === "bottom" || key === "bot") {
    return "adc";
  }
  if (key === "middle") {
    return "mid";
  }
  if (key === "utility") {
    return "support";
  }
  return key;
}

function roleLabel(value: string): string {
  for (const role of BUILD_ROLES) {
    if (role.value === value) {
      return role.label;
    }
  }
  return riotPositionLabel(value);
}

function tierLabel(tier: unknown): string {
  if (typeof tier !== "number" || !Number.isFinite(tier)) {
    return EMPTY_VALUE;
  }
  return TIER_LABELS[tier] ?? `Tier ${tier}`;
}

function formatOptionalNumber(value: unknown, suffix = ""): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return EMPTY_VALUE;
  }
  return `${formatDecimal(value)}${suffix}`;
}

function formatOptionalCount(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return EMPTY_VALUE;
  }
  return formatCount(value);
}

function buildPlaceholder(className: string): HTMLElement {
  return el("span", {
    className,
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

export function createMetaView(options: MetaViewOptions): MetaViewHandle {
  // --- État -------------------------------------------------------------
  let subtab: MetaSubtab = "tier";

  let platforms: RiotPlatformInfo[] = [];
  let platformsBusy = true;
  let platformsError: string | null = null;
  let selectedPlatform = "EUW1";
  let pendingTierLoad = false;

  let tierState: TierState = "idle";
  let tierList: MetaTierList | null = null;
  let tierError: string | null = null;
  let tierRequestToken = 0;
  let roleFilter: RoleFilter = "all";

  let buildState: BuildState = "idle";
  let build: MetaBuild | null = null;
  let buildError: string | null = null;
  let buildRequestToken = 0;

  // --- En-tête de vue ---------------------------------------------------
  const heading = el("div", { className: "view-heading" });
  append(
    heading,
    el("h1", { className: "view-title", text: "Méta" }),
    el("p", {
      className: "view-sub",
      text: "Tier list et builds OP.GG — données externes réelles, sans clé Riot.",
    }),
  );
  const head = el("header", { className: "view-head" });
  head.appendChild(heading);

  // --- Sous-onglets + contrôles ----------------------------------------
  const subtabList = el("div", {
    className: "meta-subtabs",
    attrs: { role: "tablist", "aria-label": "Sections Méta" },
  });
  const subtabButtons = new Map<MetaSubtab, HTMLButtonElement>();
  const subtabDefinitions: readonly { id: MetaSubtab; label: string }[] = [
    { id: "tier", label: "Tier list" },
    { id: "builds", label: "Builds" },
  ];
  for (const definition of subtabDefinitions) {
    const active = definition.id === subtab;
    const button = el("button", {
      className: "meta-subtab",
      text: definition.label,
      attrs: {
        type: "button",
        role: "tab",
        id: `meta-tab-${definition.id}`,
        "aria-controls": `meta-panel-${definition.id}`,
        "aria-selected": active ? "true" : "false",
        "data-meta-subtab": definition.id,
      },
    });
    button.addEventListener("click", () => {
      setSubtab(definition.id);
    });
    subtabButtons.set(definition.id, button);
    subtabList.appendChild(button);
  }

  const platformSelect = el("select", {
    className: "riot-select meta-platform-select",
    attrs: {
      "data-meta-platform": "true",
      "aria-label":
        "Plateforme (libellé et cache local uniquement — les données OP.GG ne sont pas régionalisées)",
    },
  });
  platformSelect.disabled = true;

  const loadButton = el("button", {
    className: "btn btn-primary",
    attrs: { type: "button", "data-meta-load": "true" },
  });
  append(loadButton, icon("search", 15), el("span", { className: "btn-label", text: "Charger" }));

  const refreshButton = el("button", {
    className: "btn",
    attrs: { type: "button", "data-meta-refresh": "true" },
  });
  append(refreshButton, icon("sync", 15), el("span", { className: "btn-label", text: "Rafraîchir" }));

  const toolbarControls = el("div", { className: "meta-controls" });
  append(
    toolbarControls,
    el("span", {
      className: "meta-control-label",
      text: "Plateforme (libellé / cache) :",
    }),
    platformSelect,
    loadButton,
    refreshButton,
  );

  const toolbar = el("div", { className: "meta-toolbar" });
  append(toolbar, subtabList, toolbarControls);

  // Honnêteté : le MCP OP.GG n'expose aucun paramètre de région. Le sélecteur
  // ne sert qu'au libellé et à la clé de cache locale, pas au filtrage des
  // données (portée par défaut d'OP.GG).
  const regionNote = el("p", {
    className: "meta-region-note",
    text: "Les données tier list/builds du MCP OP.GG ne sont pas régionalisées : la portée est celle par défaut d'OP.GG. Le sélecteur n'influence que le libellé/le cache local.",
    attrs: { "data-meta-region-note": "true" },
  });

  const platformError = el("p", { className: "meta-platforms-error" });
  platformError.hidden = true;
  const platformsRetry = el("button", {
    className: "btn btn-ghost",
    text: "Recharger les plateformes",
    attrs: { type: "button" },
  });
  platformsRetry.hidden = true;

  // --- Bandeau source ---------------------------------------------------
  const sourceName = el("span", {
    className: "meta-source-name",
    text: "OP.GG",
    attrs: { "data-meta-source": "true" },
  });
  const fetchedAtValue = el("span", {
    className: "meta-fetched-at",
    text: EMPTY_VALUE,
    attrs: { "data-meta-fetched-at": "true" },
  });
  const cacheBadge = el("span", { className: "meta-cache-badge", text: EMPTY_VALUE });
  cacheBadge.hidden = true;
  const sourceLine = el("div", { className: "meta-source-line" });
  append(
    sourceLine,
    el("span", { className: "meta-source-label", text: "Source :" }),
    sourceName,
    el("span", { className: "meta-source-label", text: "(MCP public)" }),
    el("span", { className: "meta-source-sep", text: "·" }),
    el("span", { className: "meta-source-label", text: "Récupéré :" }),
    fetchedAtValue,
    cacheBadge,
  );
  const sourceWarning = el("p", { className: "meta-warning" });
  sourceWarning.hidden = true;
  const sourceBar = el("div", { className: "meta-source-bar" });
  append(sourceBar, sourceLine, sourceWarning);

  // --- Panneau Tier list ------------------------------------------------
  const roleButtons: HTMLButtonElement[] = [];
  const roleFilters = el("div", {
    className: "meta-role-filters",
    attrs: { role: "group", "aria-label": "Filtrer la tier list par rôle" },
  });
  for (const role of ROLE_FILTERS) {
    const button = el("button", {
      className: "filter-chip",
      text: role.label,
      attrs: {
        type: "button",
        "data-meta-tier-role": role.value,
        "aria-pressed": role.value === roleFilter ? "true" : "false",
      },
    });
    button.addEventListener("click", () => {
      roleFilter = role.value;
      updateRoleButtons();
      renderTier();
    });
    roleButtons.push(button);
    roleFilters.appendChild(button);
  }

  const tierLoadedBadge = el("span", {
    className: "meta-tier-loaded",
    text: "",
    attrs: { "data-meta-tier-loaded": "true" },
  });
  tierLoadedBadge.hidden = true;

  const tierContent = el("div", { className: "meta-tier-content" });

  const tierPanel = el("section", {
    className: "meta-panel",
    attrs: {
      role: "tabpanel",
      id: "meta-panel-tier",
      "aria-labelledby": "meta-tab-tier",
    },
  });
  append(tierPanel, roleFilters, tierLoadedBadge, tierContent);

  // --- Panneau Builds ---------------------------------------------------
  const championSelect = el("select", {
    className: "riot-select",
    attrs: { "data-meta-champion": "true", "aria-label": "Champion pour les builds" },
  });
  const roleSelect = el("select", {
    className: "riot-select",
    attrs: { "data-meta-role": "true", "aria-label": "Rôle pour les builds" },
  });
  for (const role of BUILD_ROLES) {
    roleSelect.appendChild(
      el("option", { text: role.label, attrs: { value: role.value } }),
    );
  }
  roleSelect.value = "mid";
  const tierSelect = el("select", {
    className: "riot-select",
    attrs: { "data-meta-build-tier": "true", "aria-label": "Niveau de joueurs des builds" },
  });
  for (const tier of BUILD_TIERS) {
    tierSelect.appendChild(
      el("option", { text: tier.label, attrs: { value: tier.value } }),
    );
  }
  tierSelect.value = "challenger";

  const loadBuildButton = el("button", {
    className: "btn btn-primary",
    attrs: { type: "button", "data-meta-load-build": "true" },
  });
  append(
    loadBuildButton,
    icon("search", 15),
    el("span", { className: "btn-label", text: "Charger les builds" }),
  );

  const championField = el("label", { className: "riot-field" });
  append(
    championField,
    el("span", { className: "riot-field-label", text: "Champion" }),
    championSelect,
  );
  const roleField = el("label", { className: "riot-field" });
  append(roleField, el("span", { className: "riot-field-label", text: "Rôle" }), roleSelect);
  const tierField = el("label", { className: "riot-field" });
  append(
    tierField,
    el("span", { className: "riot-field-label", text: "Niveau" }),
    tierSelect,
  );

  const buildFormGrid = el("div", { className: "meta-build-form" });
  append(buildFormGrid, championField, roleField, tierField);

  const buildFormActions = el("div", { className: "meta-build-actions" });
  buildFormActions.appendChild(loadBuildButton);

  const buildContent = el("div", { className: "meta-build-content" });

  const buildsPanel = el("section", {
    className: "meta-panel",
    attrs: {
      role: "tabpanel",
      id: "meta-panel-builds",
      "aria-labelledby": "meta-tab-builds",
    },
  });
  buildsPanel.hidden = true;
  append(buildsPanel, buildFormGrid, buildFormActions, buildContent);

  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "view view--meta",
    attrs: {
      role: "tabpanel",
      id: panelId("meta"),
      "data-view": "meta",
      "aria-labelledby": tabId("meta"),
    },
  });
  append(
    element,
    head,
    toolbar,
    regionNote,
    platformError,
    platformsRetry,
    sourceBar,
    tierPanel,
    buildsPanel,
    announcer,
  );
  element.hidden = true;

  // --- Utilitaires d'affichage -----------------------------------------
  function updateSubtabUi(): void {
    for (const [id, button] of subtabButtons) {
      const active = id === subtab;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    }
    tierPanel.hidden = subtab !== "tier";
    buildsPanel.hidden = subtab !== "builds";
    refreshButton.hidden = subtab !== "tier";
    loadButton.hidden = subtab !== "tier";
    updateSourceBar();
  }

  function setSubtab(next: MetaSubtab): void {
    if (subtab === next) {
      return;
    }
    subtab = next;
    updateSubtabUi();
    if (next === "builds") {
      refreshChampionOptions();
    }
  }

  function updateSourceBar(): void {
    const data: MetaTierList | MetaBuild | null = subtab === "tier" ? tierList : build;
    if (data === null) {
      fetchedAtValue.textContent = EMPTY_VALUE;
      cacheBadge.hidden = true;
      cacheBadge.textContent = "";
      sourceWarning.hidden = true;
      sourceWarning.textContent = "";
      return;
    }
    fetchedAtValue.textContent = formatDateTime(
      typeof data.fetchedAt === "string" ? data.fetchedAt : null,
    );
    cacheBadge.hidden = false;
    cacheBadge.textContent = data.fromCache ? "Données en cache" : "Données réseau";
    cacheBadge.setAttribute("data-cache", data.fromCache ? "true" : "false");
    sourceName.title = data.source === "" ? "OP.GG (MCP public)" : data.source;
    const warning =
      typeof data.warning === "string" && data.warning.trim() !== "" ? data.warning : null;
    sourceWarning.hidden = warning === null;
    sourceWarning.textContent = warning ?? "";
  }

  function updateRoleButtons(): void {
    for (const button of roleButtons) {
      const value = button.getAttribute("data-meta-tier-role");
      button.setAttribute("aria-pressed", value === roleFilter ? "true" : "false");
    }
  }

  // --- Plateformes ------------------------------------------------------
  function renderPlatformOptions(): void {
    if (platforms.length === 0) {
      replaceContent(
        platformSelect,
        el("option", { text: "Plateformes indisponibles", attrs: { value: "" } }),
      );
      return;
    }
    const entries = platforms.map((platform) =>
      el("option", { text: platform.label, attrs: { value: platform.id } }),
    );
    replaceContent(platformSelect, ...entries);
    const preferred =
      platforms.find((platform) => platform.id === selectedPlatform) ??
      platforms.find((platform) => platform.id === "EUW1") ??
      platforms[0];
    if (preferred !== undefined) {
      selectedPlatform = preferred.id;
      platformSelect.value = preferred.id;
    }
  }

  function applyPlatformsUi(): void {
    platformSelect.disabled = platformsBusy || platforms.length === 0;
    platformsRetry.hidden = platformsError === null;
    platformError.hidden = platformsError === null;
    if (platformsError !== null) {
      platformError.textContent = platformsError;
    }
  }

  async function fetchPlatforms(): Promise<void> {
    platformsBusy = true;
    platformsError = null;
    applyPlatformsUi();
    try {
      platforms = await api.getRiotPlatforms();
      if (platforms.length === 0) {
        platformsError = "Aucune plateforme Riot fournie par le backend.";
      }
      renderPlatformOptions();
    } catch (error) {
      platforms = [];
      platformsError = errorMessage(error);
      renderPlatformOptions();
    } finally {
      platformsBusy = false;
      applyPlatformsUi();
      if (!platformsBusy && platforms.length > 0 && pendingTierLoad) {
        pendingTierLoad = false;
        if (tierState === "idle") {
          void loadTier();
        }
      }
    }
  }

  // --- Tier list --------------------------------------------------------
  function buildChampionKeyIcon(championKey: number, alt: string): HTMLElement {
    const wrapper = el("span", { className: "meta-tier-icon-wrap" });
    const iconPath =
      Number.isFinite(championKey) && championKey > 0
        ? options.getChampionIconPathByKey(championKey)
        : null;
    if (iconPath !== null && iconPath.trim() !== "") {
      const image = el("img", {
        className: "meta-tier-icon",
        attrs: {
          alt,
          loading: "lazy",
          decoding: "async",
          draggable: "false",
          width: "32",
          height: "32",
        },
      });
      image.src = api.assetUrl(iconPath);
      image.addEventListener("error", () => {
        image.replaceWith(buildPlaceholder("meta-tier-icon meta-tier-icon--placeholder"));
      });
      wrapper.appendChild(image);
    } else {
      wrapper.appendChild(buildPlaceholder("meta-tier-icon meta-tier-icon--placeholder"));
    }
    return wrapper;
  }

  function buildTierRow(entry: MetaTierEntry): HTMLElement {
    const championKey = typeof entry.championKey === "number" ? entry.championKey : 0;
    const localName =
      championKey > 0 ? options.getChampionNameByKey(championKey) : null;
    const fallbackName =
      typeof entry.championName === "string" && entry.championName.trim() !== ""
        ? entry.championName
        : EMPTY_VALUE;
    const championName = localName ?? fallbackName;
    const position = normalizePosition(entry.position);

    const row = el("div", {
      className: "meta-tier-row",
      attrs: {
        "data-tier-entry": "true",
        "data-champion-key": String(championKey),
      },
    });

    append(
      row,
      el("span", { className: "meta-tier-rank", text: formatOptionalCount(entry.rank) }),
      buildChampionKeyIcon(championKey, championName),
      el("span", { className: "meta-tier-champion", text: championName }),
      el("span", {
        className: "meta-tier-role",
        text: position === "" ? EMPTY_VALUE : roleLabel(position),
      }),
      el("span", {
        className: "meta-tier-tier",
        text: tierLabel(entry.tier),
        attrs: { "data-tier": String(entry.tier) },
      }),
      el("span", { className: "meta-tier-winrate", text: formatRate(entry.winRate) }),
      el("span", { className: "meta-tier-pickrate", text: formatRate(entry.pickRate) }),
      el("span", { className: "meta-tier-banrate", text: formatRate(entry.banRate) }),
      el("span", { className: "meta-tier-kda", text: formatOptionalNumber(entry.kda) }),
      el("span", {
        className: "meta-tier-games",
        text: formatOptionalCount(entry.play),
      }),
    );
    return row;
  }

  function buildTierList(list: MetaTierList): HTMLElement {
    const entries = Array.isArray(list.entries) ? [...list.entries] : [];
    // Tri uniquement par rang OP.GG (aucun tri inventé) ; tri stable.
    entries.sort((a, b) => {
      const rankA = Number.isFinite(a.rank) ? a.rank : Number.MAX_SAFE_INTEGER;
      const rankB = Number.isFinite(b.rank) ? b.rank : Number.MAX_SAFE_INTEGER;
      return rankA - rankB;
    });
    const filtered =
      roleFilter === "all"
        ? entries
        : entries.filter((entry) => normalizePosition(entry.position) === roleFilter);

    const container = el("div", {
      className: "meta-tier-list",
      attrs: { "data-tier-list": "true" },
    });

    if (filtered.length === 0) {
      append(
        container,
        el("p", { className: "profile-empty-value", text: EMPTY_VALUE }),
        el("p", {
          className: "detail-empty-hint",
          text:
            entries.length === 0
              ? "Aucune entrée fournie par OP.GG pour cette plateforme."
              : "Aucune entrée pour ce rôle sur cette plateforme.",
        }),
      );
      return container;
    }

    const header = el("div", { className: "meta-tier-row meta-tier-row--head" });
    append(
      header,
      el("span", { className: "meta-tier-head", text: "Rang" }),
      el("span", { className: "meta-tier-head", text: "" }),
      el("span", { className: "meta-tier-head", text: "Champion" }),
      el("span", { className: "meta-tier-head", text: "Rôle" }),
      el("span", { className: "meta-tier-head", text: "Tier" }),
      el("span", { className: "meta-tier-head", text: "Win" }),
      el("span", { className: "meta-tier-head", text: "Pick" }),
      el("span", { className: "meta-tier-head", text: "Ban" }),
      el("span", { className: "meta-tier-head", text: "KDA" }),
      el("span", { className: "meta-tier-head", text: "Parties" }),
    );
    container.appendChild(header);
    for (const entry of filtered) {
      container.appendChild(buildTierRow(entry));
    }
    return container;
  }

  function renderTier(): void {
    updateRoleButtons();
    loadButton.disabled = tierState === "loading" || platforms.length === 0;
    refreshButton.disabled = tierState === "loading" || platforms.length === 0;

    switch (tierState) {
      case "loading": {
        tierLoadedBadge.hidden = true;
        const loading = el("div", { className: "profile-loading" });
        const line = el("div", { className: "loading-line" });
        append(
          line,
          el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
          el("span", {
            className: "loading-text",
            text: "Chargement de la tier list OP.GG…",
          }),
        );
        loading.appendChild(line);
        replaceContent(tierContent, loading);
        break;
      }
      case "error": {
        tierLoadedBadge.hidden = true;
        replaceContent(
          tierContent,
          buildPanelState({
            tone: "error",
            title: "Impossible de charger la tier list OP.GG",
            message: tierError ?? "Erreur inconnue.",
            actionLabel: "Réessayer",
            onAction: () => {
              void loadTier();
            },
            iconName: "alert",
          }),
        );
        break;
      }
      case "ready": {
        if (tierList === null) {
          tierLoadedBadge.hidden = true;
          replaceContent(tierContent, el("p", { className: "detail-empty", text: EMPTY_VALUE }));
          break;
        }
        const total = Array.isArray(tierList.entries) ? tierList.entries.length : 0;
        tierLoadedBadge.hidden = false;
        tierLoadedBadge.textContent = `Tier list chargée — ${formatCount(total)} entrées (${tierList.platform})`;
        replaceContent(tierContent, buildTierList(tierList));
        break;
      }
      case "idle": {
        tierLoadedBadge.hidden = true;
        replaceContent(
          tierContent,
          el("p", {
            className: "profile-empty-message",
            text: "Sélectionnez une plateforme puis chargez la tier list OP.GG.",
          }),
        );
        break;
      }
    }
    updateSourceBar();
  }

  async function loadTier(): Promise<void> {
    if (tierState === "loading") {
      return;
    }
    if (platforms.length === 0) {
      tierState = "error";
      tierError = platformsError ?? "Aucune plateforme Riot disponible.";
      renderTier();
      return;
    }
    const token = tierRequestToken + 1;
    tierRequestToken = token;
    tierState = "loading";
    tierError = null;
    renderTier();
    announcer.textContent = "Chargement de la tier list OP.GG…";
    try {
      const loaded = await api.getMetaTierList(selectedPlatform);
      if (tierRequestToken !== token) {
        return;
      }
      tierList = loaded;
      tierState = "ready";
      renderTier();
      announcer.textContent = `Tier list OP.GG chargée : ${formatCount(
        Array.isArray(loaded.entries) ? loaded.entries.length : 0,
      )} entrées.`;
    } catch (error) {
      if (tierRequestToken !== token) {
        return;
      }
      tierList = null;
      tierState = "error";
      tierError = errorMessage(error);
      renderTier();
      announcer.textContent = `Tier list OP.GG indisponible. ${tierError}`;
    }
  }

  // --- Builds -----------------------------------------------------------
  function refreshChampionOptions(): void {
    const champions = options.getChampions();
    if (champions.length === 0) {
      replaceContent(
        championSelect,
        el("option", { text: "Champions non chargés", attrs: { value: "" } }),
      );
      championSelect.disabled = true;
      return;
    }
    championSelect.disabled = false;
    const previous = championSelect.value;
    const entries = champions.map((champion) =>
      // Le backend normalise le nom Data Dragon (ex. « Wukong ») vers la clé OP.GG.
      el("option", { text: champion.name, attrs: { value: champion.name } }),
    );
    replaceContent(championSelect, ...entries);
    const target =
      champions.find((champion) => champion.name === previous) ??
      champions.find((champion) => champion.name === "Ahri") ??
      champions[0];
    if (target !== undefined) {
      championSelect.value = target.name;
    }
    // Le bouton de chargement dépend de la disponibilité des champions.
    renderBuilds();
  }

  function buildItemCell(itemId: number, fallbackName: string): HTMLElement {
    const cell = el("span", { className: "build-item-cell" });
    const wrapper = el("span", { className: "build-item-icon-wrap" });
    const iconPath =
      Number.isFinite(itemId) && itemId > 0 ? options.getItemIconPathById(itemId) : null;
    const localName = Number.isFinite(itemId) && itemId > 0 ? options.getItemNameById(itemId) : null;
    const name = localName ?? fallbackName;

    if (iconPath !== null && iconPath.trim() !== "") {
      const image = el("img", {
        className: "build-item-icon",
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
        image.replaceWith(buildPlaceholder("build-item-icon build-item-icon--placeholder"));
      });
      wrapper.appendChild(image);
    } else {
      wrapper.appendChild(buildPlaceholder("build-item-icon build-item-icon--placeholder"));
    }
    cell.appendChild(wrapper);
    cell.appendChild(el("span", { className: "build-item-name", text: name }));
    return cell;
  }

  function buildBuildRow(itemBuild: MetaItemBuild): HTMLElement {
    const row = el("div", {
      className: "meta-build-row",
      attrs: { "data-build-item": "true" },
    });
    const ids = Array.isArray(itemBuild.ids) ? itemBuild.ids : [];
    const names = Array.isArray(itemBuild.names) ? itemBuild.names : [];
    const cells = el("span", { className: "build-item-cells" });

    const total = Math.max(ids.length, names.length);
    if (total === 0) {
      cells.appendChild(
        el("span", { className: "build-item-name", text: EMPTY_VALUE }),
      );
    } else {
      for (let index = 0; index < total; index += 1) {
        const id = ids[index];
        const fallback = names[index];
        const fallbackName =
          typeof fallback === "string" && fallback.trim() !== "" ? fallback : EMPTY_VALUE;
        cells.appendChild(
          buildItemCell(typeof id === "number" ? id : 0, fallbackName),
        );
      }
    }

    const games = typeof itemBuild.games === "number" ? itemBuild.games : null;
    const lowSample = games !== null && games < LOW_SAMPLE_GAMES;

    const meta = el("span", { className: "meta-build-row-meta" });
    append(
      meta,
      el("span", {
        className: "build-item-pickrate",
        text: formatRate(itemBuild.pickRate),
        attrs: { title: "Taux de sélection OP.GG" },
      }),
      el("span", {
        className: "build-item-games",
        text: `${formatOptionalCount(itemBuild.games)} parties`,
      }),
    );
    if (lowSample) {
      meta.appendChild(el("span", { className: "build-low-sample", text: "Échantillon faible" }));
    }

    append(row, cells, meta);
    return row;
  }

  function buildBuildsContent(metaBuild: MetaBuild): HTMLElement {
    const container = el("div", {
      className: "meta-builds",
      attrs: { "data-meta-builds": "true" },
    });

    const header = el("header", { className: "meta-build-header" });
    const title = el("div", { className: "meta-build-title" });
    append(
      title,
      el("h2", {
        className: "meta-build-champion",
        text:
          typeof metaBuild.champion === "string" && metaBuild.champion.trim() !== ""
            ? metaBuild.champion
            : EMPTY_VALUE,
      }),
      el("p", {
        className: "meta-build-subtitle",
        text: `${roleLabel(normalizePosition(metaBuild.position))} · ${metaBuild.tier === "challenger" ? "Challenger" : "Tous"} · ${metaBuild.platform}`,
      }),
    );

    const headerMeta = el("div", { className: "meta-build-meta" });
    const cache = el("span", {
      className: "meta-cache-badge build-cache",
      text: metaBuild.fromCache ? "Données en cache" : "Données réseau",
      attrs: { "data-cache": metaBuild.fromCache ? "true" : "false" },
    });
    headerMeta.appendChild(cache);
    const source = el("span", {
      className: "meta-source-name",
      text: "OP.GG",
      attrs: { "data-build-source": "true" },
    });
    append(
      headerMeta,
      source,
      el("span", {
        className: "meta-fetched-at",
        text: formatDateTime(
          typeof metaBuild.fetchedAt === "string" ? metaBuild.fetchedAt : null,
        ),
      }),
    );
    append(header, title, headerMeta);
    container.appendChild(header);

    const summary = el("div", { className: "meta-build-summary" });
    const summaryItems: readonly (readonly [string, string])[] = [
      ["Win rate", formatRate(metaBuild.winRate)],
      ["Pick rate", formatRate(metaBuild.pickRate)],
      ["Ban rate", formatRate(metaBuild.banRate)],
      ["Parties", formatOptionalCount(metaBuild.games)],
      ["Tier OP.GG", tierLabel(metaBuild.tierLabel)],
      ["Rang", formatOptionalCount(metaBuild.rank)],
    ];
    for (const [label, value] of summaryItems) {
      const item = el("div", { className: "meta-build-summary-item" });
      append(
        item,
        el("span", { className: "meta-build-summary-label", text: label }),
        el("span", { className: "meta-build-summary-value", text: value }),
      );
      summary.appendChild(item);
    }
    container.appendChild(summary);

    const warnings: string[] = [];
    if (typeof metaBuild.warning === "string" && metaBuild.warning.trim() !== "") {
      warnings.push(metaBuild.warning);
    }
    if (metaBuild.games !== null && metaBuild.games < LOW_SAMPLE_GAMES) {
      warnings.push(
        `Échantillon faible : ${formatCount(metaBuild.games)} parties analysées par OP.GG (moins de ${LOW_SAMPLE_GAMES}).`,
      );
    }
    for (const warningText of warnings) {
      container.appendChild(
        el("p", { className: "meta-warning", text: warningText }),
      );
    }

    for (const sectionDef of BUILD_SECTIONS) {
      const section = el("section", {
        className: "meta-build-section",
        attrs: { "data-build-section": sectionDef.hook },
      });
      section.appendChild(
        el("h3", { className: "meta-build-section-title", text: sectionDef.label }),
      );

      const builds = Array.isArray(metaBuild[sectionDef.key])
        ? metaBuild[sectionDef.key]
        : [];
      if (builds.length === 0) {
        append(
          section,
          el("p", { className: "profile-empty-value", text: EMPTY_VALUE }),
          el("p", {
            className: "detail-empty-hint",
            text: "Aucun build fourni par OP.GG pour cette section.",
          }),
        );
      } else {
        for (const itemBuild of builds) {
          section.appendChild(buildBuildRow(itemBuild));
        }
      }
      container.appendChild(section);
    }

    return container;
  }

  function renderBuilds(): void {
    const loading = buildState === "loading";
    loadBuildButton.disabled = loading || options.getChampions().length === 0;
    championSelect.disabled = loading || options.getChampions().length === 0;
    roleSelect.disabled = loading;
    tierSelect.disabled = loading;

    switch (buildState) {
      case "loading": {
        const container = el("div", { className: "profile-loading" });
        const line = el("div", { className: "loading-line" });
        append(
          line,
          el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
          el("span", { className: "loading-text", text: "Chargement des builds OP.GG…" }),
        );
        container.appendChild(line);
        replaceContent(buildContent, container);
        break;
      }
      case "error": {
        replaceContent(
          buildContent,
          buildPanelState({
            tone: "error",
            title: "Impossible de charger les builds OP.GG",
            message: buildError ?? "Erreur inconnue.",
            actionLabel: "Réessayer",
            onAction: () => {
              void loadBuilds();
            },
            iconName: "alert",
          }),
        );
        break;
      }
      case "ready": {
        replaceContent(
          buildContent,
          build === null
            ? el("p", { className: "detail-empty", text: EMPTY_VALUE })
            : buildBuildsContent(build),
        );
        break;
      }
      case "idle": {
        replaceContent(
          buildContent,
          el("p", {
            className: "profile-empty-message",
            text: "Choisissez un champion, un rôle et un niveau puis lancez le chargement des builds OP.GG.",
          }),
        );
        break;
      }
    }
    updateSourceBar();
  }

  async function loadBuilds(): Promise<void> {
    if (buildState === "loading") {
      return;
    }
    const champion = championSelect.value;
    const position = roleSelect.value;
    const tier = tierSelect.value;
    if (champion === "") {
      buildState = "error";
      buildError = "Sélectionnez un champion pour charger les builds.";
      renderBuilds();
      return;
    }
    if (platforms.length === 0) {
      buildState = "error";
      buildError = platformsError ?? "Aucune plateforme Riot disponible.";
      renderBuilds();
      return;
    }
    const token = buildRequestToken + 1;
    buildRequestToken = token;
    buildState = "loading";
    buildError = null;
    renderBuilds();
    announcer.textContent = "Chargement des builds OP.GG…";
    try {
      const loaded = await api.getMetaBuilds(champion, position, selectedPlatform, tier);
      if (buildRequestToken !== token) {
        return;
      }
      build = loaded;
      buildState = "ready";
      renderBuilds();
      announcer.textContent = `Builds OP.GG chargés pour ${loaded.champion}.`;
    } catch (error) {
      if (buildRequestToken !== token) {
        return;
      }
      build = null;
      buildState = "error";
      buildError = errorMessage(error);
      renderBuilds();
      announcer.textContent = `Builds OP.GG indisponibles. ${buildError}`;
    }
  }

  // --- Événements -------------------------------------------------------
  function bindEvents(): void {
    platformSelect.addEventListener("change", () => {
      const value = platformSelect.value;
      if (value !== selectedPlatform) {
        selectedPlatform = value;
        void loadTier();
      }
    });
    loadButton.addEventListener("click", () => {
      void loadTier();
    });
    refreshButton.addEventListener("click", () => {
      void loadTier();
    });
    loadBuildButton.addEventListener("click", () => {
      void loadBuilds();
    });
    platformsRetry.addEventListener("click", () => {
      void fetchPlatforms();
    });
  }

  // --- API publique -----------------------------------------------------
  function onShown(): void {
    refreshChampionOptions();
    if (platformsBusy) {
      pendingTierLoad = true;
      return;
    }
    if (platforms.length > 0 && tierState === "idle") {
      void loadTier();
    }
  }

  bindEvents();
  updateSubtabUi();
  renderTier();
  renderBuilds();
  refreshChampionOptions();
  applyPlatformsUi();
  void fetchPlatforms();

  return {
    element,
    onShown,
    refreshChampionOptions,
  };
}
