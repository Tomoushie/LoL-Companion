/**
 * Vue « Profil » (V0.5) : clé API Riot locale, formulaire Riot ID/plateforme,
 * classements et 10 derniers matchs, avec cache/warning backend.
 *
 * La clé API n'est jamais réaffichée ni stockée côté interface : seule son
 * existence et son origine (local / environnement) sont affichées. Aucune
 * donnée n'est inventée : champs absents → « — », erreurs backend réelles.
 */

import { api } from "../api";
import { buildPanelState } from "../components/states";
import type {
  RiotKeyStatus,
  RiotLeagueEntry,
  RiotMatchSummary,
  RiotPlatformInfo,
  RiotProfile,
  RiotProgression,
} from "../types";
import { append, el, replaceContent } from "../ui/dom";
import {
  EMPTY_VALUE,
  errorMessage,
  formatCount,
  formatDateTime,
  formatDecimal,
} from "../ui/format";
import { icon } from "../ui/icons";
import { formatRate } from "../ui/rates";
import {
  formatDuration,
  riotNumber,
  riotPositionLabel,
  riotQueueLabel,
  riotQueueTypeLabel,
  riotRankLabel,
  riotResultLabel,
} from "../ui/riot-labels";
import { panelId, tabId } from "../ui/view";

export interface ProfileViewOptions {
  /** Ouvre la fiche d'un match (déclencheur pour le focus). */
  readonly onOpenMatch: (
    matchId: string,
    playerPuuid: string,
    trigger: HTMLElement,
  ) => void;
  /** Chemin local de l'icône d'un champion, résolu depuis la liste chargée. */
  readonly getChampionIconPath: (championName: string) => string | null;
}

export interface ProfileViewHandle {
  readonly element: HTMLElement;
  /** Re-rend les icônes de champions quand la liste locale a changé. */
  refreshChampionIcons(): void;
  /** Revérifie l'état de la clé API (ex. après le démarrage des données). */
  refreshKeyStatus(): void;
}

const MAX_MATCHES = 10;
const KNOWN_RANK_QUEUES: readonly string[] = ["RANKED_SOLO_5x5", "RANKED_FLEX_SR"];

const KEY_HINT =
  "Créez une clé de développement sur developer.riotgames.com. Elle est stockée localement (hors dépôt) et n'est jamais réaffichée par l'application.";

type ProfileState = "idle" | "loading" | "no-key" | "error";

interface ProfileError {
  readonly title: string;
  readonly message: string;
}

function validateRiotId(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") {
    return "Saisissez un Riot ID (format Nom#TAG).";
  }
  const parts = trimmed.split("#");
  if (parts.length !== 2) {
    return "Format attendu : Nom#TAG (ex. Faker#EUW).";
  }
  const name = parts[0];
  const tag = parts[1];
  if (name === undefined || tag === undefined) {
    return "Format attendu : Nom#TAG (ex. Faker#EUW).";
  }
  const trimmedName = name.trim();
  if (trimmedName.length < 3 || trimmedName.length > 16) {
    return "Le nom Riot doit contenir entre 3 et 16 caractères.";
  }
  if (!/^[A-Za-z0-9]{2,5}$/.test(tag)) {
    return "Le tag doit contenir 2 à 5 lettres ou chiffres (ex. EUW).";
  }
  return null;
}

/** Message d'erreur réel + titre contextuel (sans jamais masquer le message). */
function classifyProfileError(message: string): ProfileError {
  const lower = message.toLowerCase();
  if (lower.includes("404") || lower.includes("introuvable") || lower.includes("not found")) {
    return { title: "Joueur introuvable", message };
  }
  if (
    lower.includes("429") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("limite")
  ) {
    return { title: "Limite de requêtes Riot atteinte", message };
  }
  if (lower.includes("clé") || lower.includes("api key") || lower.includes("401")) {
    return { title: "Clé API Riot invalide ou refusée", message };
  }
  return { title: "Impossible de charger le profil Riot", message };
}

function kdaText(kills: unknown, deaths: unknown, assists: unknown): string {
  if (
    typeof kills === "number" &&
    Number.isFinite(kills) &&
    typeof deaths === "number" &&
    Number.isFinite(deaths) &&
    typeof assists === "number" &&
    Number.isFinite(assists)
  ) {
    return `${kills} / ${deaths} / ${assists}`;
  }
  return EMPTY_VALUE;
}

