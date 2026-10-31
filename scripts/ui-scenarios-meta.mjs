// Scénarios UI V0.6 — onglet Méta (tier list + builds OP.GG, données réelles).
//
// Prérequis : app lancée avec WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// Usage : node scripts/ui-scenarios-meta.mjs --port 9333 --out-dir docs
//
// OP.GG MCP est public (sans clé) : ces scénarios valident des données RÉELLES
// (mises en cache par le backend). Aucune donnée n'est simulée ici.

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
  const waitFor = async (expression, label, timeoutMs = 45000) => {
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

  // --- Onglet Méta ------------------------------------------------------
  const tabClicked = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .nav-tab, .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Méta');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  check("meta_tab", tabClicked, "onglet Méta introuvable");
  await waitFor(
    "(() => { const el = document.querySelector('#view-meta'); return !!el && !el.hidden; })()",
    "vue Méta visible",
    20000,
  );
  await waitFor(
    "(() => { const s = document.querySelector('[data-meta-platform]'); return !!s && s.options.length > 1; })()",
    "plateformes Méta chargées",
    30000,
  );
  await evaluate(`(() => {
    const s = document.querySelector('[data-meta-platform]');
    const opt = Array.from(s.options).find((o) => o.value.toUpperCase() === 'EUW1') ?? s.options[0];
    s.value = opt.value;
    s.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  // La tier list se charge à l'arrivée ; forcer la vue « tous rôles » puis
  // bouton de chargement en secours si besoin.
  await click('[data-meta-tier-role="all"]');
  await sleep(400);
  let loaded = false;
  for (let attempt = 0; attempt < 3 && !loaded; attempt += 1) {
    try {
      await waitFor("document.querySelectorAll('[data-tier-entry]').length >= 100", "tier list", attempt === 0 ? 45000 : 20000);
      loaded = true;
    } catch {
      await click('[data-meta-load]');
      await sleep(800);
    }
  }
  check("meta_tier_loaded", loaded, "aucune entrée de tier list");
  await sleep(600);

  const tier = await evaluate(`(() => {
    const entries = Array.from(document.querySelectorAll('[data-tier-entry]'));
    const first = entries[0];
    const sourceEl = document.querySelector('[data-meta-source]')?.textContent?.trim() ?? null;
    const source = sourceEl ?? (document.body.textContent.includes('OP.GG') ? 'OP.GG' : null);
    return {
      count: entries.length,
      firstKey: first?.getAttribute('data-champion-key') ?? null,
      firstName: first?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? null,
      firstWin: first?.querySelector('.meta-tier-winrate')?.textContent?.trim() ?? null,
      firstRank: first?.querySelector('.meta-tier-rank')?.textContent?.trim() ?? null,
      firstGames: first?.querySelector('.meta-tier-games')?.textContent?.trim() ?? null,
      sourceText: source,
      fetchedAt: document.querySelector('[data-meta-fetched-at]')?.textContent?.trim() ?? null,
      text: document.querySelector('#view-meta')?.textContent?.replace(/\\s+/g, ' ').slice(0, 500) ?? '',
    };
  })()`);
  check("meta_tier_entries", Boolean(tier && tier.count >= 100), `${tier?.count ?? 0} entrées`);
  check("meta_tier_first", Boolean(tier?.firstKey && tier.firstName), JSON.stringify({ key: tier?.firstKey, name: tier?.firstName }));
  check("meta_tier_metrics", Boolean(tier?.firstWin?.includes("%") && tier?.firstRank && tier?.firstGames), JSON.stringify({ win: tier?.firstWin, rank: tier?.firstRank, games: tier?.firstGames }));
  check("meta_source", Boolean(tier?.text.includes("OP.GG")), tier?.sourceText ?? "");
  await capture("v0.6-meta-tierlist.png");

  // Filtre de rôle.
  const roleClicked = await click('[data-meta-tier-role="mid"]');
  check("meta_tier_role_click", roleClicked, "filtre rôle mid introuvable");
  if (roleClicked) {
    await sleep(600);
    const mid = await evaluate(`(() => ({
      count: document.querySelectorAll('[data-tier-entry]').length,
      text: document.querySelector('#view-meta')?.textContent?.replace(/\\s+/g, ' ').slice(0, 300) ?? '',
    }))()`);
    check("meta_tier_role_filtered", mid.count >= 50, `${mid.count} entrées mid`);
  }

  // --- Builds -----------------------------------------------------------
  const buildsTab = await click('[data-meta-subtab="builds"]');
  check("meta_builds_tab", buildsTab, "sous-onglet Builds introuvable");
  await sleep(500);
  await waitFor(
    "(() => { const s = document.querySelector('[data-meta-champion]'); return !!s && s.options.length >= 100; })()",
    "sélecteur de champions",
    30000,
  );
  const selects = await evaluate(`(() => {
    const champion = document.querySelector('[data-meta-champion]');
    const role = document.querySelector('[data-meta-role]');
    const tierSelect = document.querySelector('[data-meta-build-tier]');
    const pick = (select, wanted) => {
      if (!select) return false;
      const wantedUpper = wanted.toUpperCase();
      const opt = Array.from(select.options).find((o) => o.value.toUpperCase() === wantedUpper)
        ?? Array.from(select.options).find((o) => (o.textContent ?? '').toUpperCase().includes(wantedUpper));
      if (!opt) return false;
      select.value = opt.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const championOk = pick(champion, 'Ahri');
    const roleOk = pick(role, 'mid');
    const tierOk = tierSelect ? pick(tierSelect, 'challenger') : true;
    return { championOk, roleOk, tierOk, championOptions: champion?.options.length ?? 0, tierOptions: tierSelect?.options.length ?? 0 };
  })()`);
  check("meta_builds_selectors", Boolean(selects.championOk && selects.roleOk), JSON.stringify(selects));
  await click('[data-meta-load-build]');
  await waitFor(
    "(() => document.querySelectorAll('[data-build-item]').length >= 1 && !!document.querySelector('[data-meta-builds]'))()",
    "builds OP.GG",
    60000,
  );
  await sleep(700);
  const build = await evaluate(`(() => {
    const root = document.querySelector('[data-meta-builds]');
    const items = Array.from(root?.querySelectorAll('[data-build-item]') ?? []).map((el) => ({
      name: el.querySelector('.build-item-name')?.textContent?.trim() ?? null,
      pickRate: el.querySelector('.build-item-pickrate')?.textContent?.trim() ?? null,
    }));
    const sections = Array.from(root?.querySelectorAll('[data-build-section]') ?? []).map((el) => el.getAttribute('data-build-section'));
    const summary = root?.querySelector('.build-summary')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null;
    return { itemCount: items.length, items: items.slice(0, 16), sections, summary, text: root?.textContent?.replace(/\\s+/g, ' ').slice(0, 700) ?? '' };
  })()`);
  check("meta_builds_items", Boolean(build && build.itemCount >= 1), JSON.stringify(build?.items?.slice(0, 5)));
  check("meta_builds_sections", Boolean(build && ["starter", "boots", "core"].every((s) => build.sections.includes(s))), JSON.stringify(build?.sections));
  check("meta_builds_names", Boolean(build?.items?.[0]?.name && build.items[0].name !== "—"), JSON.stringify(build?.items?.[0]));
  check("meta_builds_pickrate", Boolean(build?.items?.[0]?.pickRate?.includes("%")), build?.items?.[0]?.pickRate ?? "");
  check("meta_builds_source", Boolean(build?.text.includes("OP.GG")), build?.summary ?? "");
  await capture("v0.6-meta-builds.png");

  socket.close();
  console.log("\n=== RÉSUMÉ ===");
  console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`scénarios Méta : ${error?.stack ?? error}`);
  process.exit(1);
});
