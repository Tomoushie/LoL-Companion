/**
 * Vue « Fiche de match » Riot API (V0.5).
 *
 * Chargée à la demande via `api.getRiotMatch(matchId)` (cache backend). Affiche
 * le résultat du joueur consulté, les métadonnées réelles et les deux équipes
 * (10 participants) avec icônes de champions locales. Aucune valeur inventée :
 * champs absents → « — », erreurs backend réelles.
 */

import { api } from "../api";
import { buildPanelState } from "../components/states";
import type { RiotMatchDetail, RiotMatchParticipant } from "../types";
import { append, el, replaceContent } from "../ui/dom";
import { EMPTY_VALUE, errorMessage } from "../ui/format";
import { icon } from "../ui/icons";
import {
  formatDuration,
  formatMatchDate,
  riotNumber,
  riotQueueLabel,
  riotResultLabel,
} from "../ui/riot-labels";

export interface RiotMatchDetailViewOptions {
  readonly onClose: () => void;
  /** Chemin local de l'icône d'un champion, résolu depuis la liste chargée. */
  readonly getChampionIconPath: (championName: string) => string | null;
}

export interface RiotMatchDetailViewHandle {
  readonly element: HTMLElement;
  load(matchId: string, playerPuuid: string | null): void;
  clear(): void;
  focusBackButton(): void;
  /** Re-rend les icônes de champions quand la liste locale a changé. */
  refreshChampionIcons(): void;
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

function textOrEmpty(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : EMPTY_VALUE;
}

function buildIconPlaceholder(className: string): HTMLElement {
  return el("span", {
    className,
    text: EMPTY_VALUE,
    attrs: { "aria-hidden": "true", title: "Icône non disponible dans le cache local" },
  });
}

export function createRiotMatchDetailView(
  options: RiotMatchDetailViewOptions,
): RiotMatchDetailViewHandle {
  const backButton = el("button", {
    className: "btn btn-ghost detail-back",
    attrs: {
      type: "button",
      "data-action": "back-match",
      title: "Revenir au profil",
    },
  });
  append(
    backButton,
    icon("arrowLeft", 15),
    el("span", { className: "btn-label", text: "Retour au profil" }),
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
    className: "view view--riot-match-detail",
    attrs: {
      id: "view-riot-match-detail",
      "data-view": "riot-match-detail",
      "aria-label": "Fiche de match Riot",
      role: "region",
    },
  });
  append(element, topbar, content, announcer);
  element.hidden = true;

  let requestToken = 0;
  let currentMatchId: string | null = null;
  let currentPlayerPuuid: string | null = null;
  let lastDetail: RiotMatchDetail | null = null;

  function buildChampionIcon(championName: string): HTMLElement {
    const wrapper = el("span", { className: "riot-participant-champion-icon-wrap" });
    const iconPath =
      championName.trim() === "" ? null : options.getChampionIconPath(championName);
    if (iconPath !== null && iconPath.trim() !== "") {
      const image = el("img", {
        className: "riot-participant-champion-icon",
        attrs: {
          alt: championName,
          loading: "lazy",
          decoding: "async",
          draggable: "false",
          width: "36",
          height: "36",
        },
      });
      image.src = api.assetUrl(iconPath);
      image.addEventListener("error", () => {
        image.replaceWith(
          buildIconPlaceholder(
            "riot-participant-champion-icon riot-participant-champion-icon--placeholder",
          ),
        );
      });
      wrapper.appendChild(image);
    } else {
      wrapper.appendChild(
        buildIconPlaceholder(
          "riot-participant-champion-icon riot-participant-champion-icon--placeholder",
        ),
      );
    }
    return wrapper;
  }

  function buildHeaderRow(label: string, value: string): HTMLElement {
    const row = el("div", { className: "riot-match-header-row" });
    append(
      row,
      el("span", { className: "riot-match-header-label", text: label }),
      el("span", { className: "riot-match-header-value", text: value }),
    );
    return row;
  }

