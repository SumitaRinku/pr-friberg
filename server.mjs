import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDatabase, fetchActivePlayers } from "./scripts/sync-pandascore.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(ROOT, "data", "players.json");
const ENV_FILE = path.join(ROOT, ".env");
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseEnv(text) {
  const result = {};
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    result[match[1]] = value;
  }
  return result;
}

async function loadLocalEnv() {
  try {
    const values = parseEnv(await fs.readFile(ENV_FILE, "utf8"));
    for (const [key, value] of Object.entries(values)) if (process.env[key] === undefined) process.env[key] = value;
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`[env] ${error.message}`);
  }
}

export function isInvalidTeamValue(value) {
  const team = String(value ?? "").trim();
  return !team || /^\|?\s*[a-z][a-z0-9_]*\s*=/i.test(team) || /[\r\n{}]/.test(team) || /^\?{2,}$/.test(team);
}

export function sanitizeTeam(value, status) {
  const team = String(value ?? "").trim();
  return isInvalidTeamValue(team) ? (status === "退役" ? "退役" : "无队伍") : team;
}

export function sanitizePlayers(players) {
  return Array.isArray(players) ? players.map(player => ({
    ...player,
    team:sanitizeTeam(player?.team, player?.status)
  })) : [];
}

export function validPlayers(players) {
  const fields = ["id","team","country","region","age","role","majorWins","majorApps","status"];
  return Array.isArray(players) && players.length >= 50 && players.every(player => fields.every(field => player[field] !== undefined) && !isInvalidTeamValue(player.team));
}

export function createPlayersScript(players, updatedAt) {
  const publicPlayers = sanitizePlayers(players).map(player => ({
    id:player.id, team:player.team, country:player.country, region:player.region,
    age:player.age, role:player.role, majorWins:player.majorWins,
    majorApps:player.majorApps, status:player.status
  }));
  return `// PandaScore server sync: ${updatedAt || "built-in"}\n` +
    `(function(root){"use strict";root.DEFAULT_PLAYERS=${JSON.stringify(publicPlayers)};})(typeof window!=="undefined"?window:globalThis);\n`;
}

export function contentType(filePath) {
  return ({
    ".html":"text/html; charset=utf-8", ".css":"text/css; charset=utf-8",
    ".js":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8",
    ".png":"image/png", ".jpg":"image/jpeg", ".jpeg":"image/jpeg",
    ".svg":"image/svg+xml", ".ico":"image/x-icon"
  })[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

async function loadBuiltInPlayers() {
  await import(pathToFileURL(path.join(ROOT, "js", "players.js")).href + `?startup=${Date.now()}`);
  return globalThis.DEFAULT_PLAYERS || [];
}

async function loadCache() {
  try {
    const payload = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    payload.players = sanitizePlayers(payload.players);
    if (validPlayers(payload.players)) return payload;
  } catch (error) {
    if (error.code !== "ENOENT") console.warn(`[cache] ${error.message}`);
  }
  return null;
}

async function writeJsonAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive:true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
  try { await fs.rename(temporary, filePath); }
  catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    await fs.copyFile(temporary, filePath);
    await fs.unlink(temporary);
  }
}

