// Sonde CDP (WebView2) pour diagnostiquer l'interface de LoL BOT en cours d'exécution.
//
// Lancement de l'app avec le port de debug :
//   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222"
//   Start-Process .\src-tauri\target\debug\lol-bot.exe
//
// Usage :
//   node scripts/webview-probe.mjs "<expression JS>" ["<expression JS>" ...]
//   node scripts/webview-probe.mjs --reload --logs -- "1+1"
//
// Options :
//   --port <n>     port CDP (défaut 9222, ou env CDP_PORT)
//   --reload       recharge la page avant d'évaluer (pour capturer les logs)
//   --logs         collecte console/exceptions/CSP pendant 3 s après rechargement
//   --network      collecte les événements réseau (utile pour le protocole asset)
//   --             sépare options et expressions

const args = process.argv.slice(2);
const options = {
  port: Number(process.env.CDP_PORT ?? 9222),
  reload: false,
  logs: false,
  network: false,
};
const expressions = [];
for (let i = 0; i < args.length; i += 1) {
  const arg = args[i];
  if (arg === "--") {
    expressions.push(...args.slice(i + 1));
    break;
  }
  if (arg === "--port") {
    options.port = Number(args[++i]);
  } else if (arg === "--reload") {
    options.reload = true;
  } else if (arg === "--logs") {
    options.logs = true;
  } else if (arg === "--network") {
    options.network = true;
  } else {
    expressions.push(arg);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const listUrl = `http://127.0.0.1:${options.port}/json/list`;
  const targets = await (await fetch(listUrl)).json();
  const page = targets.find((target) => target.type === "page");
  if (!page) {
    throw new Error(`aucune cible de type page sur ${listUrl}`);
  }

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  const events = [];

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
      return;
    }
    if (options.logs && event.method) {
      const { method, params } = message;
      if (method === "Runtime.consoleAPICalled") {
        const text = (params.args ?? [])
          .map((arg) => arg.value ?? arg.description ?? arg.type)
          .join(" ");
        events.push(`[console.${params.type}] ${text}`);
      } else if (method === "Runtime.exceptionThrown") {
        events.push(`[exception] ${params.exceptionDetails?.text} ${params.exceptionDetails?.exception?.description ?? ""}`);
      } else if (method === "Log.entryAdded") {
        events.push(`[log.${params.entry.level}] ${params.entry.text}`);
      }
    }
    if (options.network && event.method) {
      const { method, params } = message;
      if (method === "Network.responseReceived" && params.response?.url?.includes("asset.localhost")) {
        events.push(`[net] ${params.response.status} ${params.response.url}`);
      } else if (method === "Network.loadingFailed") {
        events.push(`[net-fail] ${params.errorText} ${params.blockedReason ?? ""}`);
      }
    }
  });

  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  if (options.logs) {
    await send("Runtime.enable");
    await send("Log.enable");
    await send("Page.enable");
  }
  if (options.network) {
    await send("Network.enable");
  }

  if (options.reload) {
    await send("Page.reload", { ignoreCache: false });
    await sleep(3000);
  }

  for (const expression of expressions) {
    const response = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    const result = response.result ?? {};
    const payload = result.exceptionDetails
      ? { expression, exception: result.exceptionDetails }
      : { expression, value: result.result?.value };
    console.log(JSON.stringify(payload, null, 2));
  }

  if ((options.logs || options.network) && events.length > 0) {
    await sleep(1000);
    console.log("--- logs WebView ---");
    for (const line of events) {
      console.log(line);
    }
  }

  socket.close();
}

main().catch((error) => {
  console.error(`sonde CDP : ${error?.stack ?? error}`);
  process.exit(1);
});
