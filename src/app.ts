/**
 * Contrôleur de l'interface V0.6.
 *
 * Séquence de démarrage :
 *   getDataStatus() → si version absente, icônes champions/objets/runes
 *   incomplètes, syncDdragon() (une seule fois par boot) → getChampions(),
 *   getItems() et getRuneTrees() → grilles.
 *
 * Vues détaillées : fiche champion (chargée via `api.getChampionDetail`),
 * fiche objet et fiche rune (rendues depuis les données locales déjà chargées),
 * fiche de match Riot (chargée via `api.getRiotMatch`). Les onglets Profil et
 * Méta gèrent eux-mêmes leurs appels (Riot API / OP.GG) et leur cache.
 *
 * Toutes les données affichées proviennent des commandes Tauri exposées par
 * `src/api.ts` ; l'interface ne fabrique jamais de valeur de remplacement.
 */

import { api } from "./api";
import { createAlerts } from "./components/alerts";
import { createFooter } from "./components/footer";
import { createGlobalSearch, type GlobalSearchResult } from "./components/global-search";
import { createHeader } from "./components/header";
import type { Champion, DataStatus, Item, Rune, RuneTree } from "./types";
import { append, el, replaceContent } from "./ui/dom";
import { errorMessage, formatCount, normalizeForSearch } from "./ui/format";
import { displayItemName, displayItemPlainText } from "./ui/item-labels";
import { runeDisplayName, runeSecondaryName, runeTreeDisplayName } from "./ui/rune-labels";
import type { ViewId } from "./ui/view";
import { createChampionDetailView } from "./views/champion-detail";
import { createChampionsView } from "./views/champions";
import { createDataView } from "./views/data";
import { createGlossaryView } from "./views/glossary";
import { createItemDetailView } from "./views/item-detail";
import { createItemsView } from "./views/items";
import { createMetaView } from "./views/meta";
import { createProfileView } from "./views/profile";
import { createRiotMatchDetailView } from "./views/riot-match-detail";
import { createRuneDetailView } from "./views/rune-detail";
import { createRunesView } from "./views/runes";

const LOADING_CACHE_MESSAGE = "Lecture du cache local Data Dragon…";
const LOADING_SYNC_MESSAGE =
  "Téléchargement des données Data Dragon et des icônes (champions, objets, runes)…";

type DetailKind = "champion" | "item" | "rune" | "match";

interface RuneLocation {
  readonly tree: RuneTree;
  readonly rune: Rune;
}

