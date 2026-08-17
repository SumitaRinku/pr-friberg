import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { normalizeRole } from "./sync-player-data.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYERS_FILE = path.join(ROOT, "data", "players.json");
const OVERRIDES_FILE = path.join(ROOT, "data", "player-role-overrides.json");
const MAJOR_FILE = path.join(ROOT, "data", "major-records.json");
const API_URL = "https://liquipedia.net/counterstrike/api.php";
const BATCH_SIZE = 40;
const REQUEST_DELAY_MS = 2200;
const TITLE_OVERRIDES = { draken:"draken (William Sundin)" };

function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}
function cleanWikiValue(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{(?:abbr|tooltip)\|([^|}]+)[^}]*\}\}/gi, "$1")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .trim();
}

export function parseLiquipediaRole(source) {
  const infobox = String(source || "").match(/\{\{\s*Infobox player\b[\s\S]*?^\s*\}\}\s*$/im);
  if (!infobox) return null;
  const idMatch = infobox[0].match(/^\|[ \t]*id[ \t]*=[ \t]*([^\r\n]*)$/im);
  const roleMatch = infobox[0].match(/^\|[ \t]*roles?[ \t]*=[ \t]*([^\r\n]*)$/im);
  if (!roleMatch) return null;
  const rawRole = cleanWikiValue(roleMatch[1]);
  if (!rawRole) return null;
  const role = normalizeRole(rawRole, "__unknown__");
  if (role === "__unknown__") return null;
  return { id:cleanWikiValue(idMatch && idMatch[1]), role, rawRole };
}
async function readJson(filePath, fallback) {
  try { return JSON.parse(await fs.readFile(filePath, "utf8")); }
  catch { return fallback; }
}
async function writeAtomic(filePath, payload) {
  await fs.mkdir(path.dirname(filePath), { recursive:true });
  const temporary = filePath + "." + process.pid + ".tmp";
  await fs.writeFile(temporary, JSON.stringify(payload, null, 2) + "\n", "utf8");
  try { await fs.rename(temporary, filePath); }
  catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    await fs.copyFile(temporary, filePath);
    await fs.unlink(temporary);
  }
}
async function fetchPages(titles, fetchImpl) {
  const url = new URL(API_URL);
  url.searchParams.set("action", "query");
  url.searchParams.set("format", "json");
  url.searchParams.set("formatversion", "2");
  url.searchParams.set("redirects", "1");
  url.searchParams.set("prop", "revisions");
  url.searchParams.set("rvprop", "content");
  url.searchParams.set("rvslots", "main");
  url.searchParams.set("titles", titles.join("|"));
  const response = await fetchImpl(url, { headers:{
    "User-Agent":"PRFragle/1.0 (github.com/SumitaRinku/pr-friberg; player data maintenance)",
    "Accept":"application/json",
    "Accept-Encoding":"gzip"
  },signal:AbortSignal.timeout(30_000)});
  if (!response.ok) throw new Error("Liquipedia 请求失败：HTTP " + response.status + " " + (await response.text()).slice(0, 200));
  const payload = await response.json();
  return payload.query && Array.isArray(payload.query.pages) ? payload.query.pages : [];
}

function lastMajorYear(record) {
  const years=(record?.majorEvents||[]).flatMap(function(event) {
    return [...String(event||"").matchAll(/\b(20\d{2})\b/g)].map(function(match) { return Number(match[1]); });
  });
  return years.length ? Math.max(...years) : null;
}

async function fetchHistoricalRole(title, year, fetchImpl, delayMs) {
  if (!title || !year) return { parsed:null, requests:0 };
  const base={action:"query",format:"json",formatversion:"2",redirects:"1",prop:"revisions",rvprop:"content|timestamp",rvslots:"main",titles:title};
  const headers={"User-Agent":"PRFragle/1.0 (github.com/SumitaRinku/pr-friberg; historical player role maintenance)","Accept":"application/json","Accept-Encoding":"gzip"};
  async function request(params) {
    const url=new URL(API_URL);
    for(const [key,value] of Object.entries(params))url.searchParams.set(key,value);
    const response=await fetchImpl(url,{headers,signal:AbortSignal.timeout(30_000)});
    if(!response.ok)throw new Error("Liquipedia historical role request failed: HTTP "+response.status);
    return response.json();
  }
  function find(payload) {
    for(const page of payload?.query?.pages||[]) {
      for(const revision of page.revisions||[]) {
        const parsed=parseLiquipediaRole(revision?.slots?.main?.content);
        if(parsed?.role)return parsed;
      }
    }
    return null;
  }
  let requests=1;
  let payload=await request({...base,rvlimit:"50",rvdir:"older",rvstart:String(year+1)+"-01-01T00:00:00Z"});
  let parsed=find(payload);
  if(parsed)return{parsed,requests};
  let rvcontinue="";
  for(let index=0;index<8;index+=1) {
    if(delayMs>0)await sleep(delayMs);
    const params={...base,rvlimit:"max"};
    if(rvcontinue)params.rvcontinue=rvcontinue;
    payload=await request(params);
    requests+=1;
    parsed=find(payload);
    if(parsed)return{parsed,requests};
    rvcontinue=payload?.continue?.rvcontinue||"";
    if(!rvcontinue)break;
  }
  return{parsed:null,requests};
}

