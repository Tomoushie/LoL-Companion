/**
 * Pied de page : chemin du cache local (tronqué visuellement, chemin complet
 * en infobulle), dernière synchronisation formatée et compteurs réels du cache.
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

  const element = el("footer", { className: "app-footer" });
  append(element, pathCell.root, syncCell.root, counts);

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
