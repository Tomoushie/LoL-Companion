/**
 * Vue « Esport » (V1.0) : équipes et compétitions Riot Esports.
 *
 * Données réelles fournies par le backend (Riot Esports API publique) :
 * équipes actives (filtre par défaut), détail d'équipe avec joueurs, ligues,
 * tournois et classements. Les logos/photos sont des URLs distantes renvoyées
 * par le backend (CSP img-src dédiée) ; un échec de chargement affiche « — ».
 * Champs absents (âge, pays, langue, main dominante) → « — » + note explicite.
 */

import { api } from "../api";
import { buildPanelState } from "../components/states";
import type {
  EsportsLeague,
  EsportsPlayer,
  EsportsStanding,
  EsportsTeam,
  EsportsTeamDetail,
  EsportsTournament,
} from "../types";
import { append, el, replaceContent } from "../ui/dom";
import {
  EMPTY_VALUE,
  errorMessage,
  formatCount,
  formatDateTime,
  normalizeForSearch,
} from "../ui/format";
import { icon } from "../ui/icons";
import { riotPositionLabel } from "../ui/riot-labels";
import { panelId, tabId } from "../ui/view";

export interface EsportsViewHandle {
  readonly element: HTMLElement;
  /** Chargement paresseux à la première arrivée sur l'onglet. */
  onShown(): void;
}

type Subtab = "teams" | "competitions";
type LoadState = "idle" | "loading" | "ready" | "error";

const TEAMS_PAGE_SIZE = 60;

const MISSING_PLAYER_NOTE =
  "L'API Riot Esports ne fournit pas ces informations (âge, pays, langue, main dominante).";

const SOURCE_LABEL = "Riot Esports API";

function stringOrDash(value: unknown): string {
  return typeof value === "string" && value.trim() !== "" ? value : EMPTY_VALUE;
}

function countOrDash(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? formatCount(value) : EMPTY_VALUE;
}

function recordOrDash(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : EMPTY_VALUE;
}

const DATE_ONLY_FORMATTER = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short" });

