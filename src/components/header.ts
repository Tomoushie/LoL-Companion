/**
 * En-tête de l'application : marque, onglets, indicateur d'état, badge de
 * version Data Dragon et bouton de synchronisation.
 */

import type { DataStatus } from "../types";
import { append, el } from "../ui/dom";
import { EMPTY_VALUE } from "../ui/format";
import { icon } from "../ui/icons";
import { describeConnection } from "../ui/status";
import { panelId, tabId, VIEWS, type ViewId } from "../ui/view";

export interface HeaderCallbacks {
  readonly onSync: () => void;
  readonly onSelectView: (view: ViewId) => void;
}

export interface HeaderHandle {
  readonly element: HTMLElement;
  setStatus(status: DataStatus | null): void;
  /** Aucune donnée exploitable (lecture du statut impossible). */
  setUnavailable(detail: string): void;
  setBusy(busy: boolean): void;
  setActiveView(view: ViewId): void;
  /** Rend le focus à l'onglet d'une vue (repli après fermeture d'une fiche). */
  focusTab(view: ViewId): void;
}

export function createHeader(callbacks: HeaderCallbacks): HeaderHandle {
  // --- Marque ---------------------------------------------------------
  const brandMark = el("span", {
    className: "brand-mark",
    text: "LB",
    attrs: { "aria-hidden": "true" },
  });
  const brandText = el("span", { className: "brand-text" });
  append(
    brandText,
    el("span", { className: "brand-title", text: "LOL BOT" }),
    el("span", { className: "brand-sub", text: "Compagnon local · Data Dragon" }),
  );
  const brand = el("div", { className: "brand" });
  append(brand, brandMark, brandText);

  // --- Onglets --------------------------------------------------------
  const tabList = el("div", {
    className: "tabs",
    attrs: { role: "tablist", "aria-label": "Vues de l'application" },
  });
  const tabs = new Map<ViewId, HTMLButtonElement>();

  for (const definition of VIEWS) {
    const active = definition.id === "champions";
    const tab = el("button", {
      className: "tab",
      text: definition.label,
      attrs: {
        type: "button",
        role: "tab",
        id: tabId(definition.id),
        "aria-controls": panelId(definition.id),
        "aria-selected": active ? "true" : "false",
        tabindex: active ? "0" : "-1",
      },
    });
    tab.addEventListener("click", () => {
      callbacks.onSelectView(definition.id);
    });
    tab.addEventListener("keydown", (event) => {
      handleTabKeydown(event, definition.id);
    });
    tabs.set(definition.id, tab);
    tabList.appendChild(tab);
  }

  function handleTabKeydown(event: KeyboardEvent, current: ViewId): void {
    const key = event.key;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") {
      return;
    }
    event.preventDefault();

    const index = VIEWS.findIndex((definition) => definition.id === current);
    if (index < 0) {
      return;
    }

    let targetIndex: number;
    if (key === "Home") {
      targetIndex = 0;
    } else if (key === "End") {
      targetIndex = VIEWS.length - 1;
    } else {
      const offset = key === "ArrowLeft" ? -1 : 1;
      targetIndex = (index + offset + VIEWS.length) % VIEWS.length;
    }

    const target = VIEWS[targetIndex];
    if (target === undefined) {
      return;
    }
    callbacks.onSelectView(target.id);
    tabs.get(target.id)?.focus();
  }

  const nav = el("nav", { className: "app-nav", attrs: { "aria-label": "Navigation principale" } });
  nav.appendChild(tabList);

  // --- Méta : état, version, synchronisation --------------------------
  const statusLabel = el("span", { className: "status-label", text: "Initialisation" });
  const statusPill = el("span", {
    className: "status-pill",
    attrs: { "data-tone": "pending", title: "Lecture du cache local Data Dragon…" },
  });
  append(
    statusPill,
    el("span", { className: "status-dot", attrs: { "aria-hidden": "true" } }),
    statusLabel,
  );

  const versionValue = el("span", { className: "version-value", text: EMPTY_VALUE });
  const versionBadge = el("span", {
    className: "version-badge",
    attrs: { title: "Version Data Dragon en cache" },
  });
  append(
    versionBadge,
    el("span", { className: "version-label", text: "DDRAGON" }),
    versionValue,
  );

  const syncLabel = el("span", { className: "btn-label", text: "Synchroniser" });
  const syncButton = el("button", {
    className: "btn btn-primary",
    attrs: { type: "button", title: "Télécharger ou rafraîchir les données Data Dragon" },
  });
  append(syncButton, icon("sync", 15), syncLabel);
  syncButton.addEventListener("click", callbacks.onSync);

  const meta = el("div", { className: "header-meta" });
  append(meta, statusPill, versionBadge, syncButton);

  const element = el("header", { className: "app-header" });
  append(element, brand, nav, meta);

  // --- Mises à jour ---------------------------------------------------
  function setStatus(status: DataStatus | null): void {
    const connection = describeConnection(status);
    statusPill.setAttribute("data-tone", connection.state);
    statusPill.title = connection.detail;
    statusLabel.textContent = connection.label;
    versionValue.textContent = status?.version ?? EMPTY_VALUE;
    versionBadge.title =
      status?.version !== null && status !== null
        ? `Version Data Dragon en cache : ${status.version}`
        : "Aucune version Data Dragon en cache";
  }

  function setUnavailable(detail: string): void {
    statusPill.setAttribute("data-tone", "unavailable");
    statusPill.title = detail;
    statusLabel.textContent = "Indisponible";
    versionValue.textContent = EMPTY_VALUE;
    versionBadge.title = "Version Data Dragon indisponible";
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

  function setActiveView(view: ViewId): void {
    for (const [id, tab] of tabs) {
      const active = id === view;
      tab.setAttribute("aria-selected", active ? "true" : "false");
      tab.tabIndex = active ? 0 : -1;
    }
  }

  function focusTab(view: ViewId): void {
    tabs.get(view)?.focus();
  }

  setStatus(null);
  setBusy(false);

  return { element, setStatus, setUnavailable, setBusy, setActiveView, focusTab };
}
