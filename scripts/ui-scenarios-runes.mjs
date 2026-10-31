// Scénarios UI V0.7 — Rune Builder (3 pages de runes réelles OP.GG, sans clé).
//
// Prérequis : app lancée avec WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// Usage : node scripts/ui-scenarios-runes.mjs --port 9333 --out-dir docs
//
// Les pages viennent du MCP public OP.GG : données réelles, mises en cache 12 h.
// Aucune donnée n'est simulée dans ce scénario.

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

  // Onglet Runes.
  const tabClicked = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .nav-tab, .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Runes');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  check("runes_tab", tabClicked, "onglet Runes introuvable");
  // Le scénario de non-régression se termine sur une fiche rune : revenir aux arbres.
  await click('[data-action="back-rune"]');
  await sleep(300);
  await waitFor(
    "(() => { const el = document.querySelector('#view-runes'); return !!el && !el.hidden; })()",
    "vue Runes",
    20000,
  );

  const subTab = await click('[data-runes-subtab="builder"]');
  check("runes_builder_subtab", subTab, "sous-onglet Rune Builder introuvable");
  await sleep(400);
  await waitFor(
    "(() => { const s = document.querySelector('[data-builder-champion]'); return !!s && s.options.length >= 100; })()",
    "sélecteur champion",
    30000,
  );

  const fill = async (champion, position) =>
    evaluate(`(() => {
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
      const championOk = pick(document.querySelector('[data-builder-champion]'), ${JSON.stringify(champion)});
      const roleOk = pick(document.querySelector('[data-builder-role]'), ${JSON.stringify(position)});
      return { championOk, roleOk, championOptions: document.querySelector('[data-builder-champion]')?.options.length ?? 0 };
    })()`);

  const selected = await fill("Ahri", "mid");
  check("builder_selectors", Boolean(selected.championOk && selected.roleOk), JSON.stringify(selected));
  await click('[data-builder-load]');
  await waitFor(
    "document.querySelectorAll('[data-builder-page]').length === 3",
    "3 pages de runes",
    90000,
  );
  await sleep(800);

  const pages = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-builder-page]'));
    return cards.map((card) => {
      const runes = Array.from(card.querySelectorAll('[data-builder-rune]'));
      const primary = card.querySelector('[data-builder-primary-tree]');
      const secondary = card.querySelector('[data-builder-secondary-tree]');
      const icons = Array.from(card.querySelectorAll('img.builder-rune-icon'));
      return {
        scope: card.getAttribute('data-page-scope'),
        scopeLabel: card.querySelector('.builder-page-scope')?.textContent?.trim() ?? null,
        winrate: card.querySelector('.builder-page-winrate')?.textContent?.trim() ?? null,
        pickrate: card.querySelector('.builder-page-pickrate')?.textContent?.trim() ?? null,
        games: card.querySelector('.builder-page-games')?.textContent?.trim() ?? null,
        primaryText: primary?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? null,
        secondaryText: secondary?.textContent?.replace(/\\s+/g, ' ').trim().slice(0, 160) ?? null,
        runeCount: runes.length,
        runeIds: runes.map((r) => r.getAttribute('data-rune-id')),
        runeNames: runes.map((r) => r.querySelector('.builder-rune-name')?.textContent?.trim() ?? r.textContent?.trim()?.slice(0, 40)),
        statMods: Array.from(card.querySelectorAll('[data-builder-stat-mod]')).map((el) => el.textContent?.trim()),
        iconsLoaded: icons.filter((img) => img.complete && img.naturalWidth > 0).length,
        iconCount: icons.length,
        text: card.textContent?.replace(/\\s+/g, ' ').slice(0, 500) ?? '',
      };
    });
  })()`);
  check("builder_three_pages", pages.length === 3, `${pages.length} pages`);
  check(
    "builder_scopes",
    ["challenger", "grandmaster", "all"].every((scope) => pages.some((p) => p.scope === scope)),
    JSON.stringify(pages.map((p) => p.scope)),
  );
  check(
    "builder_primary_runes",
    pages.every((p) => p.runeCount === 6),
    JSON.stringify(pages.map((p) => p.runeCount)),
  );
  check(
    "builder_stat_mods",
    pages.every((p) => p.statMods.length === 3 && p.statMods.every((s) => s && s.length > 0)),
    JSON.stringify(pages.map((p) => p.statMods)),
  );
  check(
    "builder_metrics",
    pages.every((p) => p.winrate?.includes("%") && p.pickrate?.includes("%") && p.games),
    JSON.stringify(pages.map((p) => ({ w: p.winrate, p: p.pickrate, g: p.games }))),
  );
  check(
    "builder_icons",
    pages.every((p) => p.iconCount >= 6 && p.iconsLoaded >= 6),
    JSON.stringify(pages.map((p) => ({ loaded: p.iconsLoaded, count: p.iconCount }))),
  );
  const sourceText = await evaluate(
    "document.querySelector('.builder-source')?.textContent?.trim() ?? document.querySelector('[data-rune-builder]')?.textContent?.trim() ?? ''",
  );
  check("builder_source", Boolean(sourceText.includes("OP.GG")), sourceText.slice(0, 180));
  await capture("v0.7-rune-builder.png");

  // Deuxième champion / rôle (avec cache attendu au 2e appel identique).
  const selected2 = await fill("Dr. Mundo", "top");
  check("builder_selectors_2", Boolean(selected2.championOk && selected2.roleOk), JSON.stringify(selected2));
  let secondLoaded = false;
  let secondError = null;
  for (let attempt = 0; attempt < 3 && !secondLoaded; attempt += 1) {
    await click('[data-builder-load]');
    try {
      await waitFor(
        "(() => { const cards = Array.from(document.querySelectorAll('[data-builder-page]')); return cards.length === 3 && cards.every((c) => /Volonté|Resolve/.test(c.querySelector('[data-builder-primary-tree]')?.textContent ?? '')); })()",
        "3 pages Dr. Mundo (Volonté/Resolve)",
        60000,
      );
      secondLoaded = true;
    } catch {
      secondError = await evaluate("document.querySelector('[data-builder-error]')?.textContent?.trim() ?? null");
      await sleep(2500);
    }
  }
  check("builder_second_champion_loaded", secondLoaded, secondError ?? "");
  await sleep(1000);
  const second = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-builder-page]'));
    return cards.map((card) => ({
      scope: card.getAttribute('data-page-scope'),
      runeCount: card.querySelectorAll('[data-builder-rune]').length,
      statMods: card.querySelectorAll('[data-builder-stat-mod]').length,
      text: card.textContent?.replace(/\\s+/g, ' ').slice(0, 220) ?? '',
    }));
  })()`);
  check("builder_second_champion", second.length === 3 && second.every((p) => p.runeCount === 6 && p.statMods === 3), JSON.stringify(second.map((p) => ({ s: p.scope, r: p.runeCount, m: p.statMods }))));

  socket.close();
  console.log("\n=== RÉSUMÉ ===");
  console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`scénarios Rune Builder : ${error?.stack ?? error}`);
  process.exit(1);
});
