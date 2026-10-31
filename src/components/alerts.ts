/**
 * Bannières globales d'état, affichées sous l'en-tête et visibles quel que
 * soit l'onglet actif :
 * - avertissement non bloquant (hors ligne, téléchargement partiel) ;
 * - erreur d'une synchronisation lancée depuis l'interface.
 * Les messages affichés sont toujours les messages réels du backend.
 */

import { append, el, replaceContent } from "../ui/dom";
import { icon } from "../ui/icons";

export interface ErrorAlertOptions {
  /** Libellé court expliquant le contexte de l'échec. */
  readonly label: string;
  /** Message réel remonté par le backend. */
  readonly message: string;
  readonly actionLabel: string;
  readonly onAction: () => void;
}

export interface AlertsHandle {
  readonly element: HTMLElement;
  showWarning(message: string): void;
  hideWarning(): void;
  showError(options: ErrorAlertOptions): void;
  hideError(): void;
}

export function createAlerts(): AlertsHandle {
  const element = el("div", { className: "alerts" });

  const warning = el("div", {
    className: "alert alert--warning",
    attrs: { role: "status", "aria-live": "polite" },
  });
  warning.hidden = true;

  const error = el("div", {
    className: "alert alert--error",
    attrs: { role: "alert" },
  });
  error.hidden = true;

  append(element, warning, error);

  function showWarning(message: string): void {
    const iconBox = el("span", { className: "alert-icon", attrs: { "aria-hidden": "true" } });
    iconBox.appendChild(icon("alert", 16));

    const body = el("div", { className: "alert-body" });
    append(
      body,
      el("p", { className: "alert-title", text: "Avertissement" }),
      el("p", { className: "alert-message", text: message }),
    );

    replaceContent(warning, iconBox, body);
    warning.hidden = false;
  }

  function hideWarning(): void {
    warning.hidden = true;
    replaceContent(warning);
  }

  function showError(options: ErrorAlertOptions): void {
    const iconBox = el("span", { className: "alert-icon", attrs: { "aria-hidden": "true" } });
    iconBox.appendChild(icon("alert", 16));

    const body = el("div", { className: "alert-body" });
    append(
      body,
      el("p", { className: "alert-title", text: options.label }),
      el("p", { className: "alert-message", text: options.message }),
    );

    const action = el("button", {
      className: "btn btn-danger",
      text: options.actionLabel,
      attrs: { type: "button" },
    });
    action.addEventListener("click", options.onAction);

    replaceContent(error, iconBox, body, action);
    error.hidden = false;
  }

  function hideError(): void {
    error.hidden = true;
    replaceContent(error);
  }

  return { element, showWarning, hideWarning, showError, hideError };
}