  function buildParticipantRow(
    participant: RiotMatchParticipant,
    playerPuuid: string | null,
  ): HTMLElement {
    const row = el("article", {
      className: "riot-participant",
      attrs: { "data-riot-participant": "true" },
    });
    if (playerPuuid !== null && participant.puuid === playerPuuid) {
      row.classList.add("riot-participant--self");
    }

    const championName =
      typeof participant.championName === "string" ? participant.championName : "";
    const identity = el("div", { className: "riot-participant-identity" });
    append(
      identity,
      el("span", {
        className: "riot-participant-name",
        text: textOrEmpty(participant.displayName),
      }),
      el("span", {
        className: "riot-participant-puuid",
        text: textOrEmpty(participant.puuid),
        attrs: { title: "PUUID Riot" },
      }),
      el("span", {
        className: "riot-participant-champion-name",
        text: championName.trim() === "" ? EMPTY_VALUE : championName,
      }),
    );

    append(
      row,
      buildChampionIcon(championName),
      identity,
      el("span", {
        className: "riot-participant-kda",
        text: kdaText(participant.kills, participant.deaths, participant.assists),
        attrs: { title: "Kills / Morts / Passes décisives" },
      }),
      el("span", {
        className: "riot-participant-cs",
        text: `${riotNumber(participant.cs)} CS`,
      }),
      el("span", {
        className: "riot-participant-vision",
        text: `${riotNumber(participant.visionScore)} vision`,
      }),
      el("span", {
        className: "riot-participant-position",
        text: textOrEmpty(participant.position),
      }),
    );
    return row;
  }

  function buildTeams(detail: RiotMatchDetail, playerPuuid: string | null): HTMLElement {
    const container = el("div", { className: "riot-teams" });
    const participants = Array.isArray(detail.participants) ? detail.participants : [];

    if (participants.length === 0) {
      append(
        container,
        el("p", { className: "detail-empty", text: EMPTY_VALUE }),
        el("p", {
          className: "detail-empty-hint",
          text: "Aucun participant fourni par Riot pour ce match.",
        }),
      );
      return container;
    }

    const winningTeam =
      typeof detail.winningTeam === "number" && Number.isFinite(detail.winningTeam)
        ? detail.winningTeam
        : null;

    const groups = new Map<number, RiotMatchParticipant[]>();
    for (const participant of participants) {
      const teamId =
        typeof participant.teamId === "number" && Number.isFinite(participant.teamId)
          ? participant.teamId
          : Number.NaN;
      const existing = groups.get(teamId);
      if (existing === undefined) {
        groups.set(teamId, [participant]);
      } else {
        existing.push(participant);
      }
    }

    const teamIds = [...groups.keys()].sort((a, b) => {
      if (Number.isNaN(a)) {
        return 1;
      }
      if (Number.isNaN(b)) {
        return -1;
      }
      return a - b;
    });

    for (const teamId of teamIds) {
      const teamParticipants = groups.get(teamId) ?? [];
      const teamSection = el("section", {
        className: "riot-team",
        attrs: {
          "data-team-id": Number.isNaN(teamId) ? "unknown" : String(teamId),
        },
      });

      const teamHead = el("header", { className: "riot-team-head" });
      append(
        teamHead,
        el("h3", {
          className: "riot-team-title",
          text: Number.isNaN(teamId) ? "Équipe —" : `Équipe ${teamId}`,
        }),
      );
      if (winningTeam !== null && !Number.isNaN(teamId) && winningTeam === teamId) {
        teamHead.appendChild(
          el("span", { className: "riot-team-win", text: "Équipe gagnante" }),
        );
      }
      teamSection.appendChild(teamHead);

      const list = el("div", { className: "riot-participant-list" });
      const headerRow = el("div", { className: "riot-participant-row riot-participant-row--head" });
      append(
        headerRow,
        el("span", { className: "riot-participant-head", text: "" }),
        el("span", { className: "riot-participant-head", text: "Joueur / champion" }),
        el("span", { className: "riot-participant-head", text: "KDA" }),
        el("span", { className: "riot-participant-head", text: "CS" }),
        el("span", { className: "riot-participant-head", text: "Vision" }),
        el("span", { className: "riot-participant-head", text: "Position" }),
      );
      list.appendChild(headerRow);
      for (const participant of teamParticipants) {
        list.appendChild(buildParticipantRow(participant, playerPuuid));
      }
      teamSection.appendChild(list);
      container.appendChild(teamSection);
    }

    return container;
  }

