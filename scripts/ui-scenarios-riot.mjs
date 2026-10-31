// Scénarios UI V0.5 — onglet Profil / fiche de match, pilotés par CDP.
//
// Prérequis : application lancée avec
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
//
// Modes :
//   no-key      : aucune clé API configurée → message dédié
//   invalid-key : clé invalide enregistrée → vrai appel Riot (401) → erreur claire
//   mock        : RIOT_API_KEY + RIOT_API_BASE pointent vers scripts/mock-riot-server.mjs
//                 (données SIMULÉES, test uniquement : jamais présentées comme réelles)
//
// Usage :
//   node scripts/ui-scenarios-riot.mjs --port 9333 --mode no-key --out-dir docs
//   node scripts/ui-scenarios-riot.mjs --port 9333 --mode invalid-key --out-dir docs
//   node scripts/ui-scenarios-riot.mjs --port 9333 --mode mock --mock-url http://127.0.0.1:18765 --out-dir _e2e-mock

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const options = { port: 9333, mode: "", outDir: "docs", mockUrl: "" };
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") options.port = Number(args[++i]);
  else if (args[i] === "--mode") options.mode = args[++i];
  else if (args[i] === "--out-dir") options.outDir = args[++i];
  else if (args[i] === "--mock-url") options.mockUrl = args[++i];
}
if (!["no-key", "invalid-key", "mock"].includes(options.mode)) {
  console.error("mode requis : no-key | invalid-key | mock");
  process.exit(2);
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

async function mockStats() {
  if (!options.mockUrl) return null;
  const response = await fetch(`${options.mockUrl}/__stats`);
  return response.json();
}

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
    if (result.exceptionDetails) {
      throw new Error(`évaluation JS : ${result.exceptionDetails.text}`);
    }
    return result.result?.value;
  };

  const waitFor = async (expression, label, timeoutMs = 30000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(250);
    }
    throw new Error(`délai dépassé en attendant « ${label} » (dernier : ${JSON.stringify(last)})`);
  };

  const capture = async (name) => {
    await evaluate("window.scrollTo(0, 0)");
    await sleep(350);
    const response = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const base64 = response.result?.data;
    if (!base64) throw new Error(`capture ${name} vide`);
    const path = resolve(outDir, name);
    writeFileSync(path, Buffer.from(base64, "base64"));
    console.log(`CAPTURE ${path}`);
  };

  await send("Page.enable");
  await send("Runtime.enable");

  // --- Onglet Profil ----------------------------------------------------
  const tabClicked = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .nav-tab, .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Profil');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  check("profile_tab", tabClicked, "onglet Profil introuvable");
  await waitFor(
    "(() => { const el = document.querySelector('#view-profile'); return !!el && !el.hidden; })()",
    "vue Profil visible",
    20000,
  );
  await waitFor(
    "!!document.querySelector('[data-riot-id-input]') && !!document.querySelector('[data-riot-platform]')",
    "formulaire Profil",
    20000,
  );
  await waitFor(
    "(() => { const s = document.querySelector('[data-riot-platform]'); return !!s && s.options.length > 1; })()",
    "plateformes Riot chargées",
    30000,
  );

  const setRiotId = async (value) =>
    evaluate(`(() => {
      const input = document.querySelector('[data-riot-id-input]');
      if (!input) return false;
      input.focus();
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

  const selectPlatform = async (platform) =>
    evaluate(`(() => {
      const select = document.querySelector('[data-riot-platform]');
      if (!select || select.options.length === 0) return false;
      const wanted = ${JSON.stringify(platform)}.toUpperCase();
      const option = Array.from(select.options).find((o) => o.value.toUpperCase() === wanted)
        ?? Array.from(select.options).find((o) => (o.textContent ?? '').toUpperCase().includes(wanted));
      if (!option) return false;
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

  const click = async (selector) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);

  const waitKeyStatus = async (expected, timeout = 20000) => {
    await waitFor(
      `(() => { const el = document.querySelector('.riot-key-status'); return !!el && el.textContent.includes(${JSON.stringify(expected)}); })()`,
      `statut clé « ${expected} »`,
      timeout,
    );
    return evaluate("document.querySelector('.riot-key-status')?.textContent?.trim() ?? null");
  };

  if (options.mode === "no-key") {
    const status = await waitKeyStatus("Aucune clé configurée");
    check("key_absent_status", status === "Aucune clé configurée", status ?? "");
    check("riot_id_input", await setRiotId("Faker#EUW"), "champ Riot ID absent");
    check("platform_selected", await selectPlatform("EUW1"), "plateforme EUW1 absente");
    await click('[data-riot-load]');
    await sleep(800);
    const noKeyPanel = await evaluate(`(() => {
      const root = document.querySelector('#view-profile');
      return root?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
    })()`);
    check(
      "no_key_panel",
      Boolean(noKeyPanel.includes("Aucune clé API Riot configurée")),
      noKeyPanel.slice(0, 300),
    );
    await capture("v0.5-profil-sans-cle.png");
  }

  if (options.mode === "invalid-key") {
    await waitKeyStatus("Aucune clé configurée");
    const keySaved = await evaluate(`(() => {
      const input = document.querySelector('[data-riot-key-input]');
      const save = document.querySelector('[data-riot-key-save]');
      if (!input || !save) return false;
      input.value = 'RGAPI-cle-invalide-pour-test';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      save.click();
      return true;
    })()`);
    check("invalid_key_saved", keySaved, "sauvegarde de clé impossible");
    await waitKeyStatus("Clé configurée", 20000);
    await setRiotId("Faker#EUW");
    check("platform_selected", await selectPlatform("EUW1"), "plateforme EUW1 absente");
    await click('[data-riot-load]');
    await waitFor(
      `(() => {
        const root = document.querySelector('#view-profile');
        const text = (root?.textContent ?? '').toLowerCase();
        return text.includes('invalide') || text.includes('401')
          || text.includes('joueur introuvable') || text.includes('impossible de charger');
      })()`,
      "erreur clé invalide (vrai appel Riot 401)",
      45000,
    );
    const errorText = await evaluate(`document.querySelector('#view-profile')?.textContent?.replace(/\\s+/g, ' ').trim() ?? ''`);
    check(
      "invalid_key_message",
      Boolean(errorText.toLowerCase().includes("invalide") || errorText.includes("401")),
      errorText.slice(0, 400),
    );
    await capture("v0.5-profil-cle-invalide.png");
    // Nettoyage : suppression de la clé locale de test.
    await click('[data-riot-key-clear]');
    await waitKeyStatus("Aucune clé configurée", 20000);
  }

  if (options.mode === "mock") {
    const status = await waitKeyStatus("Clé configurée");
    check("mock_key_configured", status === "Clé configurée", status ?? "");
    check("riot_id_input", await setRiotId("Faker#EUW"), "champ Riot ID absent");
    check("platform_selected", await selectPlatform("EUW1"), "plateforme EUW1 absente");

    await click('[data-riot-load]');
    await waitFor(
      "document.querySelectorAll('[data-riot-match]').length >= 10 && !!document.querySelector('[data-riot-ranks]')",
      "profil simulé (rangs + 10 matchs)",
      40000,
    );
    const profile = await evaluate(`(() => {
      const root = document.querySelector('#view-profile');
      const solo = document.querySelector('[data-riot-rank="RANKED_SOLO_5x5"]');
      const flex = document.querySelector('[data-riot-rank="RANKED_FLEX_SR"]');
      return {
        soloTier: solo?.querySelector('.riot-rank-tier')?.textContent?.trim() ?? null,
        soloLp: solo?.querySelector('.riot-rank-lp')?.textContent?.trim() ?? null,
        flexTier: flex?.querySelector('.riot-rank-tier')?.textContent?.trim() ?? null,
        matches: document.querySelectorAll('[data-riot-match]').length,
        firstKda: document.querySelector('[data-riot-match] .riot-match-kda')?.textContent?.trim() ?? null,
        firstCs: document.querySelector('[data-riot-match] .riot-match-cs')?.textContent?.trim() ?? null,
        firstVision: document.querySelector('[data-riot-match] .riot-match-vision')?.textContent?.trim() ?? null,
        firstResult: document.querySelector('[data-riot-match] .riot-match-result')?.textContent?.trim() ?? null,
        cacheIndicator: document.querySelector('.riot-cache-indicator')?.textContent?.trim() ?? null,
        icons: Array.from(document.querySelectorAll('[data-riot-match] img.riot-match-champion-icon')).filter((img) => img.complete && img.naturalWidth > 0).length,
        text: root?.textContent?.replace(/\\s+/g, ' ').slice(0, 1200) ?? '',
      };
    })()`);
    check("mock_rank_solo", Boolean(profile.soloTier?.includes("CHALLENGER")), profile.soloTier ?? "");
    check("mock_rank_lp", Boolean(profile.soloLp?.replace(/\\s/g, "").includes("1234")), profile.soloLp ?? "");
    check("mock_rank_flex", Boolean(profile.flexTier?.includes("DIAMOND")), profile.flexTier ?? "");
    check("mock_matches_ten", profile.matches === 10, `${profile.matches} matchs`);
    check("mock_match_stats", Boolean(profile.firstKda && profile.firstCs && profile.firstVision), JSON.stringify({ kda: profile.firstKda, cs: profile.firstCs, vision: profile.firstVision }));
    check("mock_match_result", ["Victoire", "Défaite"].includes(profile.firstResult ?? ""), profile.firstResult ?? "");
    check("mock_cache_network", profile.cacheIndicator === "Données réseau", profile.cacheIndicator ?? "");
    check("mock_match_icons", profile.icons > 0, `${profile.icons} icônes locales chargées`);
    await capture("mock-profil.png");

    // --- Cache : un second chargement ne doit faire AUCUNE requête réseau.
    const beforeSecondLoad = await mockStats();
    await click('[data-riot-load]');
    await waitFor(
      `(() => {
        const el = document.querySelector('.riot-cache-indicator');
        const text = document.querySelector('#view-profile')?.textContent ?? '';
        return !!el && (el.textContent ?? '').includes('cache') && text.includes('Faker#EUW');
      })()`,
      "profil servi depuis le cache",
      30000,
    );
    await sleep(600);
    const afterSecondLoad = await mockStats();
    check(
      "mock_cache_no_network",
      Boolean(beforeSecondLoad && afterSecondLoad && beforeSecondLoad.totalRequests === afterSecondLoad.totalRequests),
      `requêtes mock avant=${beforeSecondLoad?.totalRequests}, après=${afterSecondLoad?.totalRequests}`,
    );
    const cacheIndicator = await evaluate("document.querySelector('.riot-cache-indicator')?.textContent?.trim() ?? null");
    check("mock_cache_indicator", cacheIndicator === "Données en cache", cacheIndicator ?? "");

    // --- Rafraîchissement forcé : quelques appels réseau (compte/league/liste), matchs restent en cache.
    await click('[data-riot-refresh]');
    await waitFor(
      "(() => { const el = document.querySelector('.riot-cache-indicator'); return !!el && el.textContent.includes('réseau'); })()",
      "rafraîchissement réseau",
      40000,
    );
    await sleep(600);
    const afterRefresh = await mockStats();
    check(
      "mock_force_refresh_network",
      Boolean(beforeSecondLoad && afterRefresh && afterRefresh.totalRequests > beforeSecondLoad.totalRequests),
      `requêtes mock après refresh=${afterRefresh?.totalRequests} (avant=${beforeSecondLoad?.totalRequests})`,
    );

    // --- Fiche de match (10 participants).
    await evaluate("document.querySelector('[data-riot-match]')?.click()");
    await waitFor(
      "(() => { const el = document.querySelector('#view-riot-match-detail'); return !!el && !el.hidden; })()",
      "fiche de match",
      30000,
    );
    await waitFor(
      "document.querySelectorAll('[data-riot-participant]').length >= 10",
      "10 participants",
      30000,
    );
    const match = await evaluate(`(() => {
      const root = document.querySelector('#view-riot-match-detail');
      return {
        participants: document.querySelectorAll('[data-riot-participant]').length,
        text: root?.textContent?.replace(/\\s+/g, ' ').slice(0, 900) ?? '',
        hasDuration: Boolean(root && root.textContent.includes('Durée')),
      };
    })()`);
    check("mock_match_detail", match.participants === 10, `${match.participants} participants`);
    check("mock_match_detail_duration", match.hasDuration, match.text.slice(0, 240));
    await capture("mock-match.png");
    await click('[data-action="back-match"]');
    await waitFor(
      "(() => { const el = document.querySelector('#view-profile'); return !!el && !el.hidden; })()",
      "retour Profil",
      15000,
    );

    // --- Progression personnelle (50 derniers matchs, serveur mock) ------
    await click('[data-progression-load]');
    await waitFor(
      "(() => { const el = document.querySelector('[data-progression]'); return !!el && !!el.querySelector('.progression-winrate'); })()",
      "progression personnelle",
      60000,
    );
    await sleep(700);
    const progression = await evaluate(`(() => {
      const root = document.querySelector('[data-progression]');
      const overall = root?.querySelector('[data-progression-overall]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
      const championRows = root?.querySelectorAll('[data-progression-champion]').length ?? 0;
      const roleRows = root?.querySelectorAll('[data-progression-role]').length ?? 0;
      const winrates = Array.from(root?.querySelectorAll('.progression-winrate') ?? []).map((el) => el.textContent?.trim());
      return { overall, championRows, roleRows, winrates: winrates.slice(0, 5), text: root?.textContent?.replace(/\\s+/g, ' ').slice(0, 600) ?? '' };
    })()`);
    check("progression_rendered", Boolean(progression.overall), progression.overall.slice(0, 180));
    check("progression_winrate", Boolean(progression.winrates?.[0]?.includes("%")), JSON.stringify(progression.winrates));
    check("progression_champions", progression.championRows >= 3, `${progression.championRows} lignes champion`);
    check("progression_roles", progression.roleRows >= 1, `${progression.roleRows} lignes rôle`);
    check("progression_games_50", Boolean(progression.text.includes("50")), progression.overall.slice(0, 180));
    await capture("mock-progression.png");
  }

  socket.close();
  console.log("\n=== RÉSUMÉ ===");
  console.log(JSON.stringify({ mode: options.mode, ok: failures.length === 0, checks, failures }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`scénarios Riot : ${error?.stack ?? error}`);
  process.exit(1);
});
