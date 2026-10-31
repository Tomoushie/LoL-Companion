// Serveur mock **strictement réservé aux tests d'intégration** de LoL BOT.
//
// Il n'est jamais utilisé par l'application en usage normal : le backend Rust
// n'utilise `RIOT_API_BASE` que si cette variable d'environnement est définie.
// Les données renvoyées ici sont simulées et ne doivent JAMAIS être présentées
// comme des données Riot réelles.
//
// Usage :
//   node scripts/mock-riot-server.mjs --port 18765
//   puis lancer l'app avec :
//     RIOT_API_KEY=RGAPI-mock-test
//     RIOT_API_BASE=http://127.0.0.1:18765
//
// Endpoints simulés :
//   GET /riot/account/v1/accounts/by-riot-id/{game}/{tag}
//   GET /lol/league/v4/entries/by-puuid/{puuid}
//   GET /lol/match/v5/matches/by-puuid/{puuid}/ids?count=10|50
//   GET /lol/match/v5/matches/{matchId}
//   GET /__stats   (compteur de requêtes, pour vérifier le cache)
//   GET /__reset   (remet les compteurs à zéro)

import { createServer } from "node:http";

const args = process.argv.slice(2);
let port = 18765;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === "--port") port = Number(args[++i]);
}

const PUUID = "mock-puuid-0000000000000000000000000000000000000000000000001";
const GAME_NAME = "Faker";
const TAG_LINE = "EUW";

const championPool = [
  "Ahri", "Aatrox", "Jinx", "Lux", "Yasuo", "Akali", "Caitlyn", "Darius", "Leona", "Viktor",
  "Ezreal", "Garen", "Thresh", "Orianna", "KhaZix", "Riven", "Sivir", "Shen", "Seraphine", "Viego",
];

const playerNames = [
  "Faker", "Caps", "Rekkles", "Jankos", "Nemesis", "Perkz", "Hans Sama", "Miky", "Upset", "Nisqy",
  "Humanoid", "Elyoya", "Kaiser", "Comp", "Trymbi", "Odoamne", "Targamas", "Malrang", "Vetheo", "Adam",
];

const MATCH_COUNT = 50;
const matchIds = Array.from({ length: MATCH_COUNT }, (_, index) => `EUW1_MOCK_${index + 1}`);

const requestCounts = new Map();
let totalRequests = 0;

function record(path) {
  totalRequests += 1;
  requestCounts.set(path, (requestCounts.get(path) ?? 0) + 1);
}

function participant(index, teamId, win, champion, name, kdaSeed) {
  const kills = (kdaSeed * 3 + index) % 13;
  const deaths = (kdaSeed + index * 2) % 7;
  const assists = (kdaSeed * 2 + index * 5) % 16;
  const cs = 140 + ((kdaSeed * 37 + index * 53) % 220);
  const vision = 12 + ((kdaSeed * 11 + index * 7) % 48);
  return {
    puuid: index === 0 ? PUUID : `mock-puuid-other-${teamId}-${index}`,
    riotIdGameName: name,
    riotIdTagline: "EUW",
    summonerName: name,
    championName: champion,
    championId: 1 + index,
    teamId,
    teamPosition: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"][index % 5],
    individualPosition: ["TOP", "JUNGLE", "MIDDLE", "BOTTOM", "UTILITY"][index % 5],
    kills,
    deaths,
    assists,
    totalMinionsKilled: cs - 15,
    neutralMinionsKilled: 15,
    visionScore: vision,
    win,
    gameEndedInSurrender: false,
  };
}

function buildMatch(matchIndex) {
  const firstTeamWins = matchIndex % 2 === 0;
  const champions = championPool.slice(matchIndex % 10, (matchIndex % 10) + 10);
  while (champions.length < 10) champions.push(championPool[champions.length % championPool.length]);
  const participants = [];
  for (let index = 0; index < 10; index += 1) {
    const teamId = index < 5 ? 100 : 200;
    const win = teamId === 100 ? firstTeamWins : !firstTeamWins;
    const name = index === 0 ? GAME_NAME : playerNames[(matchIndex + index) % playerNames.length];
    participants.push(
      participant(index, teamId, win, champions[index % champions.length], name, matchIndex + index),
    );
  }
  return {
    metadata: { matchId: matchIds[matchIndex], participants: participants.map((p) => p.puuid) },
    info: {
      gameCreation: 1750000000000 + matchIndex * 3600000,
      gameDuration: 1500 + matchIndex * 47,
      gameMode: "CLASSIC",
      gameType: "MATCHED_GAME",
      queueId: matchIndex % 3 === 0 ? 440 : 420,
      mapId: 11,
      participants,
      teams: [
        { teamId: 100, win: firstTeamWins },
        { teamId: 200, win: !firstTeamWins },
      ],
    },
  };
}

