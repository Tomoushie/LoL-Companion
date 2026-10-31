// Scénarios UI V1.0 — Esport (Riot Esports API, LIVE) + curseur personnalisé.
//
// Prérequis : app lancée avec WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// Usage : node scripts/ui-scenarios-esports.mjs --port 9333 --out-dir docs

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const options = { port: 9333, outDir: "docs" };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") options.port = Number(args[++i]);
  else if (args[i] === "--out-dir") options.outDir = args[++i];
}
const outDir = resolve(options.outDir);
mkdirSync(outDir, { recursive: true });

const failures = [];
const checks = {};
function check(name, condition, detail = "") {
  checks[name] = { ok: Boolean(condition), detail };
  if (!condition) failures.push(`${name} : ${detail}`);
  console.log(`${condition ? "OK  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${options.port}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("aucune cible WebView CDP");
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((res, rej) => {
    socket.addEventListener("open", res, { once: true });
    socket.addEventListener("error", rej, { once: true });
  });
  const send = (method, params = {}) =>
    new Promise((res) => {
      const id = ++nextId;
      pending.set(id, res);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const result = response.result ?? {};
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
    return result.result?.value;
  };
  const waitFor = async (expression, label, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(300);
    }
    throw new Error(`délai dépassé en attendant « ${label} » (dernier : ${JSON.stringify(last)})`);
  };
  const capture = async (name) => {
    await evaluate("window.scrollTo(0, 0)");
    await sleep(400);
    const response = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const base64 = response.result?.data;
    if (!base64) throw new Error(`capture ${name} vide`);
    const path = resolve(outDir, name);
    writeFileSync(path, Buffer.from(base64, "base64"));
    console.log(`CAPTURE ${path}`);
  };
  const click = async (selector) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);

  await send("Page.enable");
  await send("Runtime.enable");

  // --- Onglet Esport ---------------------------------------------------
  const tabClicked = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('.tabs .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Esport');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  check("esports_tab", tabClicked, "onglet Esport introuvable");
  await waitFor(
    "(() => { const el = document.querySelector('#view-esports'); return !!el && !el.hidden; })()",
    "vue Esport",
    20000,
  );
  await waitFor(
    "document.querySelectorAll('[data-esports-team]').length >= 60",
    "équipes Esport",
    60000,
  );
  await sleep(1200);

  const teams = await evaluate(`(() => ({
    cards: document.querySelectorAll('[data-esports-team]').length,
    count: document.querySelector('[data-esports-count]')?.textContent?.trim() ?? '',
    leagues: document.querySelectorAll('[data-esports-league-filter] option').length,
    logos: Array.from(document.querySelectorAll('[data-esports-team] img')).filter((i) => i.complete && i.naturalWidth > 0).length,
    tabs: document.querySelectorAll('.tabs .tab').length,
  }))()`);
  check("esports_teams", teams.cards === 60 && teams.count.length > 0 && teams.leagues > 10, JSON.stringify(teams));
  check("esports_logos", teams.logos >= 20, `${teams.logos} logos chargés`);
  check("esports_nav_eight_tabs", teams.tabs === 8, `${teams.tabs} onglets`);

  // Recherche + fiche d'équipe T1.
  await evaluate(`(() => {
    const input = document.querySelector('[data-esports-search]');
    input.value = 'T1';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await sleep(500);
  const search = await evaluate(`(() => ({
    cards: document.querySelectorAll('[data-esports-team]').length,
    t1: !!document.querySelector('[data-esports-team][data-team-id="98767991853197861"]'),
    count: document.querySelector('[data-esports-count]')?.textContent?.trim() ?? '',
  }))()`);
  check("esports_search", search.cards >= 1 && search.t1, JSON.stringify(search));
  const t1Clicked = await evaluate(`(() => {
    const card = document.querySelector('[data-esports-team][data-team-id="98767991853197861"]');
    if (!card) return false;
    card.click();
    return true;
  })()`);
  check("esports_team_click", t1Clicked, "carte T1 introuvable");
  await waitFor(
    "document.querySelectorAll('[data-esports-player]').length >= 1 && !!document.querySelector('[data-esports-team-detail]')",
    "détail équipe",
    60000,
  );
  await sleep(1200);
  const detail = await evaluate(`(() => {
    const root = document.querySelector('[data-esports-team-detail]');
    const players = Array.from(root?.querySelectorAll('[data-esports-player]') ?? []);
    const images = players.map((p) => p.querySelector('img')).filter(Boolean);
    return {
      players: players.length,
      names: players.slice(0, 5).map((p) => p.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 80)),
      photos: images.filter((i) => i.complete && i.naturalWidth > 0).length,
      text: root?.textContent?.replace(/\\s+/g, ' ').slice(0, 500) ?? '',
    };
  })()`);
  check("esports_team_detail", detail.players >= 10, `${detail.players} joueurs`);
  check("esports_team_photos", detail.photos >= 1, `${detail.photos} photos chargées`);
  check("esports_team_note", detail.text.includes("âge") && detail.text.includes("pays") && detail.text.includes("main dominante"), detail.text.slice(0, 240));
  await capture("v1.0-esports-team.png");

  // Retour puis compétitions.
  await click('[data-esports-back]');
  await sleep(400);
  await click('[data-esports-subtab="competitions"]');
  await waitFor(
    "document.querySelectorAll('[data-esports-league]').length >= 40",
    "ligues Esport",
    60000,
  );
  await sleep(800);
  const leagues = await evaluate(`(() => ({
    count: document.querySelectorAll('[data-esports-league]').length,
    lcs: !!document.querySelector('[data-esports-league][data-league-id="98767991299243165"]'),
    counter: document.querySelector('[data-esports-count]')?.textContent?.trim() ?? '',
  }))()`);
  check("esports_leagues", leagues.count >= 40 && leagues.lcs, JSON.stringify(leagues));

  await click('[data-esports-league][data-league-id="98767991299243165"]');
  await waitFor(
    "document.querySelectorAll('[data-esports-tournament]').length >= 1",
    "tournois LCS",
    60000,
  );
  await sleep(500);
  const tournaments = await evaluate(`(() => ({
    count: document.querySelectorAll('[data-esports-tournament]').length,
    first: document.querySelector('[data-esports-tournament]')?.getAttribute('data-tournament-id') ?? null,
  }))()`);
  check("esports_tournaments", tournaments.count >= 1, JSON.stringify(tournaments));

  await click('[data-esports-tournament]');
  await waitFor(
    "document.querySelectorAll('[data-esports-standing]').length >= 1",
    "classement LCS",
    60000,
  );
  await sleep(800);
  const standings = await evaluate(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-esports-standing]'));
    return {
      count: rows.length,
      first: rows[0]?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? '',
      text: document.querySelector('#view-esports')?.textContent?.replace(/\\s+/g, ' ').slice(0, 500) ?? '',
    };
  })()`);
  check("esports_standings", standings.count >= 1, `${standings.count} lignes`);
  check("esports_standings_first", standings.first.length > 0, standings.first);
  check("esports_source", standings.text.includes("Riot Esports API"), "source absente");
  await capture("v1.0-esports-standings.png");

  // --- Curseur personnalisé --------------------------------------------
  const cursorBefore = await evaluate(`(() => ({
    button: !!document.querySelector('[data-cursor-toggle]'),
    state: document.querySelector('[data-cursor-state]')?.textContent?.trim() ?? null,
    body: document.body.classList.contains('cursor-custom'),
    ls: localStorage.getItem('lolbot.cursor'),
  }))()`);
  check("cursor_present", cursorBefore.button, JSON.stringify(cursorBefore));
  // La préférence est persistée entre les runs : repartir de l'état standard
  // avant de tester l'activation.
  if (cursorBefore.body) {
    await click('[data-cursor-toggle]');
    await sleep(250);
  }
  await click('[data-cursor-toggle]');
  await sleep(250);
  const cursorAfter = await evaluate(`(() => ({
    state: document.querySelector('[data-cursor-state]')?.textContent?.trim() ?? null,
    body: document.body.classList.contains('cursor-custom'),
    pressed: document.querySelector('[data-cursor-toggle]')?.getAttribute('aria-pressed'),
    ls: localStorage.getItem('lolbot.cursor'),
  }))()`);
  check("cursor_toggle", cursorAfter.body === true && cursorAfter.pressed === "true", JSON.stringify(cursorAfter));
  check("cursor_persist", cursorAfter.state === "Curseur personnalisé" && cursorAfter.ls === "custom", cursorAfter.state ?? "");
  await capture("v1.0-esports-cursor.png");

  socket.close();
  console.log("\n=== RÉSUMÉ ===");
  console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`scénarios Esport : ${error?.stack ?? error}`);
  process.exit(1);
});
