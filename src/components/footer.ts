/**
 * Pied de page : chemin du cache local (tronqué visuellement, chemin complet
 * en infobulle), dernière synchronisation formatée, compteurs réels du cache
 * et bascule du curseur personnalisé (V1.0).
 */

import type { DataStatus } from "../types";
import { append, el } from "../ui/dom";
import { EMPTY_VALUE, formatCount, formatDateTime, formatPath } from "../ui/format";

export interface FooterHandle {
  readonly element: HTMLElement;
  setStatus(status: DataStatus | null): void;
}

interface Cell {
  readonly root: HTMLElement;
  readonly value: HTMLElement;
}

const CURSOR_STORAGE_KEY = "lolbot.cursor";
const CURSOR_CUSTOM_VALUE = "custom";
const CURSOR_STANDARD_VALUE = "standard";

function readCursorPreference(): boolean {
  try {
    return window.localStorage.getItem(CURSOR_STORAGE_KEY) === CURSOR_CUSTOM_VALUE;
  } catch {
    // localStorage indisponible (webview restreinte) : curseur standard.
    return false;
  }
}

function writeCursorPreference(custom: boolean): void {
  try {
    window.localStorage.setItem(
      CURSOR_STORAGE_KEY,
      custom ? CURSOR_CUSTOM_VALUE : CURSOR_STANDARD_VALUE,
    );
  } catch {
    // La préférence reste appliquée pour la session, sans persistance.
  }
}

function createCell(label: string, rootClass: string, valueClass: string): Cell {
  const root = el("div", { className: rootClass });
  const value = el("span", { className: valueClass });
  append(root, el("span", { className: "footer-label", text: label }), value);
  return { root, value };
}

export function createFooter(): FooterHandle {
  const pathCell = createCell("Cache", "footer-cell", "footer-value footer-path");
  const syncCell = createCell("Dernière synchro", "footer-cell", "footer-value");
  const itemsCell = createCell("Objets", "footer-count", "footer-value");
  const runesCell = createCell("Runes", "footer-count", "footer-value");

  const counts = el("div", { className: "footer-counts" });
  append(counts, itemsCell.root, runesCell.root);

  // --- Curseur personnalisé (V1.0) -------------------------------------
  let customCursor = readCursorPreference();
  const cursorState = el("span", {
    className: "footer-cursor-state",
    attrs: { "data-cursor-state": "true" },
  });
  const cursorToggle = el("button", {
    className: "footer-cursor-toggle",
    attrs: { type: "button", "data-cursor-toggle": "true" },
  });
  cursorToggle.appendChild(cursorState);

  function applyCursor(custom: boolean): void {
    document.body.classList.toggle("cursor-custom", custom);
    cursorState.textContent = custom ? "Curseur personnalisé" : "Curseur standard";
    cursorToggle.setAttribute("aria-pressed", custom ? "true" : "false");
    cursorToggle.title = custom
      ? "Revenir au curseur standard"
      : "Activer le curseur personnalisé";
  }

  applyCursor(customCursor);
  cursorToggle.addEventListener("click", () => {
    customCursor = !customCursor;
    applyCursor(customCursor);
    writeCursorPreference(customCursor);
  });

  const cursorCell = el("div", { className: "footer-cell footer-cursor" });
  append(cursorCell, el("span", { className: "footer-label", text: "Curseur" }), cursorToggle);

  const element = el("footer", { className: "app-footer" });
  append(element, pathCell.root, syncCell.root, cursorCell, counts);

  function setStatus(status: DataStatus | null): void {
    const cacheDir = status === null ? "" : status.cacheDir;
    pathCell.value.textContent = formatPath(cacheDir);
    if (cacheDir.trim() === "") {
      pathCell.value.removeAttribute("title");
    } else {
      pathCell.value.title = cacheDir;
    }

    const updatedAt = status === null ? null : status.updatedAt;
    syncCell.value.textContent = formatDateTime(updatedAt);
    if (updatedAt === null || updatedAt.trim() === "") {
      syncCell.value.removeAttribute("title");
    } else {
      syncCell.value.title = updatedAt;
    }

    itemsCell.value.textContent = status === null ? EMPTY_VALUE : formatCount(status.counts.items);
    runesCell.value.textContent =
      status === null ? EMPTY_VALUE : formatCount(status.counts.runeTrees);
  }

  setStatus(null);

  return { element, setStatus };
}