export async function startServer() {
  await loadLocalEnv();
  const builtInPlayers = sanitizePlayers(await loadBuiltInPlayers());
  const cached = await loadCache();
  const state = {
    players: cached?.players || builtInPlayers,
    updatedAt: cached?.updatedAt || null,
    source: cached ? "PandaScore cache" : "built-in",
    syncing: false,
    lastAttemptAt: null,
    lastError: null,
    requests: cached?.stats?.requests || 0
  };

  const intervalMs = Math.max(60 * 60 * 1000, Number(process.env.SYNC_INTERVAL_MS) || DAY_MS);
  const apiKey = process.env.PANDASCORE_API_KEY;

  async function synchronize() {
    if (!apiKey || state.syncing) return false;
    state.syncing = true;
    state.lastAttemptAt = new Date().toISOString();
    try {
      const fetched = await fetchActivePlayers(apiKey);
      const merged = sanitizePlayers(await buildDatabase(fetched.players, state.players, builtInPlayers, new Date()));
      if (!validPlayers(merged)) throw new Error(`同步结果异常：仅 ${merged.length} 位或字段不完整`);
      const payload = {
        schemaVersion:1, source:"PandaScore", updatedAt:new Date().toISOString(),
        stats:{ players:merged.length, apiRecords:fetched.players.length, requests:fetched.requests },
        players:merged
      };
      await writeJsonAtomic(DATA_FILE, payload);
      state.players = merged;
      state.updatedAt = payload.updatedAt;
      state.source = "PandaScore";
      state.requests = fetched.requests;
      state.lastError = null;
      console.log(`[sync] ${merged.length} players updated at ${payload.updatedAt}`);
      return true;
    } catch (error) {
      state.lastError = error.message;
      console.error(`[sync] failed: ${error.message}`);
      return false;
    } finally {
      state.syncing = false;
    }
  }

  const server = http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://localhost");
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.writeHead(405, { Allow:"GET, HEAD", "Content-Type":"application/json; charset=utf-8" });
        response.end(JSON.stringify({ error:"Method not allowed" }));
        return;
      }

      if (url.pathname === "/api/status") {
        response.writeHead(200, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-store" });
        response.end(JSON.stringify({
          source:state.source, players:state.players.length, updatedAt:state.updatedAt,
          syncing:state.syncing, lastAttemptAt:state.lastAttemptAt, lastError:state.lastError,
          nextSyncInMs:intervalMs, configured:Boolean(apiKey)
        }));
        return;
      }
      if (url.pathname === "/api/players") {
        response.writeHead(200, { "Content-Type":"application/json; charset=utf-8", "Cache-Control":"no-cache" });
        response.end(JSON.stringify({ source:state.source, updatedAt:state.updatedAt, players:state.players }));
        return;
      }
      if (url.pathname === "/js/players.js") {
        response.writeHead(200, { "Content-Type":"text/javascript; charset=utf-8", "Cache-Control":"no-cache" });
        response.end(createPlayersScript(state.players, state.updatedAt));
        return;
      }

      let relative;
      if (url.pathname === "/") relative = "home.html";
      else if (url.pathname === "/play" || url.pathname === "/play/") relative = "play.html";
      else if (url.pathname === "/tool" || url.pathname === "/tool/") relative = "index.html";
      else if (url.pathname === "/arknights" || url.pathname === "/arknights/") relative = "arknights.html";
      else if (url.pathname === "/arknights-tool" || url.pathname === "/arknights-tool/") relative = "arknights-tool.html";
      else relative = decodeURIComponent(url.pathname).replace(/^[/\\]+/, "");

      const filePath = path.resolve(ROOT, relative);
      if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
        response.writeHead(403); response.end("Forbidden"); return;
      }
      const body = await fs.readFile(filePath);
      response.writeHead(200, {
        "Content-Type":contentType(filePath),
        "Cache-Control": /\.(html|js|css)$/i.test(filePath) ? "no-cache" : "public, max-age=3600",
        "X-Content-Type-Options":"nosniff"
      });
      if (request.method === "HEAD") response.end(); else response.end(body);
    } catch (error) {
      const status = error.code === "ENOENT" || error.code === "EISDIR" ? 404 : 500;
      response.writeHead(status, { "Content-Type":"text/plain; charset=utf-8" });
      response.end(status === 404 ? "Not found" : "Internal server error");
    }
  });

  const port = Number(process.env.PORT) || 3000;
  const host = process.env.HOST || "127.0.0.1";
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  console.log(`[server] http://${host}:${port}`);
  if (!apiKey) console.warn("[sync] PANDASCORE_API_KEY is not configured; using cached/built-in data");
  else synchronize();
  const timer = setInterval(synchronize, intervalMs);
  timer.unref();

  const close = () => new Promise(resolve => server.close(resolve));
  return { server, state, synchronize, close, url:`http://${host}:${port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startServer().then(({ close }) => {
    const shutdown = async () => { console.log("\n[server] shutting down"); await close(); process.exit(0); };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }).catch(error => { console.error(error); process.exitCode = 1; });
}