export function mountApp(root: HTMLElement): void {
  let status: DataStatus | null = null;
  let busy = false;
  let activeView: ViewId = "champions";

  let champions: readonly Champion[] = [];
  let items: readonly Item[] = [];
  let runeTrees: readonly RuneTree[] = [];

  /** Fiche actuellement ouverte (une seule à la fois) et son déclencheur. */
  let detailKind: DetailKind | null = null;
  let detailTargetId: string | null = null;
  let detailRequest = 0;
  let detailChampionId: string | null = null;
  let detailTrigger: HTMLElement | null = null;
  let savedScrollTop = 0;

  const alerts = createAlerts();
  const footer = createFooter();
  const championsView = createChampionsView({
    onSync: () => {
      void runSync();
    },
    onOpenChampion: (championId, trigger) => {
      openChampionDetail(championId, trigger);
    },
  });
  const itemsView = createItemsView({
    onSync: () => {
      void runSync();
    },
    onOpenItem: (itemId, trigger) => {
      openItemDetail(itemId, trigger);
    },
  });
  const runesView = createRunesView({
    onSync: () => {
      void runSync();
    },
    onOpenRune: (runeId, trigger) => {
      openRuneDetail(runeId, trigger);
    },
    getChampions: () => champions,
  });
  const profileView = createProfileView({
    onOpenMatch: (matchId, playerPuuid, trigger) => {
      openMatchDetail(matchId, playerPuuid, trigger);
    },
    getChampionIconPath: findChampionIconPath,
  });
  const metaView = createMetaView({
    getChampions: () => champions,
    getChampionIconPathByKey: findChampionIconPathByKey,
    getChampionNameByKey: findChampionNameByKey,
    getItemIconPathById: findItemIconPathById,
    getItemNameById: findItemNameById,
  });
  const glossaryView = createGlossaryView();
  const championDetailView = createChampionDetailView({
    onClose: () => {
      closeDetail(true);
    },
  });
  const itemDetailView = createItemDetailView({
    onClose: () => {
      closeDetail(true);
    },
    onOpenItem: (itemId, trigger) => {
      openItemDetail(itemId, trigger);
    },
  });
  const runeDetailView = createRuneDetailView({
    onClose: () => {
      closeDetail(true);
    },
  });
  const matchDetailView = createRiotMatchDetailView({
    onClose: () => {
      closeDetail(true);
    },
    getChampionIconPath: findChampionIconPath,
  });
  const dataView = createDataView({
    onSync: () => {
      void runSync();
    },
  });
  const header = createHeader({
    onSync: () => {
      void runSync();
    },
    onSelectView: (view) => {
      selectView(view);
    },
  });
  const search = createGlobalSearch({
    onSearch: searchAll,
    onSelect: (result, trigger) => {
      handleGlobalSelect(result, trigger);
    },
  });

  const main = el("main", { className: "app-main" });
  append(
    main,
    alerts.element,
    championsView.element,
    itemsView.element,
    runesView.element,
    profileView.element,
    metaView.element,
    glossaryView.element,
    championDetailView.element,
    itemDetailView.element,
    runeDetailView.element,
    matchDetailView.element,
    dataView.element,
  );

  const shell = el("div", { className: "app-shell" });
  append(shell, header.element, search.element, main, footer.element);
  replaceContent(root, shell);

  // Échap ferme d'abord la recherche globale, puis la fiche ouverte.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") {
      return;
    }
    if (search.isOpen()) {
      event.preventDefault();
      search.close();
      return;
    }
    if (detailKind !== null) {
      event.preventDefault();
      closeDetail(true);
    }
  });

  // --- Statut global ---------------------------------------------------
  /** Message d'avertissement réel à afficher, ou null si aucun. */
  function resolveWarning(current: DataStatus): string | null {
    if (current.offline) {
      return (
        current.warning ?? "Mode hors ligne : les données affichées proviennent du cache local."
      );
    }
    if (current.warning !== null && current.warning.trim() !== "") {
      return current.warning;
    }
    return null;
  }

  function applyStatus(next: DataStatus | null): void {
    status = next;
    header.setStatus(next);
    footer.setStatus(next);
    dataView.setStatus(next);

    if (next === null) {
      alerts.hideWarning();
      return;
    }
    const warning = resolveWarning(next);
    if (warning === null) {
      alerts.hideWarning();
    } else {
      alerts.showWarning(warning);
    }
  }

  /** Statut illisible : l'interface le dit clairement au lieu d'inventer. */
  function applyUnavailable(detail: string): void {
    status = null;
    header.setUnavailable(detail);
    footer.setStatus(null);
    dataView.setStatus(null);
    alerts.hideWarning();
  }

  function setBusy(next: boolean): void {
    busy = next;
    header.setBusy(next);
    dataView.setBusy(next);
  }

  // --- Affichage des vues / fiches ------------------------------------
  function showView(view: ViewId): void {
    const detail = detailKind;
    championsView.element.hidden = detail !== null || view !== "champions";
    itemsView.element.hidden = detail !== null || view !== "items";
    runesView.element.hidden = detail !== null || view !== "runes";
    profileView.element.hidden = detail !== null || view !== "profile";
    metaView.element.hidden = detail !== null || view !== "meta";
    glossaryView.element.hidden = detail !== null || view !== "glossary";
    dataView.element.hidden = detail !== null || view !== "data";
    championDetailView.element.hidden = detail !== "champion";
    itemDetailView.element.hidden = detail !== "item";
    runeDetailView.element.hidden = detail !== "rune";
    matchDetailView.element.hidden = detail !== "match";
    header.setActiveView(view);
    // Le diagnostic reste aligné sur le dernier statut connu.
    dataView.setStatus(status);
  }

  function selectView(view: ViewId): void {
    if (view !== activeView) {
      // Un changement d'onglet ferme la fiche en cours.
      closeDetail(false);
      activeView = view;
    }
    if (activeView === "meta") {
      // Chargement paresseux de la tier list OP.GG à la première arrivée.
      metaView.onShown();
    }
    showView(activeView);
  }

  function beginDetail(kind: DetailKind, targetId: string, trigger: HTMLElement | null): void {
    if (detailKind === null) {
      savedScrollTop = main.scrollTop;
    }
    detailKind = kind;
    detailTargetId = targetId;
    // Invalide toute requête champion encore en vol.
    detailRequest += 1;
    if (trigger !== null) {
      detailTrigger = trigger;
    }
    main.scrollTop = 0;
  }

  function cssEscape(value: string): string {
    return typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(value)
      : value.replace(/["\\]/g, "\\$&");
  }

  function findDetailCard(kind: DetailKind, targetId: string): HTMLElement | null {
    let selector: string;
    let host: HTMLElement;
    if (kind === "champion") {
      selector = `[data-champion-id="${cssEscape(targetId)}"]`;
      host = championsView.element;
    } else if (kind === "item") {
      selector = `[data-item-id="${cssEscape(targetId)}"]`;
      host = itemsView.element;
    } else if (kind === "rune") {
      selector = `[data-rune-id="${cssEscape(targetId)}"]`;
      host = runesView.element;
    } else {
      selector = `[data-match-id="${cssEscape(targetId)}"]`;
      host = profileView.element;
    }
    return host.querySelector<HTMLElement>(selector);
  }

  function closeDetail(restoreFocus: boolean): void {
    if (detailKind === null) {
      return;
    }
    const kind = detailKind;
    const targetId = detailTargetId;
    const trigger = detailTrigger;

    detailKind = null;
    detailTargetId = null;
    detailRequest += 1;
    detailChampionId = null;
    detailTrigger = null;

    championDetailView.clear();
    itemDetailView.clear();
    runeDetailView.clear();
    matchDetailView.clear();
    showView(activeView);
    main.scrollTop = savedScrollTop;

    if (!restoreFocus) {
      return;
    }
    if (trigger !== null && trigger.isConnected) {
      trigger.focus();
      return;
    }
    if (targetId !== null) {
      const card = findDetailCard(kind, targetId);
      if (card !== null) {
        card.focus();
        return;
      }
    }
    header.focusTab(activeView);
  }

  // --- Ouverture des fiches -------------------------------------------
  function openChampionDetail(championId: string, trigger: HTMLElement | null): void {
    activeView = "champions";
    beginDetail("champion", championId, trigger);
    detailChampionId = championId;
    const requestId = detailRequest;

    showView("champions");
    championDetailView.setLoading();
    championDetailView.focusBackButton();

    void (async () => {
      try {
        const detail = await api.getChampionDetail(championId);
        if (detailRequest !== requestId) {
          return;
        }
        championDetailView.setDetail(detail);
      } catch (error) {
        if (detailRequest !== requestId) {
          return;
        }
        championDetailView.setError(errorMessage(error), "Réessayer", () => {
          if (detailChampionId !== null) {
            openChampionDetail(detailChampionId, null);
          }
        });
      }
    })();
  }

  function openItemDetail(itemId: string, trigger: HTMLElement | null): void {
    const item = items.find((candidate) => candidate.id === itemId);
    if (item === undefined) {
      return;
    }
    activeView = "items";
    beginDetail("item", itemId, trigger);
    detailChampionId = null;
    itemDetailView.setItem(item, items);
    showView("items");
    itemDetailView.focusBackButton();
  }

  function findRune(runeId: number): RuneLocation | null {
    for (const tree of runeTrees) {
      const rune = tree.runes.find((candidate) => candidate.id === runeId);
      if (rune !== undefined) {
        return { tree, rune };
      }
    }
    return null;
  }

  /** Icône locale d'un champion à partir de son identifiant Data Dragon/Riot. */
  function findChampionIconPath(championName: string): string | null {
    const needle = championName.trim().toLowerCase();
    if (needle === "") {
      return null;
    }
    const found = champions.find(
      (champion) =>
        champion.id.toLowerCase() === needle || champion.name.toLowerCase() === needle,
    );
    return found !== undefined && typeof found.iconPath === "string" ? found.iconPath : null;
  }

  /** Champion local par clé numérique Data Dragon (tier list OP.GG). */
  function findChampionByKey(championKey: number): Champion | null {
    if (!Number.isFinite(championKey) || championKey <= 0) {
      return null;
    }
    const key = String(championKey);
    return champions.find((champion) => champion.key === key) ?? null;
  }

  function findChampionIconPathByKey(championKey: number): string | null {
    const champion = findChampionByKey(championKey);
    return champion !== null && typeof champion.iconPath === "string" ? champion.iconPath : null;
  }

  function findChampionNameByKey(championKey: number): string | null {
    const champion = findChampionByKey(championKey);
    return champion === null ? null : champion.name;
  }

  /** Objet local par identifiant Data Dragon (builds OP.GG). */
  function findItem(itemId: number): Item | null {
    if (!Number.isFinite(itemId) || itemId <= 0) {
      return null;
    }
    const id = String(itemId);
    return items.find((item) => item.id === id) ?? null;
  }

  function findItemIconPathById(itemId: number): string | null {
    const item = findItem(itemId);
    return item !== null && typeof item.iconPath === "string" ? item.iconPath : null;
  }

  function findItemNameById(itemId: number): string | null {
    const item = findItem(itemId);
    return item === null ? null : displayItemName(item);
  }

  function openRuneDetail(runeId: number, trigger: HTMLElement | null): void {
    const location = findRune(runeId);
    if (location === null) {
      return;
    }
    activeView = "runes";
    beginDetail("rune", String(runeId), trigger);
    detailChampionId = null;
    runesView.selectTreeByKey(location.tree.key);
    runeDetailView.setRune(location.tree, location.rune);
    showView("runes");
    runeDetailView.focusBackButton();
  }

  function openMatchDetail(
    matchId: string,
    playerPuuid: string,
    trigger: HTMLElement | null,
  ): void {
    activeView = "profile";
    beginDetail("match", matchId, trigger);
    detailChampionId = null;
    matchDetailView.load(matchId, playerPuuid);
    showView("profile");
    matchDetailView.focusBackButton();
  }

  // --- Recherche globale ----------------------------------------------
  function searchAll(rawQuery: string): readonly GlobalSearchResult[] {
    const normalized = normalizeForSearch(rawQuery.trim());
    if (normalized === "") {
      return [];
    }
    const results: GlobalSearchResult[] = [];

    for (const champion of champions) {
      const haystack = normalizeForSearch(`${champion.name} ${champion.title}`);
      if (!haystack.includes(normalized)) {
        continue;
      }
      results.push({
        type: "champion",
        id: champion.id,
        name: champion.name,
        secondary: champion.title.trim() === "" ? null : champion.title,
        iconPath: champion.iconPath,
      });
    }

    for (const item of items) {
      const plainText = displayItemPlainText(item);
      const haystack = normalizeForSearch(`${displayItemName(item)} ${plainText}`);
      if (!haystack.includes(normalized)) {
        continue;
      }
      results.push({
        type: "item",
        id: item.id,
        name: displayItemName(item),
        secondary: plainText.trim() !== "" ? plainText : `${formatCount(item.goldTotal)} or`,
        iconPath: item.iconPath,
      });
    }

    for (const tree of runeTrees) {
      for (const rune of tree.runes) {
        const haystack = normalizeForSearch(`${runeDisplayName(rune)} ${rune.name}`);
        if (!haystack.includes(normalized)) {
          continue;
        }
        const localized = typeof rune.localizedName === "string" ? rune.localizedName : null;
        const english = runeSecondaryName(localized, rune.name);
        results.push({
          type: "rune",
          id: String(rune.id),
          name: runeDisplayName(rune),
          secondary:
            english === null
              ? runeTreeDisplayName(tree)
              : `${runeTreeDisplayName(tree)} · ${english}`,
          iconPath: rune.iconPath,
        });
      }
    }

    return results;
  }

  function handleGlobalSelect(result: GlobalSearchResult, trigger: HTMLElement): void {
    search.close();
    if (result.type === "champion") {
      selectView("champions");
      openChampionDetail(result.id, trigger);
      return;
    }
    if (result.type === "item") {
      selectView("items");
      openItemDetail(result.id, trigger);
      return;
    }
    const runeId = Number(result.id);
    if (Number.isFinite(runeId)) {
      selectView("runes");
      openRuneDetail(runeId, trigger);
    }
  }

  // --- Chargement des données -----------------------------------------
  async function loadChampions(): Promise<void> {
    try {
      const loaded = await api.getChampions();
      champions = loaded;
      championsView.setChampions(loaded);
      // Les fiches Riot utilisent cette liste pour résoudre les icônes.
      profileView.refreshChampionIcons();
      matchDetailView.refreshChampionIcons();
      metaView.refreshChampionOptions();
      runesView.refreshChampionOptions();
    } catch (error) {
      championsView.setError(
        "Chargement des champions impossible",
        errorMessage(error),
        "Réessayer",
        () => {
          void boot();
        },
      );
    }
  }

  async function loadItems(): Promise<void> {
    try {
      const loaded = await api.getItems();
      items = loaded;
      itemsView.setItems(loaded);
    } catch (error) {
      itemsView.setError(
        "Chargement des objets impossible",
        errorMessage(error),
        "Réessayer",
        () => {
          void boot();
        },
      );
    }
  }

  async function loadRunes(): Promise<void> {
    try {
      const loaded = await api.getRuneTrees();
      runeTrees = loaded;
      runesView.setRuneTrees(loaded);
    } catch (error) {
      runesView.setError(
        "Chargement des runes impossible",
        errorMessage(error),
        "Réessayer",
        () => {
          void boot();
        },
      );
    }
  }

  /** Sync nécessaire si la version manque ou si des icônes réelles manquent. */
  function needsSync(current: DataStatus): boolean {
    if (current.version === null) {
      return true;
    }
    const counts = current.counts;
    const iconsCached = Number.isFinite(counts.iconsCached) ? counts.iconsCached : 0;
    const championsCount = Number.isFinite(counts.champions) ? counts.champions : 0;
    const itemIconsCached = Number.isFinite(counts.itemIconsCached) ? counts.itemIconsCached : 0;
    const itemsCount = Number.isFinite(counts.items) ? counts.items : 0;
    const runeIconsCached = Number.isFinite(counts.runeIconsCached) ? counts.runeIconsCached : 0;
    const runeTreesCount = Number.isFinite(counts.runeTrees) ? counts.runeTrees : 0;
    return (
      iconsCached < championsCount ||
      itemIconsCached < itemsCount ||
      // Les icônes de runes n'ont pas de total de référence : absence = sync.
      (runeIconsCached === 0 && runeTreesCount > 0)
    );
  }

  async function boot(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    closeDetail(false);
    search.close();
    champions = [];
    items = [];
    runeTrees = [];
    alerts.hideError();
    alerts.hideWarning();
    championsView.setLoading(LOADING_CACHE_MESSAGE);
    itemsView.setLoading(LOADING_CACHE_MESSAGE);
    runesView.setLoading(LOADING_CACHE_MESSAGE);

    let knownStatus: DataStatus | null = null;
    try {
      knownStatus = await api.getDataStatus();

      if (needsSync(knownStatus)) {
        championsView.setLoading(LOADING_SYNC_MESSAGE);
        itemsView.setLoading(LOADING_SYNC_MESSAGE);
        runesView.setLoading(LOADING_SYNC_MESSAGE);
        knownStatus = await api.syncDdragon();
      }

      applyStatus(knownStatus);
    } catch (error) {
      const message = errorMessage(error);
      if (knownStatus !== null) {
        applyStatus(knownStatus);
      } else {
        applyUnavailable(message);
      }
      const retry = (): void => {
        void boot();
      };
      championsView.setError("Chargement des données Data Dragon impossible", message, "Réessayer", retry);
      itemsView.setError("Chargement des données Data Dragon impossible", message, "Réessayer", retry);
      runesView.setError("Chargement des données Data Dragon impossible", message, "Réessayer", retry);
      setBusy(false);
      return;
    }

    // Lectures indépendantes : l'échec de l'une n'efface pas les autres vues.
    await Promise.all([loadChampions(), loadItems(), loadRunes()]);
    setBusy(false);
  }

  async function runSync(): Promise<void> {
    if (busy) {
      return;
    }
    setBusy(true);
    search.close();
    alerts.hideError();

    try {
      const nextStatus = await api.syncDdragon();
      applyStatus(nextStatus);
      await Promise.all([loadChampions(), loadItems(), loadRunes()]);
      // Une fiche ouverte reste affichée : données statiques inchangées.
    } catch (error) {
      alerts.showError({
        label: "Synchronisation impossible",
        message: errorMessage(error),
        actionLabel: "Réessayer",
        onAction: () => {
          void runSync();
        },
      });
    } finally {
      setBusy(false);
    }
  }

  showView("champions");
  void boot();
}
