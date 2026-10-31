// Scénarios UI V0.2 pilotés par le protocole DevTools (CDP) de WebView2.
//
// Prérequis : l'application LoL BOT est lancée avec
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333
//
// Usage :
//   node scripts/ui-scenarios.mjs --port 9333 --out-dir docs
//
// Scénarios :
//   1. attend la grille des champions (Data Dragon synchronisé) ;
//   2. clique sur « Aatrox », vérifie la fiche (splash chargé, stats, 4 sorts
//      avec cooldown/coût) et capture docs/v0.2-champion-aatrox.png ;
//   3. revient à la grille, ouvre l'onglet « Objets », vérifie la grille et
//      capture docs/v0.2-items.png ;
//   4. recherche « Infinity Edge », vérifie le résultat et capture
//      docs/v0.2-items-infinity-edge.png ;
//   5. filtre par catégorie « Damage », vérifie le compteur.
//
// Sortie : rapport JSON sur stdout, code 1 si un contrôle échoue.

import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const options = { port: Number(process.env.CDP_PORT ?? 9333), outDir: "docs" };
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
  const listUrl = `http://127.0.0.1:${options.port}/json/list`;
  const targets = await (await fetch(listUrl)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error(`aucune cible WebView sur ${listUrl}`);

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
      throw new Error(`évaluation JS : ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ""}`);
    }
    return result.result?.value;
  };

  const waitFor = async (expression, label, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    let last;
    while (Date.now() < deadline) {
      last = await evaluate(expression);
      if (last) return last;
      await sleep(250);
    }
    throw new Error(`délai dépassé en attendant « ${label} » (dernier résultat : ${JSON.stringify(last)})`);
  };

  const capture = async (name) => {
    const response = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    const base64 = response.result?.data;
    if (!base64) throw new Error(`capture ${name} : aucune donnée`);
    const path = resolve(outDir, name);
    writeFileSync(path, Buffer.from(base64, "base64"));
    console.log(`CAPTURE ${path}`);
  };

  const screenshot = async (name) => {
    await evaluate("window.scrollTo(0, 0)");
    await sleep(400);
    await capture(name);
  };

  await send("Page.enable");
  await send("Runtime.enable");

  // --- 1. Grille des champions -----------------------------------------
  const championsReady = await waitFor(
    "document.querySelectorAll('[data-champion-id], .champ-card').length >= 150",
    "grille des champions",
    180000,
  );
  check("champions_grid", championsReady, `${await evaluate("document.querySelectorAll('[data-champion-id], .champ-card').length")} cartes`);
  await sleep(1200);

  // Filtre par classe Data Dragon (V0.9).
  const classTags = await evaluate(`(() => ({
    count: document.querySelectorAll('[data-champion-tag]').length,
    labels: Array.from(document.querySelectorAll('[data-champion-tag]')).map((b) => b.getAttribute('data-champion-tag')),
  }))()`);
  check("champion_class_filter", classTags.count >= 6 && classTags.labels.includes("Fighter"), JSON.stringify(classTags.labels));
  const fighterClicked = await evaluate(`(() => {
    const chip = document.querySelector('[data-champion-tag="Fighter"]');
    if (!chip) return false;
    chip.click();
    return true;
  })()`);
  await sleep(350);
  const fighterState = await evaluate(`(() => ({
    cards: document.querySelectorAll('[data-champion-id], .champ-card').length,
    pressed: document.querySelector('[data-champion-tag="Fighter"]')?.getAttribute('aria-pressed') ?? null,
    counter: document.querySelector('.champ-toolbar .champ-count')?.textContent?.trim() ?? null,
  }))()`);
  check("champion_class_filter_apply", fighterClicked && fighterState.cards > 0 && fighterState.cards < 173 && fighterState.pressed === "true", JSON.stringify(fighterState));
  await evaluate(`document.querySelector('[data-champion-tag="all"]')?.click()`);
  await sleep(300);
  const allState = await evaluate(`(() => ({
    cards: document.querySelectorAll('[data-champion-id], .champ-card').length,
    pressed: document.querySelector('[data-champion-tag="all"]')?.getAttribute('aria-pressed') ?? null,
  }))()`);
  check("champion_class_filter_reset", allState.cards === 173 && allState.pressed === "true", JSON.stringify(allState));

  // --- 2. Fiche Aatrox --------------------------------------------------
  const clicked = await evaluate(`(() => {
    const card = document.querySelector('[data-champion-id="Aatrox"]');
    if (!card) return false;
    card.click();
    return true;
  })()`);
  check("aatrox_card_click", clicked, "carte Aatrox introuvable");

  await waitFor(
    "(() => { const el = document.querySelector('[data-view=\"champion-detail\"], #view-champion-detail'); return !!el && !el.hidden; })()",
    "vue fiche champion",
    30000,
  );
  // Les images de la fiche sont en lazy-loading : on parcourt la page pour
  // déclencher leur chargement local avant de vérifier/capturer.
  await evaluate("window.scrollTo(0, document.documentElement.scrollHeight)");
  await sleep(900);
  await waitFor(
    `(() => {
      const splash = document.querySelector('.champion-splash, [data-splash]');
      const icons = Array.from(document.querySelectorAll('.spell-icon'));
      return Boolean(splash && splash.complete && icons.length >= 4 && icons.every((i) => i.complete));
    })()`,
    "splash + icônes de sorts chargés",
    45000,
  ).catch(() => undefined);
  await evaluate("window.scrollTo(0, 0)");
  await sleep(300);

  const detail = await evaluate(`(() => {
    const root = document.querySelector('[data-view="champion-detail"], #view-champion-detail');
    if (!root) return null;
    const text = (selector) => root.querySelector(selector)?.textContent?.trim() ?? null;
    const stat = (key) => root.querySelector('[data-stat="' + key + '"]')?.textContent?.trim() ?? null;
    const splash = root.querySelector('.champion-splash, [data-splash]');
    const spells = Array.from(root.querySelectorAll('[data-spell]')).map((el, index) => ({
      index,
      name: el.querySelector('[data-spell-name]')?.textContent?.trim() ?? null,
      cooldown: el.querySelector('[data-spell-cooldown]')?.textContent?.trim() ?? null,
      cost: el.querySelector('[data-spell-cost]')?.textContent?.trim() ?? null,
      iconLoaded: (() => { const img = el.querySelector('.spell-icon'); return Boolean(img && img.complete && img.naturalWidth > 0); })(),
    }));
    const passive = root.querySelector('[data-passive]');
    return {
      name: text('[data-champion-name], .detail-name, .champion-name, h1'),
      title: text('[data-champion-title], .detail-title, .champion-title'),
      splashLoaded: Boolean(splash && splash.complete && splash.naturalWidth > 0),
      splashSrc: splash?.src ?? null,
      stats: {
        hp: stat('hp'), mp: stat('mp'), armor: stat('armor'), magicResist: stat('magicResist'),
        attackDamage: stat('attackDamage'), attackSpeed: stat('attackSpeed'),
        moveSpeed: stat('moveSpeed'), attackRange: stat('attackRange'),
      },
      spells,
      passive: passive ? (passive.querySelector('[data-passive-name]')?.textContent?.trim() ?? 'présent') : null,
    };
  })()`);
  check("aatrox_detail_rendered", detail !== null, "racine de fiche absente");
  check("aatrox_name", detail?.name === "Aatrox", detail?.name ?? "aucun nom");
  check("aatrox_splash_loaded", detail?.splashLoaded, detail?.splashSrc ?? "aucun splash");
  const requiredStats = ["hp", "mp", "armor", "attackDamage", "moveSpeed"];
  check(
    "aatrox_stats",
    requiredStats.every((key) => detail?.stats?.[key] && detail.stats[key] !== "—"),
    JSON.stringify(detail?.stats ?? {}),
  );
  check("aatrox_spells_count", detail?.spells?.length >= 4, `${detail?.spells?.length ?? 0} sorts`);
  check(
    "aatrox_spells_content",
    Boolean(detail?.spells?.every((s) => s.name && s.cooldown !== null && s.cost !== null)),
    JSON.stringify(detail?.spells?.map((s) => `${s.name} cd=${s.cooldown} cost=${s.cost}`)),
  );
  check("aatrox_spell_icons", Boolean(detail?.spells?.length >= 4 && detail.spells.every((s) => s.iconLoaded)), "icônes locales de sorts");
  check("aatrox_title", Boolean(detail?.title && detail.title.length > 0), detail?.title ?? "");
  await screenshot("v0.2-champion-aatrox.png");
  // Capture de la section des sorts (preuve visuelle des 4 sorts).
  await evaluate(`(() => {
    const spell = document.querySelector('[data-spell]');
    if (spell) spell.scrollIntoView({ block: 'start' });
  })()`);
  await sleep(600);
  await screenshot("v0.2-champion-aatrox-sorts.png");
  await evaluate("window.scrollTo(0, 0)");

  // --- 3. Retour + onglet Objets ---------------------------------------
  const back = await evaluate(`(() => {
    const button = document.querySelector('[data-action="back"]');
    if (button) { button.click(); return true; }
    return false;
  })()`);
  check("back_to_champions", back, "bouton retour introuvable");
  await waitFor("document.querySelectorAll('[data-champion-id], .champ-card').length >= 150", "retour à la grille", 20000);
  await sleep(400);

  const itemsTab = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .nav-tab, .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Objets');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  check("items_tab_click", itemsTab, "onglet Objets introuvable");
  await waitFor(
    "(() => { const el = document.querySelector('#view-items'); return !!el && !el.hidden; })()",
    "vue Objets visible",
    20000,
  );
  const itemsCount = await waitFor(
    "document.querySelectorAll('[data-item-id], .item-card').length >= 800",
    "grille des objets",
    60000,
  );
  check("items_grid", itemsCount, `${await evaluate("document.querySelectorAll('[data-item-id], .item-card').length")} cartes`);
  await sleep(1500);
  const itemsState = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-item-id], .item-card'));
    const counter = document.querySelector('.items-count')?.textContent?.trim() ?? null;
    const filters = Array.from(document.querySelectorAll('.filter-bar [data-item-tag]')).map((c) => c.getAttribute('data-item-tag'));
    const loadedIcons = Array.from(document.querySelectorAll('.item-icon')).filter((i) => i.complete && i.naturalWidth > 0).length;
    return { cards: cards.length, counter, filters, loadedIcons };
  })()`);
  check("items_counter", Boolean(itemsState?.counter && itemsState.counter.includes("859")), itemsState?.counter ?? "aucun compteur");
  check("items_icons_loaded", Boolean(itemsState?.loadedIcons > 0), `${itemsState?.loadedIcons ?? 0} icônes chargées`);
  check("items_category_filters", Boolean(itemsState?.filters?.length >= 10), `${itemsState?.filters?.length ?? 0} catégories`);
  await screenshot("v0.2-items.png");

  const searchOk = await evaluate(`(() => {
    const input = document.querySelector('[data-items-search]')
      ?? Array.from(document.querySelectorAll('input[type="search"]')).find((i) => i.offsetParent !== null);
    if (!input) return false;
    input.focus();
    input.value = 'Infinity Edge';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  check("items_search_input", searchOk, "champ de recherche objets introuvable");
  await sleep(700);

  const filtered = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-item-id], .item-card'));
    const names = cards.map((c) => (c.querySelector('.item-name')?.textContent ?? c.textContent ?? '').trim());
    const counter = document.querySelector('.items-count')?.textContent?.trim() ?? null;
    return { count: cards.length, names: names.slice(0, 5), counter };
  })()`);
  check(
    "infinity_edge_search",
    Boolean(filtered && filtered.count >= 1 && filtered.names.some((name) => name.includes("Infinity Edge"))),
    JSON.stringify(filtered),
  );
  await screenshot("v0.2-items-infinity-edge.png");

  // --- 4. Filtre par catégorie ----------------------------------------
  await evaluate(`(() => {
    const input = document.querySelector('[data-items-search]')
      ?? Array.from(document.querySelectorAll('input[type="search"]')).find((i) => i.offsetParent !== null);
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(300);
  const filterClicked = await evaluate(`(() => {
    const chip = document.querySelector('.filter-bar [data-item-tag="Damage"]');
    if (!chip) return false;
    chip.click();
    return true;
  })()`);
  check("items_category_filter_present", filterClicked, "puce de catégorie Damage introuvable");
  if (filterClicked) {
    await sleep(500);
    const filterState = await evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('[data-item-id], .item-card'));
      const counter = document.querySelector('.items-count')?.textContent?.trim() ?? null;
      const chip = document.querySelector('.filter-bar [data-item-tag="Damage"]');
      return { cards: cards.length, counter, pressed: chip?.getAttribute('aria-pressed') ?? null };
    })()`);
    check(
      "items_category_filter",
      Boolean(filterState && filterState.cards > 0 && filterState.cards < 859 && filterState.pressed === "true"),
      JSON.stringify(filterState),
    );
    await screenshot("v0.2-items-filter.png");
  }

  // --- 5. Onglet Runes --------------------------------------------------
  const runesTab = await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .nav-tab, .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Runes');
    if (!tab) return false;
    tab.click();
    return true;
  })()`);
  check("runes_tab_click", runesTab, "onglet Runes introuvable");
  await waitFor(
    "(() => { const el = document.querySelector('#view-runes'); return !!el && !el.hidden; })()",
    "vue Runes visible",
    20000,
  );
  await waitFor(
    "document.querySelectorAll('[data-rune-tree]').length >= 5",
    "grille des 5 arbres de runes",
    30000,
  );
  await sleep(900);

  const trees = await evaluate(`(() => {
    const cards = Array.from(document.querySelectorAll('[data-rune-tree]'));
    return {
      count: cards.length,
      names: cards.map((c) => ({ key: c.getAttribute('data-rune-tree'), text: c.textContent.trim() })),
      counter: document.querySelector('#view-runes .runes-count')?.textContent?.trim() ?? null,
    };
  })()`);
  const expectedTrees = ["Précision", "Volonté", "Sorcellerie", "Domination", "Inspiration"];
  check("runes_trees_five", trees?.count === 5, JSON.stringify(trees?.names));
  check(
    "runes_trees_french",
    Boolean(trees && expectedTrees.every((name) => trees.names.some((card) => card.text.includes(name)))),
    JSON.stringify(trees?.names?.map((card) => card.text)),
  );

  const precisionClicked = await evaluate(`(() => {
    const card = document.querySelector('[data-rune-tree="Precision"]');
    if (!card) return false;
    card.click();
    return true;
  })()`);
  check("runes_precision_click", precisionClicked, "carte Précision introuvable");
  await waitFor(
    "!!document.querySelector('[data-selected-tree=\"Precision\"]')",
    "panneau Précision",
    15000,
  );
  await evaluate(`(() => {
    const section = document.querySelector('[data-selected-tree="Precision"] [data-rune-section="keystones"]');
    if (section) section.scrollIntoView({ block: 'start' });
  })()`);
  await sleep(900);
  await waitFor(
    "document.querySelectorAll('[data-selected-tree=\"Precision\"] img.rune-icon').length >= 4",
    "icônes de runes chargées",
    30000,
  ).catch(() => undefined);

  const precision = await evaluate(`(() => {
    const panel = document.querySelector('[data-selected-tree="Precision"]');
    if (!panel) return null;
    const runeCards = Array.from(panel.querySelectorAll('[data-rune-id]'));
    const runeNames = Array.from(panel.querySelectorAll('[data-rune-name]')).map((n) => n.textContent.trim());
    const keystones = panel.querySelectorAll('[data-rune-section="keystones"] [data-rune-id]').length;
    const conqueror = panel.querySelector('[data-rune-id="8010"]');
    const conquerorIcon = conqueror?.querySelector('img.rune-icon');
    return {
      runes: runeCards.length,
      keystones,
      names: runeNames,
      hasConquerant: runeNames.includes("Conquérant"),
      hasCoupDeGrace: runeNames.includes("Coup de grâce"),
      hasBaroud: runeNames.includes("Baroud d'honneur"),
      conquerorName: conqueror?.querySelector('[data-rune-name]')?.textContent?.trim() ?? null,
      conquerorIconLoaded: Boolean(conquerorIcon && conquerorIcon.complete && conquerorIcon.naturalWidth > 0),
    };
  })()`);
  check("runes_precision_selected", precision !== null, "panneau Précision absent");
  check("runes_keystones_four", precision?.keystones === 4, `${precision?.keystones ?? 0} keystones`);
  check("runes_tree_total", precision?.runes === 13, `${precision?.runes ?? 0} runes dans Précision`);
  check(
    "runes_precision_french_names",
    Boolean(precision?.hasConquerant && precision.hasCoupDeGrace && precision.hasBaroud),
    JSON.stringify(precision?.names),
  );
  check("runes_conquerant_8010", precision?.conquerorName === "Conquérant", precision?.conquerorName ?? "introuvable");
  check("runes_conquerant_icon", precision?.conquerorIconLoaded, "icône de Conquérant non chargée");
  await capture("v0.3-runes-precision.png");

  // Recherche de rune (nom FR puis nom EN, même rune officielle).
  const runesSearch = await evaluate(`(() => {
    const input = document.querySelector('[data-runes-search]');
    if (!input) return false;
    input.focus();
    input.value = 'Conquérant';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  check("runes_search_input", runesSearch, "champ de recherche runes introuvable");
  await waitFor("!!document.querySelector('[data-rune-results]')", "résultats de recherche runes", 15000);
  await sleep(500);
  const searchFr = await evaluate(`(() => {
    const results = Array.from(document.querySelectorAll('[data-rune-results] [data-rune-result]'));
    const names = results.map((r) => r.querySelector('[data-rune-name]')?.textContent?.trim() ?? r.textContent.trim());
    const counter = document.querySelector('#view-runes .runes-count')?.textContent?.trim() ?? null;
    return { count: results.length, names, counter };
  })()`);
  check(
    "runes_search_french",
    Boolean(searchFr && searchFr.count >= 1 && searchFr.names.some((name) => name.includes("Conquérant"))),
    JSON.stringify(searchFr),
  );
  await screenshot("v0.3-runes-search.png");

  await evaluate(`(() => {
    const input = document.querySelector('[data-runes-search]');
    if (input) { input.value = 'Conqueror'; input.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(600);
  const searchEn = await evaluate(`(() => {
    const results = Array.from(document.querySelectorAll('[data-rune-results] [data-rune-result]'));
    return results.map((r) => r.querySelector('[data-rune-name]')?.textContent?.trim() ?? '');
  })()`);
  check("runes_search_english", Boolean(searchEn && searchEn.some((name) => name.includes("Conquérant"))), JSON.stringify(searchEn));

  // Efface la recherche pour une capture de la vue globale.
  await evaluate(`(() => {
    const input = document.querySelector('[data-runes-search]');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(400);
  await evaluate(`window.scrollTo(0, 0)`);
  await sleep(300);
  await screenshot("v0.3-runes.png");

  // --- 6. Fiche objet (V0.4) --------------------------------------------
  await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .nav-tab, .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Objets');
    if (tab) tab.click();
  })()`);
  await waitFor(
    "(() => { const el = document.querySelector('#view-items'); return !!el && !el.hidden; })()",
    "vue Objets visible",
    15000,
  );
  // Réinitialise l'éventuel filtre de catégorie resté actif.
  await evaluate(`(() => {
    const all = document.querySelector('.filter-bar .filter-chip');
    if (all) all.click();
    const input = document.querySelector('[data-items-search]');
    if (input) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
  })()`);
  await sleep(300);
  await evaluate(`(() => {
    const input = document.querySelector('[data-items-search]');
    input.focus();
    input.value = 'Infinity Edge';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor("!!document.querySelector('[data-item-id=\"3031\"]')", "carte Infinity Edge (3031)", 15000);
  await evaluate("document.querySelector('[data-item-id=\"3031\"]').click()");
  await waitFor(
    "(() => { const el = document.querySelector('#view-item-detail'); return !!el && !el.hidden; })()",
    "fiche objet",
    15000,
  );
  await sleep(500);
  const itemDetail = await evaluate(`(() => {
    const root = document.querySelector('#view-item-detail, [data-view="item-detail"]');
    if (!root) return null;
    const gold = root.querySelector('.item-detail-gold')?.textContent?.trim() ?? '';
    const components = Array.from(root.querySelectorAll('[data-recipe-item-id]')).map((el) => ({
      id: el.getAttribute('data-recipe-item-id'),
      text: el.textContent.trim().replace(/\\s+/g, ' '),
    }));
    return {
      id: root.getAttribute('data-item-detail-id') ?? null,
      name: root.querySelector('.item-detail-name')?.textContent?.trim() ?? null,
      gold,
      goldDigits: gold.replace(/\\D/g, ''),
      components,
      text: root.textContent.replace(/\\s+/g, ' ').slice(0, 900),
    };
  })()`);
  check("item_detail_rendered", itemDetail !== null, "racine fiche objet absente");
  check("item_detail_infinity_edge", Boolean(itemDetail?.name?.includes("Infinity Edge")), itemDetail?.name ?? "");
  check("item_detail_gold", Boolean(itemDetail?.goldDigits?.includes("3500")), itemDetail?.gold ?? "");
  const componentIds = (itemDetail?.components ?? []).map((c) => c.id);
  check(
    "item_detail_recipe",
    ["1038", "1037", "1018"].every((id) => componentIds.includes(id)),
    JSON.stringify(itemDetail?.components?.map((c) => `${c.id}:${c.text}`)),
  );
  await screenshot("v0.4-item-detail.png");

  // Navigation vers un composant de la recette (B. F. Sword).
  await evaluate("document.querySelector('[data-recipe-item-id=\"1038\"]').click()");
  await waitFor(
    "(() => { const el = document.querySelector('#view-item-detail'); return !!el && !el.hidden && el.getAttribute('data-item-detail-id') === '1038'; })()",
    "fiche objet composant 1038",
    15000,
  );
  const componentDetail = await evaluate("document.querySelector('#view-item-detail .item-detail-name')?.textContent?.trim() ?? null");
  check("item_detail_component_navigation", componentDetail === "B. F. Sword", componentDetail ?? "");

  // Retour à la grille des objets.
  await evaluate("document.querySelector('[data-action=\"back-item\"]')?.click()");
  await waitFor(
    "(() => { const el = document.querySelector('#view-items'); return !!el && !el.hidden; })()",
    "retour grille objets",
    15000,
  );

  // --- 7. Fiche rune (V0.4) ---------------------------------------------
  await evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('[role="tab"], .nav-tab, .tab'));
    const tab = tabs.find((t) => (t.textContent ?? '').trim() === 'Runes');
    if (tab) tab.click();
  })()`);
  await waitFor(
    "(() => { const el = document.querySelector('#view-runes'); return !!el && !el.hidden; })()",
    "vue Runes visible",
    15000,
  );
  await waitFor("!!document.querySelector('[data-selected-tree=\"Precision\"]')", "panneau Précision", 15000);
  await evaluate("document.querySelector('[data-rune-id=\"8010\"]')?.click()");
  await waitFor(
    "(() => { const el = document.querySelector('#view-rune-detail'); return !!el && !el.hidden; })()",
    "fiche rune",
    15000,
  );
  await sleep(400);
  const runeDetail = await evaluate(`(() => {
    const root = document.querySelector('#view-rune-detail, [data-view="rune-detail"]');
    if (!root) return null;
    const longDesc = root.querySelector('[data-rune-long-desc]')?.textContent?.trim() ?? '';
    return {
      id: root.getAttribute('data-rune-detail-id') ?? null,
      name: root.querySelector('.rune-detail-name')?.textContent?.trim() ?? null,
      longDescLength: longDesc.length,
      longDescSample: longDesc.slice(0, 120),
      text: root.textContent.replace(/\\s+/g, ' ').slice(0, 700),
    };
  })()`);
  check("rune_detail_rendered", runeDetail !== null, "racine fiche rune absente");
  check("rune_detail_conquerant", Boolean(runeDetail?.name?.includes("Conquérant")), runeDetail?.name ?? "");
  check("rune_detail_long_desc", Boolean(runeDetail?.longDescLength >= 100), `${runeDetail?.longDescLength ?? 0} caractères`);
  await screenshot("v0.4-rune-detail.png");
  await evaluate("document.querySelector('[data-action=\"back-rune\"]')?.click()");
  await waitFor(
    "(() => { const el = document.querySelector('#view-runes'); return !!el && !el.hidden; })()",
    "retour onglet Runes",
    15000,
  );

  // --- 8. Recherche globale (V0.4) --------------------------------------
  async function globalSearch(query) {
    return evaluate(`(() => {
      const input = document.querySelector('[data-global-search]');
      if (!input) return false;
      input.focus();
      input.value = ${JSON.stringify(query)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  check("global_search_present", await globalSearch("Ahri"), "champ de recherche globale introuvable");
  await waitFor("!!document.querySelector('[data-search-results]')", "résultats de recherche globale", 15000);
  await sleep(400);
  const championResults = await evaluate(`(() => {
    const results = Array.from(document.querySelectorAll('[data-search-result]'));
    return results.map((r) => ({
      type: r.getAttribute('data-result-type'),
      id: r.getAttribute('data-result-id'),
      text: r.textContent.trim().replace(/\\s+/g, ' '),
    }));
  })()`);
  check(
    "global_search_champion",
    Boolean(championResults?.some((r) => r.type === "champion" && r.id === "Ahri")),
    JSON.stringify(championResults?.slice(0, 6)),
  );
  await screenshot("v0.4-global-search.png");
  await evaluate("document.querySelector('[data-search-result][data-result-type=\"champion\"][data-result-id=\"Ahri\"]')?.click()");
  await waitFor(
    "(() => { const el = document.querySelector('#view-champion-detail'); return !!el && !el.hidden; })()",
    "fiche champion via recherche globale",
    25000,
  );
  await waitFor(
    "(() => { const n = document.querySelector('#view-champion-detail .detail-name'); return !!n && n.textContent.trim() === 'Ahri'; })()",
    "fiche Ahri chargée",
    25000,
  ).catch(() => undefined);
  const searchedChampion = await evaluate("document.querySelector('#view-champion-detail .detail-name')?.textContent?.trim() ?? null");
  check("global_search_opens_champion", searchedChampion === "Ahri", searchedChampion ?? "");
  await evaluate("document.querySelector('[data-action=\"back\"]')?.click()");
  await sleep(400);

  await globalSearch("Infinity Edge");
  await waitFor("!!document.querySelector('[data-search-results]')", "résultats Infinity Edge", 15000);
  await evaluate("document.querySelector('[data-search-result][data-result-type=\"item\"][data-result-id=\"3031\"]')?.click()");
  await waitFor(
    "(() => { const el = document.querySelector('#view-item-detail'); return !!el && !el.hidden && el.getAttribute('data-item-detail-id') === '3031'; })()",
    "fiche objet via recherche globale",
    20000,
  );
  const searchedItem = await evaluate("document.querySelector('#view-item-detail .item-detail-name')?.textContent?.trim() ?? null");
  check("global_search_opens_item", Boolean(searchedItem?.includes("Infinity Edge")), searchedItem ?? "");
  await evaluate("document.querySelector('[data-action=\"back-item\"]')?.click()");
  await sleep(400);

  await globalSearch("Conquérant");
  await waitFor("!!document.querySelector('[data-search-results]')", "résultats Conquérant", 15000);
  await evaluate("document.querySelector('[data-search-result][data-result-type=\"rune\"][data-result-id=\"8010\"]')?.click()");
  await waitFor(
    "(() => { const el = document.querySelector('#view-rune-detail'); return !!el && !el.hidden && el.getAttribute('data-rune-detail-id') === '8010'; })()",
    "fiche rune via recherche globale",
    20000,
  );
  const searchedRune = await evaluate("document.querySelector('#view-rune-detail .rune-detail-name')?.textContent?.trim() ?? null");
  check("global_search_opens_rune", Boolean(searchedRune?.includes("Conquérant")), searchedRune ?? "");

  socket.close();

  console.log("\n=== RÉSUMÉ ===");
  console.log(JSON.stringify({ ok: failures.length === 0, checks, failures }, null, 2));
  process.exit(failures.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`scénarios UI : ${error?.stack ?? error}`);
  process.exit(1);
});
