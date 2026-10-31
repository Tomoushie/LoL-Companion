/**
 * États partagés du contenu : squelette de chargement et panneaux
 * (erreur / vide). Tous les messages affichés sont fournis par l'appelant
 * avec les valeurs réelles du backend.
 */

import { append, el } from "../ui/dom";
import { icon, type IconName } from "../ui/icons";

const DEFAULT_SKELETON_COUNT = 18;

export interface LoadingStateOptions {
  readonly message: string;
  readonly skeletonCount?: number;
  /** Gabarit de grille à esquisser : champions (112 px) ou objets (132 px). */
  readonly variant?: "champions" | "items";
}

/** Squelette de grille + ligne « spinner » annonçant le chargement. */
export function buildLoadingState(options: LoadingStateOptions): HTMLElement {
  const container = el("div", { className: "state state--loading" });

  const line = el("div", { className: "loading-line" });
  append(
    line,
    el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "loading-text", text: options.message }),
  );

  const gridClass =
    options.variant === "items" ? "item-grid grid--skeleton" : "champ-grid grid--skeleton";
  const skeleton = el("div", {
    className: gridClass,
    attrs: { "aria-hidden": "true" },
  });
  const count = options.skeletonCount ?? DEFAULT_SKELETON_COUNT;
  for (let index = 0; index < count; index += 1) {
    const card = el("div", { className: "grid-skeleton" });
    append(
      card,
      el("div", { className: "skeleton-thumb" }),
      el("div", { className: "skeleton-line" }),
      el("div", { className: "skeleton-line skeleton-line--short" }),
    );
    skeleton.appendChild(card);
  }

  append(container, line, skeleton);
  return container;
}

export interface PanelStateOptions {
  readonly tone: "error" | "empty";
  readonly title: string;
  readonly message: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly iconName?: IconName;
}

/** Panneau centré pour un état bloquant (cache vide, chargement impossible…). */
export function buildPanelState(options: PanelStateOptions): HTMLElement {
  const container = el("div", {
    className: `state state--panel state--${options.tone}`,
  });

  const iconBox = el("div", { className: "state-icon", attrs: { "aria-hidden": "true" } });
  iconBox.appendChild(icon(options.iconName ?? (options.tone === "error" ? "alert" : "grid"), 22));

  append(
    container,
    iconBox,
    el("h2", { className: "state-title", text: options.title }),
    el("p", { className: "state-message", text: options.message }),
  );

  if (options.actionLabel !== undefined && options.onAction !== undefined) {
    const action = el("button", {
      className: "btn btn-primary",
      text: options.actionLabel,
      attrs: { type: "button" },
    });
    action.addEventListener("click", options.onAction);
    container.appendChild(action);
  }

  return container;
}