function majorRecordLookup(records) {
  const result=new Map();
  for (const record of records || []) for (const name of [record.id,record.profileId,record.wikiPage,...(record.alternateIds||[])]) {
    if (name) result.set(String(name).toLowerCase(), record);
  }
  return result;
}
export async function synchronizeRoles(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const delayMs = options.delayMs === undefined ? REQUEST_DELAY_MS : Number(options.delayMs);
  const playerPayload = await readJson(PLAYERS_FILE, null);
  if (!playerPayload) throw new Error("找不到 data/players.json");
  const players = Array.isArray(playerPayload) ? playerPayload : playerPayload.players;
  if (!Array.isArray(players) || !players.length) throw new Error("选手数据为空");
  const majorPayload = await readJson(MAJOR_FILE, { records:[] });
  const majorByName = majorRecordLookup(majorPayload.records);

  const previousPayload = await readJson(OVERRIDES_FILE, { roles:{} });
  const previousRoles = previousPayload && previousPayload.roles && typeof previousPayload.roles === "object" ? previousPayload.roles : {};
  const playerById = new Map(players.map(function (player) { return [String(player.id).toLowerCase(), player]; }));
  const previousUnresolved=new Set([...(previousPayload.unresolved||[]),...players.filter(function(player){return player.roleEstimated===true;}).map(function(player){return player.id;})]);
  const playerByWiki = new Map(players.filter(function(player){return player.wikiPage;}).map(function(player){return [String(player.wikiPage).toLowerCase(),player];}));
  const requested = players.slice(0, options.limit || players.length).map(function (player) {
    return player.wikiPage || TITLE_OVERRIDES[String(player.id).toLowerCase()] || player.id;
  });
  const found = new Map();
  let requestCount = 0;
  for (const batch of chunks(requested, BATCH_SIZE)) {
    const pages = await fetchPages(batch, fetchImpl);
    requestCount += 1;
    for (const page of pages) {
      if (page.missing) continue;
      const source = page.revisions && page.revisions[0] && page.revisions[0].slots && page.revisions[0].slots.main && page.revisions[0].slots.main.content;
      const parsed = parseLiquipediaRole(source);
      if (!parsed || !parsed.role) continue;
      const titleId = String(page.title || "").replace(/\s*\([^)]*\)\s*$/, "").toLowerCase();
      const key = String(parsed.id || titleId).toLowerCase();
      const pageTitle=String(page.title||"").toLowerCase();
      const player = playerByWiki.get(pageTitle) || playerById.get(key) || playerById.get(titleId);
      if (player) found.set(player.id, parsed.role);
    }
    if (delayMs > 0 && requestCount < Math.ceil(requested.length / BATCH_SIZE)) await sleep(delayMs);
  }

  const historicalCandidates = players.filter(function(player) {
    return Number(player.majorApps)>0 && !found.has(player.id) && !previousRoles[player.id] && !previousUnresolved.has(player.id);
  });
  for (let index=0; index<historicalCandidates.length; index+=1) {
    const player=historicalCandidates[index];
    const record=majorByName.get(String(player.wikiPage||player.id).toLowerCase()) || majorByName.get(String(player.id).toLowerCase());
    const history=await fetchHistoricalRole(record?.wikiPage||player.wikiPage||player.id,lastMajorYear(record),fetchImpl,delayMs);
    requestCount+=history.requests;
    if (history.parsed?.role) found.set(player.id,history.parsed.role);
    if (delayMs>0 && index<historicalCandidates.length-1) await sleep(delayMs);
  }

  const roles = {};
  for (const player of players) {
    const role = found.get(player.id) || previousRoles[player.id];
    if (role) roles[player.id] = role;
  }
  const updatedAt = new Date().toISOString();
  const unresolved=players.filter(function(player){return Number(player.majorApps)>0&&!found.has(player.id)&&!previousRoles[player.id];}).map(function(player){return player.id;});
  const overridePayload = {
    schemaVersion:1,
    source:"Liquipedia Counter-Strike player infobox roles",
    updatedAt,
    stats:{ players:players.length, resolved:found.size, requests:requestCount },
    roles,
    unresolved,
  };
  await writeAtomic(OVERRIDES_FILE, overridePayload);
  const updatedPlayers = players.map(function (player) {
    return roles[player.id] ? { ...player, role:roles[player.id] } : player;
  });
  const outputPayload = Array.isArray(playerPayload) ? updatedPlayers : {
    ...playerPayload,
    source:String(playerPayload.source || "Player database").includes("Liquipedia roles") ? String(playerPayload.source) : String(playerPayload.source || "Player database") + " + Liquipedia roles",
    updatedAt,
    stats:{ ...(playerPayload.stats || {}), players:updatedPlayers.length, roleOverrides:Object.keys(roles).length },
    players:updatedPlayers
  };
  await writeAtomic(PLAYERS_FILE, outputPayload);
  console.log("Liquipedia role sync complete: " + found.size + " roles refreshed, " + Object.keys(roles).length + " overrides stored");
  return overridePayload;
}

export async function main() {
  const limitArg = process.argv.find(function (arg) { return arg.startsWith("--limit="); });
  const limit = limitArg ? Number(limitArg.split("=")[1]) : undefined;
  return synchronizeRoles({ limit });
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(function (error) { console.error(error.message); process.exitCode = 1; });
}