function buildIconPlaceholder(className: string): HTMLElement {
  return el("span", {
    className,
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

export function createProfileView(options: ProfileViewOptions): ProfileViewHandle {
  // --- État -------------------------------------------------------------
  let keyStatus: RiotKeyStatus | null = null;
  let keyStatusError: string | null = null;
  let keyErrorText: string | null = null;
  let keyBusy = false;

  let platforms: RiotPlatformInfo[] = [];
  let platformsBusy = true;
  let platformsError: string | null = null;

  let profile: RiotProfile | null = null;
  let profileState: ProfileState = "idle";
  let profileError: ProfileError | null = null;
  let loadingMessage = "Chargement du profil Riot…";
  let lastForceRefresh = false;
  let formError: string | null = null;

  let progression: RiotProgression | null = null;
  let progressionState: "idle" | "loading" | "ready" | "error" = "idle";
  let progressionError: ProfileError | null = null;
  let progressionMessage = "Analyse des 50 derniers matchs…";
  let progressionForce = false;
  let progressionRequest = 0;

  // --- Squelette --------------------------------------------------------
  const heading = el("div", { className: "view-heading" });
  append(
    heading,
    el("h1", { className: "view-title", text: "Profil" }),
    el("p", {
      className: "view-sub",
      text: "Riot API — clé stockée localement, aucune donnée inventée.",
    }),
  );
  const head = el("header", { className: "view-head" });
  head.appendChild(heading);

  // Bloc clé API.
  const keyBadge = el("span", {
    className: "riot-key-status",
    text: "Vérification…",
    attrs: { "data-state": "unknown" },
  });
  const keySource = el("p", { className: "riot-key-source" });
  const keyStatusRow = el("div", { className: "riot-key-status-row" });
  append(keyStatusRow, keyBadge, keySource);

  const keyInput = el("input", {
    className: "riot-key-input",
    attrs: {
      type: "password",
      "data-riot-key-input": "true",
      placeholder: "RGAPI-…",
      "aria-label": "Clé API Riot (jamais réaffichée)",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const saveLabel = el("span", { className: "btn-label", text: "Enregistrer la clé" });
  const keySave = el("button", {
    className: "btn btn-primary",
    attrs: { type: "button", "data-riot-key-save": "true" },
  });
  append(keySave, icon("sync", 15), saveLabel);

  const clearLabel = el("span", { className: "btn-label", text: "Supprimer la clé locale" });
  const keyClear = el("button", {
    className: "btn btn-danger",
    attrs: { type: "button", "data-riot-key-clear": "true" },
  });
  append(keyClear, icon("alert", 15), clearLabel);

  const keyControls = el("div", { className: "riot-key-controls" });
  append(keyControls, keyInput, keySave, keyClear);

  const keyHint = el("p", { className: "riot-key-hint", text: KEY_HINT });
  const keyError = el("p", { className: "riot-key-error" });
  keyError.hidden = true;

  const keyRetry = el("button", {
    className: "btn btn-ghost",
    text: "Revérifier l'état de la clé",
    attrs: { type: "button" },
  });
  keyRetry.hidden = true;

  const keyCard = el("section", { className: "profile-card" });
  append(
    keyCard,
    el("h2", { className: "detail-section-title", text: "Clé API Riot" }),
    keyStatusRow,
    keyControls,
    keyHint,
    keyError,
    keyRetry,
  );

  // Formulaire Riot ID.
  const idInput = el("input", {
    className: "riot-text-input",
    attrs: {
      type: "text",
      "data-riot-id-input": "true",
      placeholder: "Faker#EUW",
      "aria-label": "Riot ID (format Nom#TAG)",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const platformSelect = el("select", {
    className: "riot-select",
    attrs: { "data-riot-platform": "true", "aria-label": "Plateforme Riot" },
  });
  const platformError = el("p", { className: "riot-platforms-error" });
  platformError.hidden = true;
  const platformsRetry = el("button", {
    className: "btn btn-ghost",
    text: "Recharger les plateformes",
    attrs: { type: "button" },
  });
  platformsRetry.hidden = true;

  const idField = el("label", { className: "riot-field" });
  append(idField, el("span", { className: "riot-field-label", text: "Riot ID" }), idInput);
  const platformField = el("label", { className: "riot-field" });
  append(
    platformField,
    el("span", { className: "riot-field-label", text: "Plateforme" }),
    platformSelect,
  );
  const formGrid = el("div", { className: "riot-form-grid" });
  append(formGrid, idField, platformField);

  const loadLabel = el("span", { className: "btn-label", text: "Charger le profil" });
  const loadButton = el("button", {
    className: "btn btn-primary",
    attrs: { type: "button", "data-riot-load": "true" },
  });
  append(loadButton, icon("search", 15), loadLabel);

  const refreshLabel = el("span", { className: "btn-label", text: "Rafraîchir" });
  const refreshButton = el("button", {
    className: "btn",
    attrs: { type: "button", "data-riot-refresh": "true" },
  });
  append(refreshButton, icon("sync", 15), refreshLabel);
  refreshButton.hidden = true;

  const formErrorElement = el("p", { className: "riot-form-error" });
  formErrorElement.hidden = true;
  const formActions = el("div", { className: "riot-form-actions" });
  append(formActions, loadButton, refreshButton);

  const formCard = el("section", { className: "profile-card" });
  append(
    formCard,
    el("h2", { className: "detail-section-title", text: "Profil Riot" }),
    formGrid,
    platformError,
    platformsRetry,
    formErrorElement,
    formActions,
  );

  const resultHost = el("div", { className: "profile-result" });

  // Section « Progression personnelle » (V0.6), affichée sous le profil chargé.
  const progressionBody = el("div", { className: "progression-body" });
  const progressionLoadLabel = el("span", {
    className: "btn-label",
    text: "Analyser ma progression (50 derniers matchs)",
  });
  const progressionLoadButton = el("button", {
    className: "btn btn-primary",
    attrs: { type: "button", "data-progression-load": "true" },
  });
  append(progressionLoadButton, icon("sync", 15), progressionLoadLabel);

  const progressionRefreshLabel = el("span", {
    className: "btn-label",
    text: "Rafraîchir",
  });
  const progressionRefreshButton = el("button", {
    className: "btn",
    attrs: { type: "button", "data-progression-refresh": "true" },
  });
  append(progressionRefreshButton, icon("sync", 15), progressionRefreshLabel);
  progressionRefreshButton.hidden = true;

  const progressionActions = el("div", { className: "progression-actions" });
  append(progressionActions, progressionLoadButton, progressionRefreshButton);

  const progressionSection = el("section", {
    className: "profile-section progression-section",
    attrs: { "data-progression": "true" },
  });
  append(
    progressionSection,
    el("h3", { className: "profile-section-title", text: "Progression personnelle" }),
    progressionActions,
    progressionBody,
  );
  progressionSection.hidden = true;

  const layout = el("div", { className: "profile-layout" });
  append(layout, keyCard, formCard, resultHost, progressionSection);

  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "view view--profile",
    attrs: {
      role: "tabpanel",
      id: panelId("profile"),
      "data-view": "profile",
      "aria-labelledby": tabId("profile"),
    },
  });
  append(element, head, layout, announcer);
  element.hidden = true;

  // --- Clé API ----------------------------------------------------------
  function applyKeyUi(): void {
    if (keyStatusError !== null) {
      keyBadge.textContent = "État de la clé indisponible";
      keyBadge.setAttribute("data-state", "error");
      keySource.textContent = keyStatusError;
      keyRetry.hidden = false;
    } else if (keyStatus === null) {
      keyBadge.textContent = "Vérification…";
      keyBadge.setAttribute("data-state", "unknown");
      keySource.textContent = "Lecture de l'état de la clé API…";
      keyRetry.hidden = true;
    } else if (keyStatus.configured) {
      const viaEnvironment = keyStatus.source === "environment";
      keyBadge.textContent = "Clé configurée";
      keyBadge.setAttribute("data-state", "configured");
      keySource.textContent = viaEnvironment
        ? "Clé fournie par l'environnement (non supprimable depuis l'application)."
        : "Clé enregistrée localement (hors dépôt). Elle n'est jamais réaffichée.";
      keyRetry.hidden = true;
    } else {
      keyBadge.textContent = "Aucune clé configurée";
      keyBadge.setAttribute("data-state", "absent");
      keySource.textContent = "Une clé est nécessaire pour interroger l'API Riot.";
      keyRetry.hidden = true;
    }

    const configured = keyStatus !== null && keyStatus.configured;
    const viaEnvironment = keyStatus?.source === "environment";
    keyInput.hidden = configured;
    keySave.hidden = configured;
    keyClear.hidden = !(configured && !viaEnvironment);
    keyInput.disabled = keyBusy;
    keySave.disabled = keyBusy;
    keyClear.disabled = keyBusy;
    saveLabel.textContent = keyBusy ? "Enregistrement…" : "Enregistrer la clé";
    clearLabel.textContent = keyBusy ? "Suppression…" : "Supprimer la clé locale";

    keyError.hidden = keyErrorText === null;
    if (keyErrorText !== null) {
      keyError.textContent = keyErrorText;
    }
  }

  async function fetchKeyStatus(): Promise<void> {
    keyStatusError = null;
    applyKeyUi();
    try {
      keyStatus = await api.getRiotKeyStatus();
    } catch (error) {
      keyStatus = null;
      keyStatusError = errorMessage(error);
    }
    applyKeyUi();
  }

  async function saveKey(): Promise<void> {
    if (keyBusy) {
      return;
    }
    const value = keyInput.value.trim();
    if (value === "") {
      keyErrorText = "Saisissez une clé API Riot.";
      applyKeyUi();
      return;
    }
    keyBusy = true;
    keyErrorText = null;
    applyKeyUi();
    try {
      keyStatus = await api.setRiotApiKey(value);
      keyInput.value = "";
      announcer.textContent = "Clé API Riot enregistrée localement.";
    } catch (error) {
      keyErrorText = errorMessage(error);
      announcer.textContent = `Enregistrement de la clé impossible. ${keyErrorText}`;
    } finally {
      keyBusy = false;
      applyKeyUi();
    }
  }

  async function clearKey(): Promise<void> {
    if (keyBusy) {
      return;
    }
    keyBusy = true;
    keyErrorText = null;
    applyKeyUi();
    try {
      keyStatus = await api.clearRiotApiKey();
      announcer.textContent = "Clé API Riot locale supprimée.";
    } catch (error) {
      keyErrorText = errorMessage(error);
      announcer.textContent = `Suppression de la clé impossible. ${keyErrorText}`;
    } finally {
      keyBusy = false;
      applyKeyUi();
    }
  }

  function focusKeyInput(): void {
    if (!keyInput.hidden) {
      keyInput.focus();
      return;
    }
    keyClear.focus();
  }

  // --- Plateformes ------------------------------------------------------
  function renderPlatformOptions(): void {
    if (platforms.length === 0) {
      replaceContent(
        platformSelect,
        el("option", {
          text: "Plateformes indisponibles",
          attrs: { value: "" },
        }),
      );
      return;
    }
    const options = platforms.map((platform) =>
      el("option", { text: platform.label, attrs: { value: platform.id } }),
    );
    replaceContent(platformSelect, ...options);
    const preferred = platforms.find((platform) => platform.id === "EUW1") ?? platforms[0];
    if (preferred !== undefined) {
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
      renderPlatformOptions();
      platformsError = errorMessage(error);
    } finally {
      platformsBusy = false;
      applyPlatformsUi();
    }
  }

  // --- Formulaire -------------------------------------------------------
  function applyFormUi(): void {
    loadButton.disabled = profileState === "loading";
    refreshButton.disabled = profileState === "loading";
    loadLabel.textContent = profileState === "loading" ? "Chargement…" : "Charger le profil";
    refreshLabel.textContent = profileState === "loading" ? "Rafraîchissement…" : "Rafraîchir";
    refreshButton.hidden = profile === null;
    formErrorElement.hidden = formError === null;
    if (formError !== null) {
      formErrorElement.textContent = formError;
    }
  }

  function showFormError(message: string): void {
    formError = message;
    applyFormUi();
  }

  // --- Résultat ---------------------------------------------------------
  function buildIdlePanel(): HTMLElement {
    const container = el("div", { className: "profile-empty" });
    append(
      container,
      el("p", { className: "profile-empty-title", text: "Aucun profil chargé" }),
      el("p", {
        className: "profile-empty-message",
        text: "Renseignez votre Riot ID, choisissez une plateforme puis cliquez sur « Charger le profil ».",
      }),
    );
    return container;
  }

  function buildNoKeyPanel(): HTMLElement {
    const container = el("div", { className: "profile-empty profile-empty--warning" });
    append(
      container,
      el("p", { className: "profile-empty-title", text: "Aucune clé API Riot configurée" }),
      el("p", {
        className: "profile-empty-message",
        text: "Une clé de développement Riot est nécessaire pour charger un profil. Renseignez-la dans le bloc « Clé API Riot » ci-dessus (developer.riotgames.com).",
      }),
    );
    const action = el("button", {
      className: "btn btn-primary",
      text: "Configurer la clé API",
      attrs: { type: "button" },
    });
    action.addEventListener("click", focusKeyInput);
    container.appendChild(action);
    return container;
  }

  function buildLoadingPanel(): HTMLElement {
    const container = el("div", { className: "profile-loading" });
    const line = el("div", { className: "loading-line" });
    append(
      line,
      el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "loading-text", text: loadingMessage }),
    );
    container.appendChild(line);
    return container;
  }

  function buildRanks(ranks: readonly RiotLeagueEntry[]): HTMLElement {
    const container = el("div", {
      className: "riot-ranks",
      attrs: { "data-riot-ranks": "true" },
    });
    const byQueue = new Map<string, RiotLeagueEntry>();
    for (const entry of ranks) {
      byQueue.set(entry.queueType, entry);
    }
    const queues: string[] = [...KNOWN_RANK_QUEUES];
    for (const entry of ranks) {
      if (!queues.includes(entry.queueType)) {
        queues.push(entry.queueType);
      }
    }

    for (const queueType of queues) {
      const entry = byQueue.get(queueType) ?? null;
      const card = el("article", {
        className: entry === null ? "riot-rank-card riot-rank-card--empty" : "riot-rank-card",
        attrs: { "data-riot-rank": queueType },
      });
      card.appendChild(
        el("span", { className: "riot-rank-queue", text: riotQueueTypeLabel(queueType) }),
      );
      if (entry === null) {
        append(
          card,
          el("span", {
            className: "riot-rank-tier riot-rank-tier--empty",
            text: EMPTY_VALUE,
          }),
          el("span", { className: "riot-rank-lp", text: EMPTY_VALUE }),
          el("p", {
            className: "riot-rank-empty",
            text: "Aucun classement pour cette file",
          }),
        );
      } else {
        append(
          card,
          el("span", {
            className: "riot-rank-tier",
            text: riotRankLabel(entry.tier, entry.rank),
          }),
          el("span", {
            className: "riot-rank-lp",
            text: `${riotNumber(entry.leaguePoints)} LP`,
          }),
          el("span", {
            className: "riot-rank-record",
            text: `${riotNumber(entry.wins)} V / ${riotNumber(entry.losses)} D`,
          }),
        );
      }
      container.appendChild(card);
    }
    return container;
  }

  function buildChampionIcon(championName: string): HTMLElement {
    const wrapper = el("span", { className: "riot-match-champion-icon-wrap" });
    const iconPath = championName.trim() === "" ? null : options.getChampionIconPath(championName);
    if (iconPath !== null && iconPath.trim() !== "") {
      const image = el("img", {
        className: "riot-match-champion-icon",
        attrs: {
          alt: championName,
          loading: "lazy",
          decoding: "async",
          draggable: "false",
          width: "40",
          height: "40",
        },
      });
      image.src = api.assetUrl(iconPath);
      image.addEventListener("error", () => {
        image.replaceWith(
          buildIconPlaceholder("riot-match-champion-icon riot-match-champion-icon--placeholder"),
        );
      });
      wrapper.appendChild(image);
    } else {
      wrapper.appendChild(
        buildIconPlaceholder("riot-match-champion-icon riot-match-champion-icon--placeholder"),
      );
    }
    return wrapper;
  }

  function buildMatchCard(match: RiotMatchSummary, playerPuuid: string): HTMLButtonElement {
    const championName = typeof match.championName === "string" ? match.championName : "";
    const card = el("button", {
      className: "riot-match",
      attrs: {
        type: "button",
        "data-riot-match": "true",
        "data-match-id": match.matchId,
        "aria-label": `Ouvrir le détail du match ${match.matchId}`,
      },
    });
    if (typeof match.win === "boolean") {
      card.setAttribute("data-win", match.win ? "true" : "false");
    }

    const iconWrapper = buildChampionIcon(championName);
    const body = el("span", { className: "riot-match-body" });

    const head = el("span", { className: "riot-match-head" });
    append(
      head,
      el("span", {
        className: "riot-match-champion-name",
        text: championName.trim() === "" ? EMPTY_VALUE : championName,
      }),
      el("span", {
        className: "riot-match-result",
        text: riotResultLabel(match.win),
      }),
    );

    const stats = el("span", { className: "riot-match-stats" });
    append(
      stats,
      el("span", {
        className: "riot-match-kda",
        text: kdaText(match.kills, match.deaths, match.assists),
        attrs: { title: "Kills / Morts / Passes décisives" },
      }),
      el("span", {
        className: "riot-match-cs",
        text: `${riotNumber(match.cs)} CS`,
        attrs: { title: "Sbires + monstres neutres" },
      }),
      el("span", {
        className: "riot-match-vision",
        text: `${riotNumber(match.visionScore)} vision`,
        attrs: { title: "Score de vision" },
      }),
    );

    const meta = el("span", { className: "riot-match-meta" });
    append(
      meta,
      el("span", {
        className: "riot-match-duration",
        text: formatDuration(match.durationSecs),
      }),
      el("span", {
        className: "riot-match-queue",
        text: riotQueueLabel(match.queueId),
      }),
    );

    append(body, head, stats, meta);
    append(card, iconWrapper, body);
    card.addEventListener("click", () => {
      options.onOpenMatch(match.matchId, playerPuuid, card);
    });
    return card;
  }

  function buildMatches(profileData: RiotProfile): HTMLElement {
    const container = el("div", {
      className: "riot-matches",
      attrs: { "data-riot-matches": "true" },
    });
    const matches = Array.isArray(profileData.matches)
      ? profileData.matches.slice(0, MAX_MATCHES)
      : [];
    if (matches.length === 0) {
      append(
        container,
        el("p", { className: "profile-empty-value", text: EMPTY_VALUE }),
        el("p", {
          className: "detail-empty-hint",
          text: "Aucun match récent fourni par Riot.",
        }),
      );
      return container;
    }
    for (const match of matches) {
      container.appendChild(buildMatchCard(match, profileData.puuid));
    }
    return container;
  }

  function platformLabelText(profileData: RiotProfile): string {
    const platformId = typeof profileData.platform === "string" ? profileData.platform : "";
    const known = platforms.find((platform) => platform.id === platformId);
    if (known !== undefined) {
      return `${known.label} (${platformId})`;
    }
    return platformId.trim() === "" ? EMPTY_VALUE : platformId;
  }

  function buildProfileContent(profileData: RiotProfile): HTMLElement {
    const container = el("div", { className: "profile-content" });

    const gameName = typeof profileData.gameName === "string" ? profileData.gameName.trim() : "";
    const tagLine = typeof profileData.tagLine === "string" ? profileData.tagLine.trim() : "";
    const identityName =
      gameName === "" && tagLine === ""
        ? EMPTY_VALUE
        : `${gameName}${tagLine === "" ? "" : `#${tagLine}`}`.trim();

    const identity = el("header", { className: "profile-identity" });
    const identityText = el("div", { className: "profile-identity-text" });
    append(
      identityText,
      el("h2", { className: "riot-profile-name", text: identityName }),
      el("p", {
        className: "riot-profile-platform",
        text: platformLabelText(profileData),
      }),
    );

    const cache = el("div", { className: "riot-cache" });
    append(
      cache,
      el("span", {
        className: "riot-cache-indicator",
        text: profileData.fromCache ? "Données en cache" : "Données réseau",
        attrs: { "data-cache": profileData.fromCache ? "true" : "false" },
      }),
      el("span", {
        className: "riot-cache-date",
        text: `Récupérées le ${formatDateTime(
          typeof profileData.fetchedAt === "string" ? profileData.fetchedAt : null,
        )}`,
      }),
    );

    append(identity, identityText, cache);
    container.appendChild(identity);

    const warning =
      typeof profileData.warning === "string" && profileData.warning.trim() !== ""
        ? profileData.warning
        : null;
    if (warning !== null) {
      const warningBox = el("div", {
        className: "profile-warning",
        attrs: { role: "status" },
      });
      const warningIcon = el("span", { className: "profile-warning-icon", attrs: { "aria-hidden": "true" } });
      warningIcon.appendChild(icon("alert", 15));
      append(
        warningBox,
        warningIcon,
        el("span", { className: "profile-warning-text", text: warning }),
      );
      container.appendChild(warningBox);
    }

    const ranksSection = el("section", { className: "profile-section" });
    ranksSection.appendChild(
      el("h3", { className: "profile-section-title", text: "Classements" }),
    );
    const ranks = Array.isArray(profileData.ranks) ? profileData.ranks : [];
    ranksSection.appendChild(buildRanks(ranks));
    container.appendChild(ranksSection);

    const matchesSection = el("section", { className: "profile-section" });
    const matchesHeader = el("div", { className: "profile-section-head" });
    append(
      matchesHeader,
      el("h3", { className: "profile-section-title", text: "10 derniers matchs" }),
      el("span", {
        className: "profile-section-count",
        text: `${matchesCountLabel(profileData.matches)}`,
      }),
    );
    matchesSection.appendChild(matchesHeader);
    matchesSection.appendChild(buildMatches(profileData));
    container.appendChild(matchesSection);

    return container;
  }

  function matchesCountLabel(matches: unknown): string {
    if (!Array.isArray(matches)) {
      return EMPTY_VALUE;
    }
    const total = matches.length;
    return `${total} affiché${total > 1 ? "s" : ""}`;
  }

  // --- Progression personnelle (V0.6) ----------------------------------
  function progressCount(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value)
      ? formatCount(value)
      : EMPTY_VALUE;
  }

  function progressDecimal(value: unknown): string {
    return typeof value === "number" && Number.isFinite(value)
      ? formatDecimal(value)
      : EMPTY_VALUE;
  }

  function progressionPlatformLabel(platform: string): string {
    const known = platforms.find((entry) => entry.id === platform);
    return known === undefined ? platform : `${known.label} (${platform})`;
  }

  function buildProgressionChampionIcon(championName: string): HTMLElement {
    const wrapper = el("span", { className: "progression-champion-icon-wrap" });
    const iconPath =
      championName.trim() === "" ? null : options.getChampionIconPath(championName);
    if (iconPath !== null && iconPath.trim() !== "") {
      const image = el("img", {
        className: "progression-champion-icon",
        attrs: {
          alt: championName,
          loading: "lazy",
          decoding: "async",
          draggable: "false",
          width: "26",
          height: "26",
        },
      });
      image.src = api.assetUrl(iconPath);
      image.addEventListener("error", () => {
        image.replaceWith(
          buildIconPlaceholder(
            "progression-champion-icon progression-champion-icon--placeholder",
          ),
        );
      });
      wrapper.appendChild(image);
    } else {
      wrapper.appendChild(
        buildIconPlaceholder(
          "progression-champion-icon progression-champion-icon--placeholder",
        ),
      );
    }
    return wrapper;
  }

  function buildProgressionStat(
    label: string,
    value: string,
    extraClass = "",
  ): HTMLElement {
    const stat = el("div", { className: "progression-stat" });
    append(
      stat,
      el("span", { className: "progression-stat-label", text: label }),
      el("span", {
        className: extraClass === "" ? "progression-stat-value" : `progression-stat-value ${extraClass}`,
        text: value,
      }),
    );
    return stat;
  }

  function buildProgressionOverall(progressionData: RiotProgression): HTMLElement {
    const overall = progressionData.overall;
    const container = el("div", {
      className: "progression-overall",
      attrs: { "data-progression-overall": "true" },
    });
    if (overall === null || typeof overall !== "object") {
      container.appendChild(el("p", { className: "profile-empty-value", text: EMPTY_VALUE }));
      return container;
    }
    append(
      container,
      buildProgressionStat("Parties", progressCount(overall.games)),
      buildProgressionStat(
        "Victoires / Défaites",
        `${progressCount(overall.wins)} V / ${progressCount(overall.losses)} D`,
      ),
      buildProgressionStat(
        "Taux de victoire",
        formatRate(overall.winRate),
        "progression-winrate",
      ),
      buildProgressionStat("KDA", progressDecimal(overall.kda)),
      buildProgressionStat("CS / partie", progressDecimal(overall.csPerGame)),
      buildProgressionStat("Vision / partie", progressDecimal(overall.visionPerGame)),
    );
    return container;
  }

  function buildProgressionChampions(progressionData: RiotProgression): HTMLElement {
    const block = el("div", { className: "progression-table-block" });
    block.appendChild(
      el("h4", { className: "progression-table-title", text: "Par champion" }),
    );
    const champions = Array.isArray(progressionData.byChampion)
      ? progressionData.byChampion
      : [];
    if (champions.length === 0) {
      append(
        block,
        el("p", { className: "profile-empty-value", text: EMPTY_VALUE }),
        el("p", {
          className: "detail-empty-hint",
          text: "Aucune donnée par champion fournie par le backend.",
        }),
      );
      return block;
    }
    const head = el("div", {
      className: "progression-row progression-row--champion progression-row--head",
    });
    append(
      head,
      el("span", { className: "progression-head", text: "" }),
      el("span", { className: "progression-head", text: "Champion" }),
      el("span", { className: "progression-head", text: "Parties" }),
      el("span", { className: "progression-head", text: "Win" }),
      el("span", { className: "progression-head", text: "KDA" }),
      el("span", { className: "progression-head", text: "CS/moy" }),
      el("span", { className: "progression-head", text: "Vision" }),
    );
    block.appendChild(head);

    for (const champion of champions) {
      const row = el("div", {
        className: "progression-row progression-row--champion",
        attrs: { "data-progression-champion": "true" },
      });
      const championName =
        typeof champion.championName === "string" ? champion.championName : "";
      append(
        row,
        buildProgressionChampionIcon(championName),
        el("span", {
          className: "progression-champion-name",
          text: championName.trim() === "" ? EMPTY_VALUE : champion.championName,
        }),
        el("span", { className: "progression-value", text: progressCount(champion.games) }),
        el("span", {
          className: "progression-value progression-winrate",
          text: formatRate(champion.winRate),
        }),
        el("span", { className: "progression-value", text: progressDecimal(champion.kda) }),
        el("span", { className: "progression-value", text: progressDecimal(champion.csPerGame) }),
        el("span", {
          className: "progression-value",
          text: progressDecimal(champion.visionPerGame),
        }),
      );
      block.appendChild(row);
    }
    return block;
  }

  function buildProgressionRoles(progressionData: RiotProgression): HTMLElement {
    const block = el("div", { className: "progression-table-block" });
    block.appendChild(el("h4", { className: "progression-table-title", text: "Par rôle" }));
    const roles = Array.isArray(progressionData.byRole) ? progressionData.byRole : [];
    if (roles.length === 0) {
      append(
        block,
        el("p", { className: "profile-empty-value", text: EMPTY_VALUE }),
        el("p", {
          className: "detail-empty-hint",
          text: "Aucune donnée par rôle fournie par le backend.",
        }),
      );
      return block;
    }
    const head = el("div", {
      className: "progression-row progression-row--role progression-row--head",
    });
    append(
      head,
      el("span", { className: "progression-head", text: "Rôle" }),
      el("span", { className: "progression-head", text: "Parties" }),
      el("span", { className: "progression-head", text: "Win" }),
      el("span", { className: "progression-head", text: "KDA" }),
    );
    block.appendChild(head);

    for (const role of roles) {
      const row = el("div", {
        className: "progression-row progression-row--role",
        attrs: { "data-progression-role": "true" },
      });
      append(
        row,
        el("span", {
          className: "progression-role-name",
          text: riotPositionLabel(role.position),
        }),
        el("span", { className: "progression-value", text: progressCount(role.games) }),
        el("span", {
          className: "progression-value progression-winrate",
          text: formatRate(role.winRate),
        }),
        el("span", { className: "progression-value", text: progressDecimal(role.kda) }),
      );
      block.appendChild(row);
    }
    return block;
  }

  function buildProgressionContent(progressionData: RiotProgression): HTMLElement {
    const container = el("div", { className: "progression-content" });
    container.appendChild(buildProgressionOverall(progressionData));

    const server = el("div", { className: "progression-server" });
    append(
      server,
      el("span", {
        className: "progression-server-label",
        text: `Win rate serveur — ${progressionPlatformLabel(progressionData.platform)}`,
      }),
      el("span", {
        className: "progression-server-value",
        text: `${formatRate(progressionData.serverWinRate)} sur ${progressCount(
          progressionData.serverGames,
        )} parties`,
      }),
    );
    container.appendChild(server);

    const cache = el("p", {
      className: "progression-cache",
      text: `${progressionData.fromCache ? "Données en cache" : "Données réseau"} · récupérées le ${formatDateTime(
        typeof progressionData.fetchedAt === "string" ? progressionData.fetchedAt : null,
      )} · ${progressCount(progressionData.matchesAnalyzed)} matchs analysés sur ${progressCount(
        progressionData.matchesRequested,
      )}`,
    });
    container.appendChild(cache);

    const warning =
      typeof progressionData.warning === "string" &&
      progressionData.warning.trim() !== ""
        ? progressionData.warning
        : null;
    if (warning !== null) {
      container.appendChild(
        el("p", { className: "progression-warning", text: warning, attrs: { role: "status" } }),
      );
    }

    container.appendChild(buildProgressionChampions(progressionData));
    container.appendChild(buildProgressionRoles(progressionData));
    return container;
  }

  function buildProgressionLoading(): HTMLElement {
    const container = el("div", { className: "profile-loading" });
    const line = el("div", { className: "loading-line" });
    append(
      line,
      el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "loading-text", text: progressionMessage }),
    );
    container.appendChild(line);
    return container;
  }

  function renderProgression(): void {
    const visible = profile !== null && profileState === "idle";
    progressionSection.hidden = !visible;
    if (!visible) {
      return;
    }
    const loading = progressionState === "loading";
    progressionLoadButton.disabled = loading;
    progressionRefreshButton.disabled = loading;
    progressionRefreshButton.hidden = progression === null;
    progressionLoadLabel.textContent = loading
      ? "Analyse en cours…"
      : "Analyser ma progression (50 derniers matchs)";

    switch (progressionState) {
      case "loading":
        replaceContent(progressionBody, buildProgressionLoading());
        break;
      case "error":
        replaceContent(
          progressionBody,
          buildPanelState({
            tone: "error",
            title: progressionError?.title ?? "Analyse de la progression impossible",
            message: progressionError?.message ?? "Erreur inconnue.",
            actionLabel: "Réessayer",
            onAction: () => {
              void loadProgression(progressionForce);
            },
            iconName: "alert",
          }),
        );
        break;
      case "ready":
        replaceContent(
          progressionBody,
          progression === null
            ? el("p", { className: "profile-empty-value", text: EMPTY_VALUE })
            : buildProgressionContent(progression),
        );
        break;
      case "idle":
        replaceContent(
          progressionBody,
          el("p", {
            className: "profile-empty-message",
            text: "Lancez l'analyse pour agréger vos 50 derniers matchs (Riot API, clé requise).",
          }),
        );
        break;
    }
  }

  async function loadProgression(forceRefresh: boolean): Promise<void> {
    if (progressionState === "loading" || profile === null) {
      return;
    }
    progressionForce = forceRefresh;

    const gameName = typeof profile.gameName === "string" ? profile.gameName.trim() : "";
    const tagLine = typeof profile.tagLine === "string" ? profile.tagLine.trim() : "";
    if (gameName === "" || tagLine === "") {
      progressionState = "error";
      progressionError = {
        title: "Riot ID incomplet",
        message: "Le profil chargé ne contient pas un Riot ID complet (Nom#TAG).",
      };
      renderProgression();
      return;
    }
    if (keyStatusError !== null) {
      progressionState = "error";
      progressionError = {
        title: "État de la clé API Riot indisponible",
        message: keyStatusError,
      };
      renderProgression();
      return;
    }
    if (keyStatus === null || !keyStatus.configured) {
      progressionState = "error";
      progressionError = {
        title: "Clé API Riot absente",
        message:
          "Une clé API Riot est nécessaire pour analyser la progression (50 derniers matchs).",
      };
      renderProgression();
      announcer.textContent = progressionError.message;
      return;
    }

    const token = progressionRequest + 1;
    progressionRequest = token;
    progressionState = "loading";
    progressionMessage = forceRefresh
      ? "Rafraîchissement de la progression…"
      : "Analyse des 50 derniers matchs…";
    renderProgression();
    announcer.textContent = progressionMessage;

    try {
      const loaded = await api.getRiotProgression(
        `${gameName}#${tagLine}`,
        profile.platform,
        forceRefresh,
      );
      if (progressionRequest !== token) {
        return;
      }
      progression = loaded;
      progressionState = "ready";
      progressionError = null;
      renderProgression();
      announcer.textContent = `Progression analysée sur ${formatCount(
        loaded.matchesAnalyzed,
      )} matchs.`;
    } catch (error) {
      if (progressionRequest !== token) {
        return;
      }
      progression = null;
      progressionState = "error";
      progressionError = classifyProfileError(errorMessage(error));
      renderProgression();
      announcer.textContent = `${progressionError.title}. ${progressionError.message}`;
    }
  }

  function buildErrorPanel(error: ProfileError): HTMLElement {
    const panel = buildPanelState({
      tone: "error",
      title: error.title,
      message: error.message,
      actionLabel: "Réessayer",
      onAction: () => {
        void loadProfile(lastForceRefresh);
      },
      iconName: "alert",
    });
    return panel;
  }

  function renderResult(): void {
    switch (profileState) {
      case "loading":
        replaceContent(resultHost, buildLoadingPanel());
        break;
      case "no-key":
        replaceContent(resultHost, buildNoKeyPanel());
        break;
      case "error":
        replaceContent(resultHost, buildErrorPanel(profileError ?? classifyProfileError("Erreur inconnue.")));
        break;
      case "idle":
        replaceContent(resultHost, profile === null ? buildIdlePanel() : buildProfileContent(profile));
        break;
    }
    renderProgression();
  }

  // --- Chargement du profil --------------------------------------------
  async function loadProfile(forceRefresh: boolean): Promise<void> {
    if (profileState === "loading") {
      return;
    }
    formError = null;
    lastForceRefresh = forceRefresh;

    const riotId = idInput.value.trim();
    const platform = platformSelect.value;
    const validation = validateRiotId(riotId);
    if (validation !== null) {
      showFormError(validation);
      idInput.focus();
      return;
    }
    if (platform === "") {
      showFormError("Sélectionnez une plateforme Riot.");
      platformSelect.focus();
      return;
    }

    if (keyStatusError !== null) {
      profileState = "error";
      profileError = {
        title: "État de la clé API Riot indisponible",
        message: keyStatusError,
      };
      applyFormUi();
      renderResult();
      announcer.textContent = profileError.message;
      return;
    }
    if (keyStatus !== null && !keyStatus.configured) {
      profileState = "no-key";
      profileError = null;
      applyFormUi();
      renderResult();
      announcer.textContent =
        "Aucune clé API Riot configurée : le profil ne peut pas être chargé.";
      focusKeyInput();
      return;
    }

    profileState = "loading";
    loadingMessage = forceRefresh
      ? "Rafraîchissement du profil Riot…"
      : "Chargement du profil Riot…";
    applyFormUi();
    renderResult();
    announcer.textContent = loadingMessage;

    try {
      const loaded = await api.getRiotProfile(riotId, platform, forceRefresh);
      profile = loaded;
      profileState = "idle";
      profileError = null;
      // Nouveau profil : la progression précédente ne s'applique plus.
      progression = null;
      progressionState = "idle";
      progressionError = null;
      progressionRequest += 1;
      applyFormUi();
      renderResult();
      announcer.textContent = `Profil chargé : ${loaded.gameName}#${loaded.tagLine}.`;
    } catch (error) {
      profileState = "error";
      profileError = classifyProfileError(errorMessage(error));
      applyFormUi();
      renderResult();
      announcer.textContent = `${profileError.title}. ${profileError.message}`;
    }
  }

  // --- Événements -------------------------------------------------------
  keySave.addEventListener("click", () => {
    void saveKey();
  });
  keyClear.addEventListener("click", () => {
    void clearKey();
  });
  keyRetry.addEventListener("click", () => {
    void fetchKeyStatus();
  });
  platformsRetry.addEventListener("click", () => {
    void fetchPlatforms();
  });
  keyInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void saveKey();
    }
  });
  idInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void loadProfile(false);
    }
  });
  loadButton.addEventListener("click", () => {
    void loadProfile(false);
  });
  refreshButton.addEventListener("click", () => {
    void loadProfile(true);
  });
  progressionLoadButton.addEventListener("click", () => {
    void loadProgression(false);
  });
  progressionRefreshButton.addEventListener("click", () => {
    void loadProgression(true);
  });

  // --- Initialisation ---------------------------------------------------
  applyKeyUi();
  applyPlatformsUi();
  applyFormUi();
  renderResult();
  void fetchKeyStatus();
  void fetchPlatforms();

  return {
    element,
    refreshChampionIcons: () => {
      if (profile !== null && profileState === "idle") {
        renderResult();
      }
    },
    refreshKeyStatus: () => {
      void fetchKeyStatus();
    },
  };
}