  function buildDetail(detail: RiotMatchDetail, playerPuuid: string | null): HTMLElement {
    const layout = el("div", { className: "riot-match-detail-layout" });

    const participants = Array.isArray(detail.participants) ? detail.participants : [];
    const player =
      playerPuuid === null
        ? null
        : participants.find((participant) => participant.puuid === playerPuuid) ?? null;

    const winningTeam =
      typeof detail.winningTeam === "number" && Number.isFinite(detail.winningTeam)
        ? detail.winningTeam
        : null;

    const header = el("header", { className: "profile-card riot-match-header" });
    header.appendChild(
      el("h2", { className: "detail-section-title", text: "Résumé du match" }),
    );

    const headline = el("div", { className: "riot-match-headline" });
    append(
      headline,
      el("span", {
        className: "riot-match-result",
        text: player === null ? EMPTY_VALUE : riotResultLabel(player.win),
      }),
      el("span", {
        className: "riot-match-headline-queue",
        text: riotQueueLabel(detail.queueId),
      }),
    );
    header.appendChild(headline);

    const grid = el("div", { className: "riot-match-header-grid" });
    append(
      grid,
      buildHeaderRow("Durée", formatDuration(detail.gameDurationSecs)),
      buildHeaderRow("File", riotQueueLabel(detail.queueId)),
      buildHeaderRow("Mode", textOrEmpty(detail.gameMode)),
      buildHeaderRow("Date", formatMatchDate(detail.gameCreationMs)),
      buildHeaderRow(
        "Équipe gagnante",
        winningTeam === null ? EMPTY_VALUE : `Équipe ${winningTeam}`,
      ),
    );
    header.appendChild(grid);
    layout.appendChild(header);

    layout.appendChild(buildTeams(detail, playerPuuid));
    return layout;
  }

  function renderLoading(): void {
    const container = el("div", { className: "profile-loading" });
    const line = el("div", { className: "loading-line" });
    append(
      line,
      el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
      el("span", { className: "loading-text", text: "Chargement de la fiche de match…" }),
    );
    container.appendChild(line);
    replaceContent(content, container);
    announcer.textContent = "Chargement de la fiche de match…";
  }

  function renderError(message: string, retry: () => void): void {
    replaceContent(
      content,
      buildPanelState({
        tone: "error",
        title: "Impossible de charger le match",
        message,
        actionLabel: "Réessayer",
        onAction: retry,
        iconName: "alert",
      }),
    );
    announcer.textContent = `Impossible de charger le match. ${message}`;
  }

  function load(matchId: string, playerPuuid: string | null): void {
    currentMatchId = matchId;
    currentPlayerPuuid = playerPuuid;
    const token = requestToken + 1;
    requestToken = token;
    lastDetail = null;
    renderLoading();

    void (async () => {
      try {
        const detail = await api.getRiotMatch(matchId);
        if (requestToken !== token) {
          return;
        }
        lastDetail = detail;
        replaceContent(content, buildDetail(detail, playerPuuid));
        announcer.textContent = `Match ${matchId} chargé.`;
      } catch (error) {
        if (requestToken !== token) {
          return;
        }
        const message = errorMessage(error);
        renderError(message, () => {
          if (currentMatchId !== null) {
            load(currentMatchId, currentPlayerPuuid);
          }
        });
      }
    })();
  }

  function clear(): void {
    requestToken += 1;
    currentMatchId = null;
    currentPlayerPuuid = null;
    lastDetail = null;
    replaceContent(content);
    announcer.textContent = "";
  }

  function focusBackButton(): void {
    backButton.focus();
  }

  function refreshChampionIcons(): void {
    if (lastDetail !== null) {
      replaceContent(content, buildDetail(lastDetail, currentPlayerPuuid));
    }
  }

  return { element, load, clear, focusBackButton, refreshChampionIcons };
}
