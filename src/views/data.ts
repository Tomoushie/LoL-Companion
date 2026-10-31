/**
 * Vue « Données » : diagnostic du cache local.
 * Chaque valeur affichée provient de `DataStatus` (backend Rust) ; une valeur
 * absente est rendue par « — » et jamais remplacée par une estimation.
 */

import type { DataStatus } from "../types";
import { append, el } from "../ui/dom";
import { EMPTY_VALUE, formatCount, formatDateTime, formatPath } from "../ui/format";
import { icon } from "../ui/icons";
import { panelId, tabId } from "../ui/view";

export interface DataViewOptions {
  readonly onSync: () => void;
}

export interface DataViewHandle {
  readonly element: HTMLElement;
  setStatus(status: DataStatus | null): void;
  setBusy(busy: boolean): void;
}

interface Row {
  readonly root: HTMLElement;
  readonly value: HTMLElement;
  readonly baseClass: string;
}

function createRow(label: string, baseClass = "data-value", stack = false): Row {
  const root = el("div", { className: stack ? "data-row data-row--stack" : "data-row" });
  const value = el("dd", { className: baseClass });
  append(root, el("dt", { className: "data-label", text: label }), value);
  return { root, value, baseClass };
}

function setRowValue(row: Row, text: string, tone: "warn" | null = null): void {
  row.value.textContent = text;
  row.value.className = tone === null ? row.baseClass : `${row.baseClass} data-value--${tone}`;
}

export function createDataView(options: DataViewOptions): DataViewHandle {
  // Bouton de synchronisation (même action que celui de l'en-tête).
  const syncLabel = el("span", { className: "btn-label", text: "Synchroniser" });
  const syncButton = el("button", {
    className: "btn btn-primary",
    attrs: { type: "button", title: "Télécharger ou rafraîchir les données Data Dragon" },
  });
  append(syncButton, icon("sync", 15), syncLabel);
  syncButton.addEventListener("click", options.onSync);

  const heading = el("div", { className: "view-heading" });
  append(
    heading,
    el("h1", { className: "view-title", text: "Données" }),
    el("p", {
      className: "view-sub",
      text: "Diagnostic du cache local Data Dragon — version, chemins et compteurs réels.",
    }),
  );

  const head = el("header", { className: "view-head" });
  append(head, heading, syncButton);

  // --- Carte « État de la synchronisation » ---------------------------
  const versionRow = createRow("Version Data Dragon", "data-value data-value--mono");
  const updatedRow = createRow("Dernière synchronisation");
  const offlineRow = createRow("Mode hors ligne");
  const warningRow = createRow("Avertissement");

  const stateCard = el("article", { className: "data-card" });
  const stateRows = el("dl", { className: "data-rows" });
  append(stateRows, versionRow.root, updatedRow.root, offlineRow.root, warningRow.root);
  append(
    stateCard,
    el("h2", { className: "data-card-title", text: "État de la synchronisation" }),
    stateRows,
  );

  // --- Carte « Cache local » ------------------------------------------
  // Chemin complet sur toute la largeur : les chemins longs ne sont pas coupés.
  const cacheDirRow = createRow("Dossier du cache", "data-value data-value--path", true);
  const championsRow = createRow("Champions", "data-value data-value--mono");
  const itemsRow = createRow("Objets", "data-value data-value--mono");
  const runeTreesRow = createRow("Arbres de runes", "data-value data-value--mono");
  const iconsRow = createRow("Icônes champions en cache", "data-value data-value--mono");
  const itemIconsRow = createRow("Icônes objets en cache", "data-value data-value--mono");
  const runeIconsRow = createRow("Icônes runes en cache", "data-value data-value--mono");

  const cacheCard = el("article", { className: "data-card" });
  const cacheRows = el("dl", { className: "data-rows" });
  append(
    cacheRows,
    cacheDirRow.root,
    championsRow.root,
    itemsRow.root,
    runeTreesRow.root,
    iconsRow.root,
    itemIconsRow.root,
    runeIconsRow.root,
  );
  append(
    cacheCard,
    el("h2", { className: "data-card-title", text: "Cache local" }),
    cacheRows,
  );

  const grid = el("div", { className: "data-grid" });
  append(grid, stateCard, cacheCard);

  const hint = el("p", {
    className: "data-hint",
    text: "Compteurs calculés par le backend Rust à partir des fichiers réellement présents dans le cache. Aucune valeur estimée.",
  });

  const element = el("section", {
    className: "view view--data",
    attrs: {
      role: "tabpanel",
      id: panelId("data"),
      "aria-labelledby": tabId("data"),
    },
  });
  append(element, head, grid, hint);
  element.hidden = true;

  function setStatus(status: DataStatus | null): void {
    setRowValue(versionRow, status?.version ?? EMPTY_VALUE);
    setRowValue(updatedRow, formatDateTime(status === null ? null : status.updatedAt));
    if (status !== null && status.updatedAt !== null) {
      updatedRow.value.title = status.updatedAt;
    } else {
      updatedRow.value.removeAttribute("title");
    }

    if (status === null) {
      setRowValue(offlineRow, EMPTY_VALUE);
    } else {
      setRowValue(offlineRow, status.offline ? "Oui — cache local" : "Non", status.offline ? "warn" : null);
    }

    if (status === null) {
      setRowValue(warningRow, EMPTY_VALUE);
    } else if (status.warning !== null && status.warning.trim() !== "") {
      setRowValue(warningRow, status.warning, "warn");
    } else {
      setRowValue(warningRow, "Aucun");
    }

    const cacheDir = status === null ? "" : status.cacheDir;
    setRowValue(cacheDirRow, formatPath(cacheDir));
    if (cacheDir.trim() === "") {
      cacheDirRow.value.removeAttribute("title");
    } else {
      cacheDirRow.value.title = cacheDir;
    }

    setRowValue(championsRow, status === null ? EMPTY_VALUE : formatCount(status.counts.champions));
    setRowValue(itemsRow, status === null ? EMPTY_VALUE : formatCount(status.counts.items));
    setRowValue(runeTreesRow, status === null ? EMPTY_VALUE : formatCount(status.counts.runeTrees));
    setRowValue(iconsRow, status === null ? EMPTY_VALUE : formatCount(status.counts.iconsCached));
    setRowValue(
      itemIconsRow,
      status === null ? EMPTY_VALUE : formatCount(status.counts.itemIconsCached),
    );
    setRowValue(
      runeIconsRow,
      status === null ? EMPTY_VALUE : formatCount(status.counts.runeIconsCached),
    );
  }

  function setBusy(busy: boolean): void {
    syncButton.disabled = busy;
    syncButton.setAttribute("aria-busy", busy ? "true" : "false");
    if (busy) {
      syncButton.setAttribute("data-busy", "true");
    } else {
      syncButton.removeAttribute("data-busy");
    }
    syncLabel.textContent = busy ? "Synchronisation…" : "Synchroniser";
  }

  setStatus(null);
  setBusy(false);

  return { element, setStatus, setBusy };
}