const matches = new Map(matchIds.map((id, index) => [id, buildMatch(index)]));

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
  const pathname = decodeURIComponent(url.pathname);
  // Les endpoints internes de test ne comptent pas dans les statistiques.
  if (!pathname.startsWith("/__")) {
    record(`${req.method} ${pathname}`);
  }

  if (pathname === "/__stats") {
    json(res, 200, {
      totalRequests,
      requests: Object.fromEntries([...requestCounts.entries()].sort()),
      matchCount: matches.size,
    });
    return;
  }
  if (pathname === "/__reset") {
    requestCounts.clear();
    totalRequests = 0;
    json(res, 200, { ok: true });
    return;
  }
  if (pathname === "/__health") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method !== "GET") {
    json(res, 405, { status: { message: "method not allowed", status_code: 405 } });
    return;
  }

  const token = req.headers["x-riot-token"];
  if (!token) {
    json(res, 401, {
      status: { message: "mock: missing X-Riot-Token", status_code: 401 },
    });
    return;
  }

  // /riot/account/v1/accounts/by-riot-id/{gameName}/{tagLine}
  const accountMatch = pathname.match(/^\/riot\/account\/v1\/accounts\/by-riot-id\/([^/]+)\/([^/]+)$/);
  if (accountMatch) {
    const [, game, tag] = accountMatch;
    if (game.toLowerCase() === GAME_NAME.toLowerCase() && tag.toUpperCase() === TAG_LINE) {
      json(res, 200, { puuid: PUUID, gameName: GAME_NAME, tagLine: TAG_LINE });
    } else {
      json(res, 404, {
        status: { message: "mock: account not found", status_code: 404 },
      });
    }
    return;
  }

  // /lol/league/v4/entries/by-puuid/{puuid}
  const leagueMatch = pathname.match(/^\/lol\/league\/v4\/entries\/by-puuid\/([^/]+)$/);
  if (leagueMatch) {
    if (leagueMatch[1] !== PUUID) {
      json(res, 404, { status: { message: "mock: puuid not found", status_code: 404 } });
      return;
    }
    json(res, 200, [
      {
        queueType: "RANKED_SOLO_5x5",
        tier: "CHALLENGER",
        rank: "I",
        leaguePoints: 1234,
        wins: 500,
        losses: 400,
        hotStreak: true,
        veteran: true,
        freshBlood: false,
        inactive: false,
      },
      {
        queueType: "RANKED_FLEX_SR",
        tier: "DIAMOND",
        rank: "II",
        leaguePoints: 42,
        wins: 61,
        losses: 39,
        hotStreak: false,
        veteran: false,
        freshBlood: false,
        inactive: false,
      },
    ]);
    return;
  }

  // /lol/match/v5/matches/by-puuid/{puuid}/ids
  const matchListMatch = pathname.match(/^\/lol\/match\/v5\/matches\/by-puuid\/([^/]+)\/ids$/);
  if (matchListMatch) {
    if (matchListMatch[1] !== PUUID) {
      json(res, 404, { status: { message: "mock: puuid not found", status_code: 404 } });
      return;
    }
    const count = Number(url.searchParams.get("count") ?? "10");
    json(res, 200, matchIds.slice(0, Math.max(0, Math.min(MATCH_COUNT, count))));
    return;
  }

  // /lol/match/v5/matches/{matchId}
  const matchDetailMatch = pathname.match(/^\/lol\/match\/v5\/matches\/([^/]+)$/);
  if (matchDetailMatch) {
    const match = matches.get(matchDetailMatch[1]);
    if (!match) {
      json(res, 404, { status: { message: "mock: match not found", status_code: 404 } });
      return;
    }
    json(res, 200, match);
    return;
  }

  json(res, 404, { status: { message: "mock: unknown endpoint", status_code: 404 } });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[mock-riot] serveur de test sur http://127.0.0.1:${port}`);
  console.log(`[mock-riot] compte simulé : ${GAME_NAME}#${TAG_LINE}, ${MATCH_COUNT} matchs simulés`);
});
