/**
 * Vue « Fiche rune » : détail d'une rune Data Dragon déjà chargée.
 *
 * Les noms/descriptions français proviennent de la localisation officielle
 * fr_FR fournie par le backend ; fallback en_US, puis « — ».
 * Win rate et champions utilisateurs ne sont pas fournis par Data Dragon :
 * aucune donnée n'est inventée.
 */

import { api } from "../api";
import type { Rune, RuneTree } from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE } from "../ui/format";
import { icon } from "../ui/icons";
import {
  optionalString,
  runeDisplayName,
  runeLongDescription,
  runeSecondaryName,
  runeShortDescription,
  runeTreeDisplayName,
} from "../ui/rune-labels";

export interface RuneDetailViewOptions {
  readonly onClose: () => void;
}

export interface RuneDetailViewHandle {
  readonly element: HTMLElement;
  setRune(tree: RuneTree, rune: Rune): void;
  clear(): void;
  focusBackButton(): void;
}

const HONEST_NOTE =
  "Win rate et champions utilisateurs non fournis par Data Dragon — aucune donnée inventée.";

function createIconPlaceholder(className: string): HTMLElement {
  return el("span", {
    className,
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

function buildLargeIcon(rune: Rune): HTMLElement {
  const wrapper = el("span", { className: "detail-icon-wrap detail-icon-wrap--large" });
  const iconPath = optionalString(rune.iconPath);

  if (iconPath !== null) {
    const image = el("img", {
      className: "detail-icon detail-icon--large",
      attrs: {
        alt: runeDisplayName(rune),
        loading: "lazy",
        decoding: "async",
        draggable: "false",
        width: "96",
        height: "96",
      },
    });
    image.src = api.assetUrl(iconPath);
    image.addEventListener("error", () => {
      image.replaceWith(createIconPlaceholder("detail-icon detail-icon--placeholder"));
    });
    wrapper.appendChild(image);
  } else {
    wrapper.appendChild(createIconPlaceholder("detail-icon detail-icon--placeholder"));
  }

  return wrapper;
}

function buildInfoRow(label: string, value: string): HTMLElement {
  const row = el("div", { className: "detail-info-row" });
  append(
    row,
    el("span", { className: "detail-info-label", text: label }),
    el("span", { className: "detail-info-value", text: value }),
  );
  return row;
}

function buildDetailLayout(tree: RuneTree, rune: Rune): HTMLElement {
  const layout = el("div", { className: "rune-detail-layout" });
  const isKeystone = rune.slot === 0;

  const head = el("header", { className: "detail-hero-row" });
  const identity = el("div", { className: "detail-identity" });
  append(
    identity,
    el("h1", {
      className: "detail-entity-name rune-detail-name",
      text: runeDisplayName(rune),
    }),
  );
  const secondary = runeSecondaryName(optionalString(rune.localizedName), rune.name);
  if (secondary !== null) {
    identity.appendChild(el("span", { className: "detail-entity-sub", text: secondary }));
  }
  const meta = el("span", { className: "detail-tag-row" });
  append(
    meta,
    el("span", {
      className: isKeystone
        ? "rune-detail-chip rune-detail-chip--keystone"
        : "rune-detail-chip",
      text: isKeystone ? "Majeure (Keystone)" : "Mineure",
    }),
    el("span", {
      className: "rune-detail-chip",
      text: runeTreeDisplayName(tree),
      attrs: { title: "Arbre d'origine" },
    }),
    el("span", {
      className: "rune-detail-chip",
      text: `Palier ${rune.slot + 1}`,
    }),
  );
  identity.appendChild(meta);
  append(head, buildLargeIcon(rune), identity);
  layout.appendChild(head);

  const info = el("section", { className: "detail-section" });
  info.appendChild(el("h2", { className: "detail-section-title", text: "Informations" }));
  const infoGrid = el("div", { className: "detail-info-grid" });
  append(
    infoGrid,
    buildInfoRow("Arbre", runeTreeDisplayName(tree)),
    buildInfoRow("Palier", `${rune.slot + 1}`),
    buildInfoRow("Type", isKeystone ? "Rune majeure (Keystone)" : "Rune mineure"),
    buildInfoRow("Identifiant Data Dragon", String(rune.id)),
  );
  info.appendChild(infoGrid);
  layout.appendChild(info);

  const description = el("section", { className: "detail-section" });
  description.appendChild(
    el("h2", { className: "detail-section-title", text: "Description" }),
  );
  description.appendChild(
    el("p", {
      className: "detail-desc",
      text: runeLongDescription(rune),
      attrs: { "data-rune-long-desc": "true" },
    }),
  );
  const short = runeShortDescription(rune);
  const long = runeLongDescription(rune);
  if (short !== EMPTY_VALUE && short !== long) {
    append(
      description,
      el("h3", { className: "detail-subtitle", text: "Description courte" }),
      el("p", { className: "detail-desc detail-desc--muted", text: short }),
    );
  }
  layout.appendChild(description);

  layout.appendChild(el("p", { className: "detail-note", text: HONEST_NOTE }));
  return layout;
}

export function createRuneDetailView(
  options: RuneDetailViewOptions,
): RuneDetailViewHandle {
  const backButton = el("button", {
    className: "btn btn-ghost detail-back",
    attrs: {
      type: "button",
      "data-action": "back-rune",
      title: "Revenir à la liste des runes",
    },
  });
  append(
    backButton,
    icon("arrowLeft", 15),
    el("span", { className: "btn-label", text: "Retour aux runes" }),
  );
  backButton.addEventListener("click", options.onClose);

  const topbar = el("div", { className: "detail-topbar" });
  topbar.appendChild(backButton);

  const content = el("div", { className: "detail-content" });
  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "view view--rune-detail",
    attrs: {
      id: "view-rune-detail",
      "data-view": "rune-detail",
      "aria-label": "Fiche rune",
      role: "region",
    },
  });
  append(element, topbar, content, announcer);
  element.hidden = true;

  function setRune(tree: RuneTree, rune: Rune): void {
    element.setAttribute("data-rune-detail-id", String(rune.id));
    replaceContent(content, buildDetailLayout(tree, rune));
    announcer.textContent = `Fiche de ${runeDisplayName(rune)}.`;
  }

  function clear(): void {
    element.removeAttribute("data-rune-detail-id");
    replaceContent(content);
    announcer.textContent = "";
  }

  function focusBackButton(): void {
    backButton.focus();
  }

  return { element, setRune, clear, focusBackButton };
}
