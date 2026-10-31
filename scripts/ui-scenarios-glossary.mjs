// Scénarios UI V0.8 — Glossaire intégré (dictionnaire local, sans réseau).
//
// Prérequis : app lancée avec WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
// Usage : node scripts/ui-scenarios-glossary.mjs --port 9333 --out-dir docs

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
  const waitFor = async (expression, label, timeoutMs = 20000) => {
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
  const click = async (selector) =>
    evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; el.click(); return true; })()`);
  const setSearch = async (value) =>
    evaluate(`(() => {
      const input = document.querySelector('[data-glossary-search]');
      if (!input) return false;
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);

  await send("Page.enable");
  await send("Runtime.enable");

  const tabClicked = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .nav-tab, .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Glossaire');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  check("glossary_tab", tabClicked, "onglet Glossaire introuvable");
  await waitFor(
    "(() => { const el = document.querySelector('#view-glossary'); return !!el && !el.hidden; })()",
    "vue Glossaire",
    20000,
  );
  await sleep(400);

  const initial = await evaluate(`(() => ({
    entries: document.querySelectorAll('[data-glossary-entry]').length,
    count: document.querySelector('[data-glossary-count]')?.textContent?.trim() ?? '',
    categories: Array.from(document.querySelectorAll('[data-glossary-category]')).map((b) => b.getAttribute('data-glossary-category')),
    empty: !!document.querySelector('[data-glossary-empty]:not([hidden])'),
    tabs: document.querySelectorAll('[role="tab"]').length,
  }))()`);
  check("glossary_entries", initial.entries >= 100, `${initial.entries} termes`);
  check("glossary_count", initial.count.includes("terme"), initial.count);
  check("glossary_categories", initial.categories.includes("all") && initial.categories.includes("carte") && initial.categories.length >= 8, JSON.stringify(initial.categories));
  check("glossary_nav_seven_tabs", initial.tabs >= 7, `${initial.tabs} onglets`);
  check("glossary_not_empty", initial.empty === false, "état vide affiché à tort");
  await capture("v0.8-glossaire.png");

  // Recherche par terme.
  await setSearch("gank");
  await sleep(250);
  const gank = await evaluate(`(() => ({
    entries: document.querySelectorAll('[data-glossary-entry]').length,
    terms: Array.from(document.querySelectorAll('.glossary-term')).map((t) => t.textContent?.trim()),
    count: document.querySelector('[data-glossary-count]')?.textContent?.trim() ?? '',
  }))()`);
  check("glossary_search_gank", gank.entries >= 1 && gank.terms.includes("Gank"), JSON.stringify(gank));

  // Recherche par alias anglais.
  await setSearch("creep score");
  await sleep(250);
  const alias = await evaluate(`(() => ({
    entries: document.querySelectorAll('[data-glossary-entry]').length,
    terms: Array.from(document.querySelectorAll('.glossary-term')).map((t) => t.textContent?.trim()),
  }))()`);
  check("glossary_search_alias", alias.entries >= 1 && alias.terms.includes("CS"), JSON.stringify(alias));

  // Recherche sans résultat.
  await setSearch("zzzz-introuvable");
  await sleep(250);
  const empty = await evaluate(`(() => ({
    entries: document.querySelectorAll('[data-glossary-entry]').length,
    emptyVisible: !document.querySelector('[data-glossary-empty]')?.hidden,
    count: document.querySelector('[data-glossary-count]')?.textContent?.trim() ?? '',
  }))()`);
  check("glossary_empty_state", empty.entries === 0 && empty.emptyVisible, JSON.stringify(empty));

  // Catégorie + reset de recherche.
  await setSearch("");
  await click('[data-glossary-category="carte"]');
  await sleep(300);
  const category = await evaluate(`(() => ({
    entries: document.querySelectorAll('[data-glossary-entry]').length,
    active: document.querySelector('[data-glossary-category="carte"]')?.getAttribute('aria-selected'),
    allActive: document.querySelector('[data-glossary-category="all"]')?.getAttribute('aria-selected'),
    categories: Array.from(document.querySelectorAll('[data-glossary-entry]')).map((e) => e.getAttribute('data-category')),
  }))()`);
  check("glossary_category", category.entries >= 10 && category.active === "true" && category.allActive === "false", `${category.entries} termes carte`);
  check("glossary_category_filter", category.categories.every((c) => c === "carte"), JSON.stringify([...new Set(category.categories)]));

  // Lien « Voir aussi » : doit revenir à Tous et mettre le terme en évidence.
  await click('[data-glossary-category="all"]');
  await sleep(250);
  const relatedClicked = await evaluate(`(() => {
    const link = document.querySelector('[data-glossary-related="farm"]');
    if (!link) return false;
    link.click();
    return true;
  })()`);
  await sleep(500);
  const related = await evaluate(`(() => ({
    highlighted: document.querySelectorAll('.glossary-entry--highlight').length,
    allActive: document.querySelector('[data-glossary-category="all"]')?.getAttribute('aria-selected'),
    term: document.querySelector('.glossary-entry--highlight .glossary-term')?.textContent?.trim() ?? null,
  }))()`);
  check("glossary_related", relatedClicked && related.highlighted === 1 && related.allActive === "true" && related.term === "Farm", JSON.stringify(related));

  socket.close();
  console.log("\n=== RÉSUMÉ ===");
  console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`scénarios Glossaire : ${error?.stack ?? error}`);
  process.exit(1);
});