/** Date seule (tournois) ; valeurs non standard affichées telles quelles. */
function formatDateOnly(iso: unknown): string {
  if (typeof iso !== "string" || iso.trim() === "") {
    return EMPTY_VALUE;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return DATE_ONLY_FORMATTER.format(date);
}

function playerName(player: EsportsPlayer): string {
  const parts = [player.firstName, player.lastName].filter(
    (part) => typeof part === "string" && part.trim() !== "",
  );
  return parts.length === 0 ? EMPTY_VALUE : parts.join(" ");
}

function stageSectionLabel(standing: EsportsStanding): string {
  const parts = [standing.stage, standing.section].filter(
    (part) => typeof part === "string" && part.trim() !== "",
  );
  return parts.length === 0 ? EMPTY_VALUE : parts.join(" · ");
}

/** Logo/photo distante avec repli « — » (CSP img-src esport côté Tauri). */
function remoteImage(source: unknown, className: string, alt: string): HTMLElement {
  const wrapper = el("span", { className: `${className}-wrap` });
  const url = typeof source === "string" ? source.trim() : "";
  if (url === "") {
    wrapper.appendChild(
      el("span", {
        className: `${className} ${className}--placeholder`,
        text: EMPTY_VALUE,
        attrs: { "aria-hidden": "true", title: "Image non fournie par Riot Esports" },
      }),
    );
    return wrapper;
  }
  const image = el("img", {
    className,
    attrs: {
      alt,
      loading: "lazy",
      decoding: "async",
      draggable: "false",
      referrerpolicy: "no-referrer",
    },
  });
  image.src = url;
  image.addEventListener("error", () => {
    image.replaceWith(
      el("span", {
        className: `${className} ${className}--placeholder`,
        text: EMPTY_VALUE,
        attrs: { "aria-hidden": "true", title: "Image distante indisponible" },
      }),
    );
  });
  wrapper.appendChild(image);
  return wrapper;
}

function buildLoading(message: string): HTMLElement {
  const container = el("div", { className: "state state--loading" });
  const line = el("div", { className: "loading-line" });
  append(
    line,
    el("span", { className: "spinner", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "loading-text", text: message }),
  );
  container.appendChild(line);
  return container;
}

function buildError(
  title: string,
  message: string,
  onRetry?: () => void,
  extra?: HTMLElement,
): HTMLElement {
  const container = el("div", { className: "esports-error" });
  const panel = buildPanelState({
    tone: "error",
    title,
    message,
    ...(onRetry === undefined
      ? {}
      : { actionLabel: "Réessayer", onAction: onRetry }),
    iconName: "alert",
  });
  container.appendChild(panel);
  if (extra !== undefined) {
    container.appendChild(extra);
  }
  return container;
}

function buildBackButton(label: string, onBack: () => void): HTMLButtonElement {
  const button = el("button", {
    className: "btn btn-ghost esports-back",
    attrs: { type: "button", "data-esports-back": "true" },
  });
  append(button, icon("arrowLeft", 15), el("span", { className: "btn-label", text: label }));
  button.addEventListener("click", () => {
    onBack();
  });
  return button;
}

export function createEsportsView(): EsportsViewHandle {
  // --- État -------------------------------------------------------------
  let subtab: Subtab = "teams";
  let query = "";

  let teamsState: LoadState = "idle";
  let teams: readonly EsportsTeam[] = [];
  let teamsError: string | null = null;
  let leagueFilter = "all";
  let page = 0;

  let detailState: LoadState = "idle";
  let detail: EsportsTeamDetail | null = null;
  let detailError: string | null = null;
  let detailTeamId: string | null = null;
  let detailTrigger: HTMLElement | null = null;

  let leaguesState: LoadState = "idle";
  let leagues: readonly EsportsLeague[] = [];
  let leaguesError: string | null = null;
  let leagueTrigger: HTMLElement | null = null;

  let selectedLeague: EsportsLeague | null = null;
  let tournamentsState: LoadState = "idle";
  let tournaments: readonly EsportsTournament[] = [];
  let tournamentsError: string | null = null;

  let selectedTournament: EsportsTournament | null = null;
  let standingsState: LoadState = "idle";
  let standings: readonly EsportsStanding[] = [];
  let standingsError: string | null = null;
  let tournamentTrigger: HTMLElement | null = null;

  // --- En-tête ----------------------------------------------------------
  const heading = el("div", { className: "view-heading" });
  append(
    heading,
    el("h1", { className: "view-title", text: "Esport" }),
    el("p", {
      className: "view-sub",
      text: "Équipes et compétitions — données réelles Riot Esports API, sans clé utilisateur.",
    }),
  );
  const sourceNote = el("p", {
    className: "esports-source",
    text: `Source : ${SOURCE_LABEL}`,
  });
  append(heading, sourceNote);
  const head = el("header", { className: "view-head" });
  head.appendChild(heading);

  // --- Sous-onglets -----------------------------------------------------
  const subtabButtons = new Map<Subtab, HTMLButtonElement>();
  const subtabList = el("div", {
    className: "esports-subtabs",
    attrs: { role: "tablist", "aria-label": "Sections Esport" },
  });
  const subtabDefs: readonly { readonly id: Subtab; readonly label: string }[] = [
    { id: "teams", label: "Équipes" },
    { id: "competitions", label: "Compétitions" },
  ];
  for (const definition of subtabDefs) {
    const active = definition.id === subtab;
    const button = el("button", {
      className: "esports-subtab",
      text: definition.label,
      attrs: {
        type: "button",
        role: "tab",
        "data-esports-subtab": definition.id,
        "aria-selected": active ? "true" : "false",
        tabindex: active ? "0" : "-1",
      },
    });
    button.addEventListener("click", () => {
      setSubtab(definition.id);
    });
    subtabButtons.set(definition.id, button);
    subtabList.appendChild(button);
  }
  const subtabsBar = el("div", { className: "esports-subtabs-bar" });
  subtabsBar.appendChild(subtabList);

  // --- Barre de recherche / filtre -------------------------------------
  const searchInput = el("input", {
    className: "search-input esports-search-input",
    attrs: {
      type: "search",
      placeholder: "Rechercher une équipe (nom, code, ligue)…",
      "aria-label": "Rechercher dans les équipes esport",
      "data-esports-search": "true",
      autocomplete: "off",
      spellcheck: "false",
    },
  });
  const searchField = el("label", { className: "search-field esports-search" });
  append(searchField, icon("search", 15), searchInput);

  const leagueFilterSelect = el("select", {
    className: "riot-select esports-league-filter",
    attrs: {
      "data-esports-league-filter": "true",
      "aria-label": "Filtrer les équipes par ligue",
    },
  });

  const countLabel = el("span", {
    className: "esports-count",
    text: EMPTY_VALUE,
    attrs: { "data-esports-count": "true" },
  });

  const toolbar = el("div", { className: "esports-toolbar" });
  append(toolbar, searchField, leagueFilterSelect, countLabel);

  // --- Panneaux ---------------------------------------------------------
  const teamsListHost = el("div", { className: "esports-teams-list-host" });
  const detailHost = el("div", { className: "esports-team-detail-host" });
  detailHost.hidden = true;
  const teamsPanel = el("section", {
    className: "esports-panel",
    attrs: { "data-esports-teams-panel": "true", "aria-label": "Équipes esport" },
  });
  append(teamsPanel, teamsListHost, detailHost);

  const competitionsHost = el("div", { className: "esports-competitions-host" });
  const competitionsPanel = el("section", {
    className: "esports-panel",
    attrs: {
      "data-esports-competitions-panel": "true",
      "aria-label": "Compétitions esport",
    },
  });
  competitionsPanel.hidden = true;
  competitionsPanel.appendChild(competitionsHost);

  const announcer = el("div", {
    className: "sr-only",
    attrs: { role: "status", "aria-live": "polite" },
  });

  const element = el("section", {
    className: "view view--esports",
    attrs: {
      role: "tabpanel",
      id: panelId("esports"),
      "data-view": "esports",
      "aria-labelledby": tabId("esports"),
    },
  });
  append(element, head, subtabsBar, toolbar, teamsPanel, competitionsPanel, announcer);
  element.hidden = true;

  // --- Utilitaires d'affichage -----------------------------------------
  function teamDetailOpen(): boolean {
    return detailTeamId !== null;
  }

  function updateChrome(): void {
    for (const [id, button] of subtabButtons) {
      const active = id === subtab;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
    }
    const teamsActive = subtab === "teams";
    teamsPanel.hidden = !teamsActive;
    competitionsPanel.hidden = teamsActive;

    const teamsListVisible = teamsActive && !teamDetailOpen();
    const leaguesListVisible = !teamsActive && selectedLeague === null;
    toolbar.hidden = !(teamsListVisible || leaguesListVisible);
    leagueFilterSelect.hidden = !teamsActive;
    countLabel.hidden = !teamsListVisible;
    searchInput.placeholder = teamsActive
      ? "Rechercher une équipe (nom, code, ligue)…"
      : "Rechercher une ligue (nom, région)…";
    searchInput.setAttribute(
      "aria-label",
      teamsActive
        ? "Rechercher dans les équipes esport"
        : "Rechercher dans les compétitions esport",
    );
  }

  function setSubtab(next: Subtab): void {
    if (subtab === next) {
      return;
    }
    subtab = next;
    // Chaque sous-onglet a sa propre recherche : ne pas réutiliser « T1 »
    // (équipe) comme filtre de ligues, sinon la liste des compétitions est vide.
    query = "";
    page = 0;
    searchInput.value = "";
    if (leagueFilter !== "all") {
      leagueFilter = "all";
      leagueFilterSelect.value = "all";
    }
    updateChrome();
    if (next === "teams") {
      if (teamsState === "idle") {
        void loadTeams();
      } else {
        renderTeams();
      }
      announcer.textContent = "Équipes esport.";
    } else {
      if (leaguesState === "idle") {
        void loadLeagues();
      } else {
        renderCompetitions();
      }
      announcer.textContent = "Compétitions esport.";
    }
  }

  // --- Équipes ----------------------------------------------------------
  function activeTeams(): readonly EsportsTeam[] {
    return teams.filter((team) => {
      const status = typeof team.status === "string" ? team.status.trim().toLowerCase() : "";
      return status === "active";
    });
  }

  function filteredTeams(): readonly EsportsTeam[] {
    const needle = normalizeForSearch(query.trim());
    const active = activeTeams();
    return active.filter((team) => {
      if (leagueFilter !== "all") {
        const league = typeof team.homeLeague === "string" ? team.homeLeague : "";
        if (league !== leagueFilter) {
          return false;
        }
      }
      if (needle === "") {
        return true;
      }
      const haystack = normalizeForSearch(
        [team.name, team.code, team.homeLeague ?? "", team.region ?? ""].join(" "),
      );
      return haystack.includes(needle);
    });
  }

  function renderLeagueFilter(): void {
    const labels = new Map<string, string>();
    for (const team of activeTeams()) {
      const league = typeof team.homeLeague === "string" ? team.homeLeague.trim() : "";
      if (league !== "") {
        labels.set(league, league);
      }
    }
    if (leagueFilter !== "all" && !labels.has(leagueFilter)) {
      leagueFilter = "all";
    }
    const values = [...labels.values()].sort((left, right) => left.localeCompare(right, "fr"));
    const options: HTMLElement[] = [
      el("option", { text: "Toutes les ligues", attrs: { value: "all" } }),
    ];
    for (const value of values) {
      options.push(el("option", { text: value, attrs: { value } }));
    }
    replaceContent(leagueFilterSelect, ...options);
    leagueFilterSelect.value = leagueFilter;
  }

  function buildTeamCard(team: EsportsTeam): HTMLButtonElement {
    const card = el("button", {
      className: "esports-team-card",
      attrs: {
        type: "button",
        "data-esports-team": "true",
        "data-team-id": team.id,
        "aria-label": `Ouvrir la fiche de l'équipe ${team.name}`,
      },
    });
    card.appendChild(remoteImage(team.imageUrl, "esports-team-logo", `Logo ${team.name}`));
    const body = el("span", { className: "esports-team-body" });
    append(
      body,
      el("span", { className: "esports-team-name", text: stringOrDash(team.name) }),
      el("span", {
        className: "esports-team-code",
        text: stringOrDash(team.code),
      }),
      el("span", {
        className: "esports-team-league",
        text: `${stringOrDash(team.homeLeague)} · ${stringOrDash(team.region)}`,
      }),
    );
    card.appendChild(body);
    card.addEventListener("click", () => {
      void openTeam(team.id, card);
    });
    return card;
  }

  function renderTeamsList(): HTMLElement {
    const filtered = filteredTeams();
    const totalPages = Math.max(1, Math.ceil(filtered.length / TEAMS_PAGE_SIZE));
    if (page > totalPages - 1) {
      page = totalPages - 1;
    }
    if (page < 0) {
      page = 0;
    }
    countLabel.hidden = false;
    countLabel.textContent = `${formatCount(filtered.length)} équipes actives`;

    const container = el("div", { className: "esports-teams-list" });
    if (filtered.length === 0) {
      container.appendChild(
        el("p", {
          className: "esports-empty",
          text: "Aucune équipe active ne correspond à cette recherche.",
        }),
      );
      return container;
    }

    const grid = el("div", { className: "esports-team-grid" });
    const start = page * TEAMS_PAGE_SIZE;
    for (const team of filtered.slice(start, start + TEAMS_PAGE_SIZE)) {
      grid.appendChild(buildTeamCard(team));
    }
    container.appendChild(grid);

    const pagination = el("nav", {
      className: "esports-pagination",
      attrs: { "aria-label": "Pagination des équipes" },
    });
    const prev = el("button", {
      className: "btn btn-ghost esports-page-btn",
      attrs: { type: "button", "data-esports-prev": "true" },
    });
    append(prev, icon("arrowLeft", 14), el("span", { className: "btn-label", text: "Précédent" }));
    prev.disabled = page <= 0;
    prev.addEventListener("click", () => {
      if (page > 0) {
        page -= 1;
        renderTeams();
      }
    });

    const pageLabel = el("span", {
      className: "esports-page-label",
      text: `Page ${formatCount(page + 1)} / ${formatCount(totalPages)}`,
    });

    const next = el("button", {
      className: "btn btn-ghost esports-page-btn",
      attrs: { type: "button", "data-esports-next": "true" },
    });
    append(next, el("span", { className: "btn-label", text: "Suivant" }));
    next.disabled = page >= totalPages - 1;
    next.addEventListener("click", () => {
      if (page < totalPages - 1) {
        page += 1;
        renderTeams();
      }
    });

    append(pagination, prev, pageLabel, next);
    container.appendChild(pagination);
    return container;
  }

  function buildTeamDetailContent(): HTMLElement {
    if (detail === null) {
      return buildError(
        "Fiche d'équipe indisponible",
        detailError ?? "Erreur inconnue.",
        () => {
          if (detailTeamId !== null) {
            void openTeam(detailTeamId, detailTrigger);
          }
        },
      );
    }
    const team = detail.team;
    const container = el("div", {
      className: "esports-team-detail",
      attrs: { "data-esports-team-detail": "true" },
    });
    container.appendChild(
      buildBackButton("Retour aux équipes", () => {
        closeTeamDetail(true);
      }),
    );

    const header = el("header", { className: "esports-team-detail-head" });
    header.appendChild(remoteImage(team.imageUrl, "esports-team-detail-logo", `Logo ${team.name}`));
    const identity = el("div", { className: "esports-team-detail-identity" });
    append(
      identity,
      el("h2", { className: "esports-team-detail-name", text: stringOrDash(team.name) }),
      el("p", {
        className: "esports-team-detail-code",
        text: `${stringOrDash(team.code)} · ${stringOrDash(team.status)}`,
      }),
      el("p", {
        className: "esports-team-detail-league",
        text: `Ligue : ${stringOrDash(team.homeLeague)} · Région : ${stringOrDash(team.region)}`,
      }),
      el("p", {
        className: "esports-team-detail-count",
        text: `${countOrDash(team.playerCount)} joueurs déclarés`,
      }),
    );
    header.appendChild(identity);
    container.appendChild(header);

    const source = el("p", {
      className: "esports-detail-source",
      text: `Source : ${SOURCE_LABEL} · ${
        detail.fromCache ? "Données en cache" : "Données réseau"
      } · Récupéré : ${formatDateTime(detail.fetchedAt)}`,
    });
    container.appendChild(source);
    if (detail.warning !== null && detail.warning.trim() !== "") {
      container.appendChild(el("p", { className: "esports-warning", text: detail.warning }));
    }

    const note = el("p", { className: "esports-missing-note", text: MISSING_PLAYER_NOTE });
    container.appendChild(note);

    const players = el("div", { className: "esports-players" });
    players.appendChild(el("h3", { className: "esports-players-title", text: "Joueurs" }));
    if (detail.players.length === 0) {
      append(
        players,
        el("p", { className: "esports-empty", text: EMPTY_VALUE }),
        el("p", {
          className: "esports-empty-hint",
          text: "Aucun joueur fourni par l'API Riot Esports pour cette équipe.",
        }),
      );
    } else {
      const grid = el("div", { className: "esports-player-grid" });
      for (const player of detail.players) {
        grid.appendChild(buildPlayerCard(player));
      }
      players.appendChild(grid);
    }
    container.appendChild(players);
    return container;
  }

  function buildPlayerCard(player: EsportsPlayer): HTMLElement {
    const card = el("article", {
      className: "esports-player",
      attrs: { "data-esports-player": "true" },
    });
    card.appendChild(remoteImage(player.imageUrl, "esports-player-photo", `Photo ${player.summonerName}`));
    const body = el("div", { className: "esports-player-body" });
    append(
      body,
      el("span", {
        className: "esports-player-pseudo",
        text: stringOrDash(player.summonerName),
      }),
      el("span", { className: "esports-player-name", text: playerName(player) }),
      el("span", { className: "esports-player-role", text: riotPositionLabel(player.role) }),
    );
    const fields = el("dl", { className: "esports-player-fields" });
    const entries: readonly (readonly [string, string])[] = [
      ["Âge", countOrDash(player.age)],
      ["Pays", stringOrDash(player.country)],
      ["Langue", stringOrDash(player.language)],
      ["Main dominante", stringOrDash(player.handedness)],
    ];
    for (const [label, value] of entries) {
      append(
        fields,
        el("dt", { text: label }),
        el("dd", { text: value }),
      );
    }
    body.appendChild(fields);
    card.appendChild(body);
    return card;
  }

  function renderTeams(): void {
    updateChrome();
    if (teamDetailOpen()) {
      teamsListHost.hidden = true;
      detailHost.hidden = false;
      switch (detailState) {
        case "loading":
          replaceContent(detailHost, buildLoading("Chargement de la fiche d'équipe…"));
          break;
        case "error":
          replaceContent(
            detailHost,
            (() => {
              const container = el("div", { className: "esports-team-detail" });
              container.appendChild(
                buildBackButton("Retour aux équipes", () => {
                  closeTeamDetail(true);
                }),
              );
              container.appendChild(
                buildError(
                  "Fiche d'équipe indisponible",
                  detailError ?? "Erreur inconnue.",
                  () => {
                    if (detailTeamId !== null) {
                      void openTeam(detailTeamId, detailTrigger);
                    }
                  },
                ),
              );
              return container;
            })(),
          );
          break;
        case "ready":
          replaceContent(detailHost, buildTeamDetailContent());
          detailHost.querySelector<HTMLElement>("[data-esports-back]")?.focus();
          break;
        case "idle":
          replaceContent(detailHost);
          break;
      }
      return;
    }
    detailHost.hidden = true;
    teamsListHost.hidden = false;
    switch (teamsState) {
      case "idle":
        replaceContent(
          teamsListHost,
          el("p", {
            className: "esports-empty",
            text: "Chargement des équipes à l'ouverture de l'onglet…",
          }),
        );
        break;
      case "loading":
        replaceContent(teamsListHost, buildLoading("Chargement des équipes Riot Esports…"));
        break;
      case "error":
        replaceContent(
          teamsListHost,
          buildError("Impossible de charger les équipes", teamsError ?? "Erreur inconnue.", () => {
            void loadTeams();
          }),
        );
        break;
      case "ready":
        replaceContent(teamsListHost, renderTeamsList());
        break;
    }
  }

  async function loadTeams(): Promise<void> {
    if (teamsState === "loading") {
      return;
    }
    teamsState = "loading";
    teamsError = null;
    renderTeams();
    announcer.textContent = "Chargement des équipes Riot Esports…";
    try {
      const loaded = await api.getEsportsTeams();
      teams = loaded;
      teamsState = "ready";
      page = 0;
      renderLeagueFilter();
      renderTeams();
      announcer.textContent = `${formatCount(activeTeams().length)} équipes actives chargées.`;
    } catch (error) {
      teams = [];
      teamsState = "error";
      teamsError = errorMessage(error);
      renderTeams();
      announcer.textContent = `Équipes esport indisponibles. ${teamsError}`;
    }
  }

  async function openTeam(teamId: string, trigger: HTMLElement | null): Promise<void> {
    detailTeamId = teamId;
    detailTrigger = trigger;
    detailState = "loading";
    detailError = null;
    detail = null;
    renderTeams();
    announcer.textContent = "Chargement de la fiche d'équipe…";
    try {
      const loaded = await api.getEsportsTeam(teamId);
      if (detailTeamId !== teamId) {
        return;
      }
      detail = loaded;
      detailState = "ready";
      renderTeams();
      announcer.textContent = `Fiche de l'équipe ${loaded.team.name} chargée.`;
    } catch (error) {
      if (detailTeamId !== teamId) {
        return;
      }
      detail = null;
      detailState = "error";
      detailError = errorMessage(error);
      renderTeams();
      announcer.textContent = `Fiche d'équipe indisponible. ${detailError}`;
    }
  }

  function closeTeamDetail(focusTrigger: boolean): void {
    const trigger = detailTrigger;
    detailTeamId = null;
    detailState = "idle";
    detail = null;
    detailError = null;
    detailTrigger = null;
    renderTeams();
    if (focusTrigger && trigger !== null) {
      trigger.focus();
    }
  }

  // --- Compétitions -----------------------------------------------------
  function buildLeagueCard(league: EsportsLeague): HTMLButtonElement {
    const card = el("button", {
      className: "esports-league-card",
      attrs: {
        type: "button",
        "data-esports-league": "true",
        "data-league-id": league.id,
        "aria-label": `Ouvrir les tournois de ${league.name}`,
      },
    });
    card.appendChild(remoteImage(league.imageUrl, "esports-league-logo", `Logo ${league.name}`));
    const body = el("span", { className: "esports-league-body" });
    append(
      body,
      el("span", { className: "esports-league-name", text: stringOrDash(league.name) }),
      el("span", { className: "esports-league-region", text: stringOrDash(league.region) }),
    );
    card.appendChild(body);
    card.addEventListener("click", () => {
      void openLeague(league, card);
    });
    return card;
  }

  function filteredLeagues(): readonly EsportsLeague[] {
    const needle = normalizeForSearch(query.trim());
    if (needle === "") {
      return leagues;
    }
    return leagues.filter((league) => {
      const haystack = normalizeForSearch(
        [league.name, league.slug, league.region].join(" "),
      );
      return haystack.includes(needle);
    });
  }

  function renderLeaguesList(): HTMLElement {
    const filtered = filteredLeagues();
    const container = el("div", { className: "esports-leagues" });
    container.appendChild(
      el("p", {
        className: "esports-section-count",
        text: `${formatCount(filtered.length)} ligues`,
      }),
    );
    if (filtered.length === 0) {
      container.appendChild(
        el("p", { className: "esports-empty", text: "Aucune ligue ne correspond à cette recherche." }),
      );
      return container;
    }
    const grid = el("div", { className: "esports-league-grid" });
    for (const league of filtered) {
      grid.appendChild(buildLeagueCard(league));
    }
    container.appendChild(grid);
    return container;
  }

  function renderLeagueStage(): void {
    switch (leaguesState) {
      case "idle":
        replaceContent(
          competitionsHost,
          el("p", {
            className: "esports-empty",
            text: "Sélectionnez l'onglet Compétitions pour charger les ligues.",
          }),
        );
        break;
      case "loading":
        replaceContent(competitionsHost, buildLoading("Chargement des ligues Riot Esports…"));
        break;
      case "error":
        replaceContent(
          competitionsHost,
          buildError("Impossible de charger les ligues", leaguesError ?? "Erreur inconnue.", () => {
            void loadLeagues();
          }),
        );
        break;
      case "ready":
        replaceContent(competitionsHost, renderLeaguesList());
        break;
    }
  }

  function renderTournamentsStage(): void {
    if (selectedLeague === null) {
      renderLeagueStage();
      return;
    }
    const container = el("div", { className: "esports-tournaments" });
    container.appendChild(
      buildBackButton("Retour aux compétitions", () => {
        closeLeague();
      }),
    );
    container.appendChild(
      el("h2", {
        className: "esports-stage-title",
        text: stringOrDash(selectedLeague.name),
      }),
    );
    switch (tournamentsState) {
      case "loading":
        container.appendChild(buildLoading("Chargement des tournois…"));
        break;
      case "error":
        container.appendChild(
          buildError("Impossible de charger les tournois", tournamentsError ?? "Erreur inconnue.", () => {
            if (selectedLeague !== null) {
              void openLeague(selectedLeague, leagueTrigger);
            }
          }),
        );
        break;
      case "idle":
        container.appendChild(
          el("p", { className: "esports-empty", text: "Aucun tournoi sélectionné." }),
        );
        break;
      case "ready":
        if (tournaments.length === 0) {
          append(
            container,
            el("p", { className: "esports-empty", text: EMPTY_VALUE }),
            el("p", {
              className: "esports-empty-hint",
              text: "Aucun tournoi fourni par l'API pour cette ligue.",
            }),
          );
        } else {
          const list = el("div", { className: "esports-tournament-list" });
          for (const tournament of tournaments) {
            list.appendChild(buildTournamentRow(tournament));
          }
          container.appendChild(list);
        }
        break;
    }
    replaceContent(competitionsHost, container);
    competitionsHost.querySelector<HTMLElement>("[data-esports-back]")?.focus();
  }

  function buildTournamentRow(tournament: EsportsTournament): HTMLButtonElement {
    const row = el("button", {
      className: "esports-tournament",
      attrs: {
        type: "button",
        "data-esports-tournament": "true",
        "data-tournament-id": tournament.id,
        "aria-label": `Ouvrir le classement du tournoi ${tournament.slug}`,
      },
    });
    append(
      row,
      el("span", {
        className: "esports-tournament-slug",
        text: stringOrDash(tournament.slug),
      }),
      el("span", {
        className: "esports-tournament-dates",
        text: `${formatDateOnly(tournament.startDate)} → ${formatDateOnly(tournament.endDate)}`,
      }),
      el("span", { className: "esports-tournament-open", text: "Ouvrir" }),
    );
    row.addEventListener("click", () => {
      void openTournament(tournament, row);
    });
    return row;
  }

  function renderStandingsStage(): void {
    if (selectedTournament === null) {
      renderTournamentsStage();
      return;
    }
    const container = el("div", { className: "esports-standings" });
    container.appendChild(
      buildBackButton("Retour aux tournois", () => {
        closeTournament();
      }),
    );
    append(
      container,
      el("h2", {
        className: "esports-stage-title",
        text: stringOrDash(selectedTournament.slug),
      }),
      el("p", {
        className: "esports-stage-dates",
        text: `${formatDateOnly(selectedTournament.startDate)} → ${formatDateOnly(
          selectedTournament.endDate,
        )}`,
      }),
    );

    switch (standingsState) {
      case "loading":
        container.appendChild(buildLoading("Chargement du classement…"));
        break;
      case "error":
        container.appendChild(
          buildError("Impossible de charger le classement", standingsError ?? "Erreur inconnue.", () => {
            if (selectedTournament !== null) {
              void openTournament(selectedTournament, tournamentTrigger);
            }
          }),
        );
        break;
      case "idle":
        container.appendChild(
          el("p", { className: "esports-empty", text: "Aucun classement sélectionné." }),
        );
        break;
      case "ready":
        if (standings.length === 0) {
          append(
            container,
            el("p", { className: "esports-empty", text: EMPTY_VALUE }),
            el("p", {
              className: "esports-empty-hint",
              text: "Aucune ligne de classement fournie par l'API pour ce tournoi.",
            }),
          );
        } else {
          const table = el("div", {
            className: "esports-standings-table",
            attrs: { role: "table", "aria-label": "Classement du tournoi" },
          });
          const head = el("div", { className: "esports-standing esports-standing--head" });
          append(
            head,
            el("span", { className: "esports-standing-cell", text: "Phase / section" }),
            el("span", { className: "esports-standing-cell", text: "Rang" }),
            el("span", { className: "esports-standing-cell", text: "Équipe" }),
            el("span", { className: "esports-standing-cell", text: "V" }),
            el("span", { className: "esports-standing-cell", text: "D" }),
          );
          table.appendChild(head);
          for (const standing of standings) {
            table.appendChild(buildStandingRow(standing));
          }
          container.appendChild(table);
        }
        break;
    }
    replaceContent(competitionsHost, container);
    competitionsHost.querySelector<HTMLElement>("[data-esports-back]")?.focus();
  }

  function buildStandingRow(standing: EsportsStanding): HTMLElement {
    const row = el("div", {
      className: "esports-standing",
      attrs: { "data-esports-standing": "true" },
    });
    append(
      row,
      el("span", {
        className: "esports-standing-cell esports-standing-stage",
        text: stageSectionLabel(standing),
      }),
      el("span", {
        className: "esports-standing-cell esports-standing-ordinal",
        text: countOrDash(standing.ordinal),
      }),
      (() => {
        const team = el("span", {
          className: "esports-standing-cell esports-standing-team",
        });
        team.appendChild(
          remoteImage(standing.teamImageUrl, "esports-standing-logo", `Logo ${standing.teamName}`),
        );
        append(
          team,
          el("span", {
            className: "esports-standing-name",
            text: stringOrDash(standing.teamName),
          }),
          el("span", {
            className: "esports-standing-code",
            text: stringOrDash(standing.teamCode),
          }),
        );
        return team;
      })(),
      el("span", {
        className: "esports-standing-cell esports-standing-wins",
        text: recordOrDash(standing.wins),
      }),
      el("span", {
        className: "esports-standing-cell esports-standing-losses",
        text: recordOrDash(standing.losses),
      }),
    );
    return row;
  }

  function renderCompetitions(): void {
    updateChrome();
    if (selectedTournament !== null) {
      renderStandingsStage();
      return;
    }
    if (selectedLeague !== null) {
      renderTournamentsStage();
      return;
    }
    renderLeagueStage();
  }

  async function loadLeagues(): Promise<void> {
    if (leaguesState === "loading") {
      return;
    }
    leaguesState = "loading";
    leaguesError = null;
    renderCompetitions();
    announcer.textContent = "Chargement des ligues Riot Esports…";
    try {
      const loaded = await api.getEsportsLeagues();
      leagues = loaded;
      leaguesState = "ready";
      renderCompetitions();
      announcer.textContent = `${formatCount(leagues.length)} ligues chargées.`;
    } catch (error) {
      leagues = [];
      leaguesState = "error";
      leaguesError = errorMessage(error);
      renderCompetitions();
      announcer.textContent = `Ligues esport indisponibles. ${leaguesError}`;
    }
  }

  async function openLeague(league: EsportsLeague, trigger: HTMLElement | null): Promise<void> {
    selectedLeague = league;
    leagueTrigger = trigger;
    selectedTournament = null;
    tournamentsState = "loading";
    tournaments = [];
    tournamentsError = null;
    standingsState = "idle";
    standings = [];
    renderCompetitions();
    announcer.textContent = `Chargement des tournois de ${league.name}…`;
    try {
      const loaded = await api.getEsportsTournaments(league.id);
      if (selectedLeague !== league) {
        return;
      }
      tournaments = loaded;
      tournamentsState = "ready";
      renderCompetitions();
      announcer.textContent = `${formatCount(loaded.length)} tournois chargés.`;
    } catch (error) {
      if (selectedLeague !== league) {
        return;
      }
      tournaments = [];
      tournamentsState = "error";
      tournamentsError = errorMessage(error);
      renderCompetitions();
      announcer.textContent = `Tournois indisponibles. ${tournamentsError}`;
    }
  }

  function closeLeague(): void {
    const trigger = leagueTrigger;
    selectedLeague = null;
    selectedTournament = null;
    tournaments = [];
    tournamentsState = "idle";
    tournamentsError = null;
    standingsState = "idle";
    standings = [];
    leagueTrigger = null;
    tournamentTrigger = null;
    renderCompetitions();
    if (trigger !== null) {
      trigger.focus();
    }
  }

  async function openTournament(
    tournament: EsportsTournament,
    trigger: HTMLElement | null,
  ): Promise<void> {
    selectedTournament = tournament;
    tournamentTrigger = trigger;
    standingsState = "loading";
    standings = [];
    standingsError = null;
    renderCompetitions();
    announcer.textContent = `Chargement du classement de ${tournament.slug}…`;
    try {
      const loaded = await api.getEsportsStandings(tournament.id);
      if (selectedTournament !== tournament) {
        return;
      }
      standings = loaded;
      standingsState = "ready";
      renderCompetitions();
      announcer.textContent = `${formatCount(loaded.length)} lignes de classement chargées.`;
    } catch (error) {
      if (selectedTournament !== tournament) {
        return;
      }
      standings = [];
      standingsState = "error";
      standingsError = errorMessage(error);
      renderCompetitions();
      announcer.textContent = `Classement indisponible. ${standingsError}`;
    }
  }

  function closeTournament(): void {
    const trigger = tournamentTrigger;
    selectedTournament = null;
    standings = [];
    standingsState = "idle";
    standingsError = null;
    tournamentTrigger = null;
    renderCompetitions();
    if (trigger !== null) {
      trigger.focus();
    }
  }

  // --- Événements -------------------------------------------------------
  searchInput.addEventListener("input", () => {
    query = searchInput.value;
    page = 0;
    if (subtab === "teams") {
      renderTeams();
    } else {
      renderCompetitions();
    }
  });
  leagueFilterSelect.addEventListener("change", () => {
    leagueFilter = leagueFilterSelect.value;
    page = 0;
    renderTeams();
  });

  updateChrome();
  renderTeams();
  renderCompetitions();

  return {
    element,
    onShown: () => {
      if (teamsState === "idle") {
        void loadTeams();
      }
      if (subtab === "competitions" && leaguesState === "idle") {
        void loadLeagues();
      }
    },
  };
}
