import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT = path.join(ROOT, "data", "major-records.json");
const API_URL = "https://liquipedia.net/counterstrike/api.php";
const PLAYER_DATABASE_API_URL = API_URL + "?action=parse&page=Majors%2FPlayer_Database&prop=wikitext&format=json";
const SOURCE_URL = "https://liquipedia.net/counterstrike/Majors/Player_Database";
const USER_AGENT = "PRFribergTool/1.0 (github.com/SumitaRinku/pr-friberg; Major player data sync)";
const PROFILE_BATCH_SIZE = 40;
const PROFILE_DELAY_MS = 2200;

function normalizeName(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function chunks(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

function cleanWikiValue(value) {
  return String(value || "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{(?:abbr|tooltip)\|([^|}]+)[^}]*\}\}/gi, "$1")
    .replace(/\{\{(?:team|Team)\|([^|}]+)[^}]*\}\}/g, "$1")
    .replace(/\[\[([^|\]]+)\|([^\]]+)\]\]/g, "$2")
    .replace(/\[\[([^\]]+)\]\]/g, "$1")
    .replace(/'{2,}/g, "")
    .trim();
}

function parsePlayerTemplate(template) {
  const parts = template.split("|").map(normalizeName).filter(Boolean);
  const display = normalizeName(parts.find(function (part) { return !part.includes("=") && part !== "player"; }) || "");
  const link = normalizeName((parts.find(function (part) { return part.startsWith("link="); }) || "").slice(5));
  const flag = normalizeName((parts.find(function (part) { return part.startsWith("flag="); }) || "").slice(5)).toUpperCase();
  return { display, key:link || display, wikiPage:link || display, countryCode:flag };
}

function eventRow(line) {
  const match = line.match(/^\|\[\[([^|\]]+)(?:\|([^\]]+))?\]\]\s+\{\{TeamPart\|([^}|]+)(?:\|([^}|]+))?[^}]*\}\}\s+\|\|\s*(?:\{\{Placement\|([^}]+)\}\})?/);
  if (!match) return null;
  return {
    id:normalizeName(match[1]),
    name:normalizeName(match[2] || match[1].split("/").pop()),
    team:normalizeName(match[3]),
    date:normalizeName(match[4] || ""),
    placement:normalizeName(match[5] || "")
  };
}

function firstMajorYear(events) {
  const years = events.flatMap(function (event) {
    return [...(String(event.date || "")+" "+String(event.name || "")).matchAll(/\b(20\d{2})\b/g)].map(function (match) { return Number(match[1]); });
  });
  return years.length ? Math.min.apply(null, years) : null;
}

export function parsePlayerDatabase(wikitext) {
  const text = String(wikitext || "");
  const headers = [...text.matchAll(/^!\s*colspan="2"[^\n]*\{\{player\|([^\n]+)\}\}/gm)];
  const records = new Map();
  for (let index = 0; index < headers.length; index += 1) {
    const header = headers[index];
    const start = header.index + header[0].length;
    const end = headers[index + 1]?.index ?? text.length;
    const player = parsePlayerTemplate(header[1]);
    if (!player.display) continue;
    const events = text.slice(start, end).split(/\r?\n/).map(eventRow).filter(Boolean);
    const previous = records.get(player.key.toLowerCase());
    const merged = new Map((previous?.events || []).map(function (event) { return [event.id, event]; }));
    for (const event of events) merged.set(event.id, event);
    const allEvents = [...merged.values()];
    const wins = allEvents.filter(function (event) { return event.placement === "1"; });
    records.set(player.key.toLowerCase(), {
      id:previous?.id || player.display,
      wikiPage:player.wikiPage,
      countryCode:player.countryCode,
      latestMajorTeam:allEvents[allEvents.length - 1]?.team || "",
      firstMajorYear:firstMajorYear(allEvents),
      majorApps:allEvents.length,
      majorWins:wins.length,
      majorEvents:allEvents.map(function (event) { return event.name; }),
      majorWinEvents:wins.map(function (event) { return event.name; }),
      events:allEvents
    });
  }
  return [...records.values()]
    .map(function (record) { const { events, ...clean } = record; return clean; })
    .sort(function (a, b) { return a.id.localeCompare(b.id); });
}

export function parseLiquipediaProfile(source) {
  const infobox = String(source || "").match(/\{\{\s*Infobox player\b[\s\S]*?^\s*\}\}\s*$/im);
  if (!infobox) return null;
  function field(name) {
    // Spaces around an empty value must not consume the following infobox line.
    const match = infobox[0].match(new RegExp("^\\|[ \\t]*" + name + "[ \\t]*=[ \\t]*([^\\r\\n]*)$", "im"));
    return cleanWikiValue(match && match[1]);
  }
  const birthdayRaw = field("birth_date");
  const birthdayMatch = birthdayRaw.match(/(19|20)\d{2}[-\/.]\d{1,2}[-\/.]\d{1,2}/);
  const birthday = birthdayMatch ? birthdayMatch[0].replace(/[\/.]/g, "-").split("-").map(function (part, index) {
    return index === 0 ? part : part.padStart(2, "0");
  }).join("-") : null;
  return {
    profileId:field("id"),
    alternateIds:field("ids").split(/\s*,\s*|<br\s*\/?\s*>/i).map(normalizeName).filter(Boolean),
    birthday,
    role:field("roles?"),
    currentTeam:field("team"),
    profileStatus:field("status"),
    yearsActive:field("years_active")
  };
}

async function fetchProfileBatch(titles, fetchImpl) {
  const url = new URL(API_URL);
  const params = {
    action:"query", format:"json", formatversion:"2", redirects:"1",
    prop:"revisions", rvprop:"content", rvslots:"main", titles:titles.join("|")
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, {
    headers:{ Accept:"application/json", "User-Agent":USER_AGENT, "Accept-Encoding":"gzip" }
  });
  if (!response.ok) throw new Error("Liquipedia 选手资料请求失败：HTTP " + response.status + " " + (await response.text()).slice(0, 300));
  const payload = await response.json();
  const aliases = new Map();
  for (const title of titles) aliases.set(title.toLowerCase(), title);
  for (const entry of payload?.query?.normalized || []) aliases.set(String(entry.from).toLowerCase(), entry.to);
  for (const entry of payload?.query?.redirects || []) aliases.set(String(entry.from).toLowerCase(), entry.to);
  function canonical(title) {
    let value = title;
    const visited = new Set();
    while (!visited.has(value.toLowerCase()) && aliases.has(value.toLowerCase())) {
      visited.add(value.toLowerCase());
      const next = aliases.get(value.toLowerCase());
      if (next === value) break;
      value = next;
    }
    return value.toLowerCase();
  }
  const pages = new Map();
  for (const page of payload?.query?.pages || []) pages.set(String(page.title || "").toLowerCase(), page);
  const result = new Map();
  for (const title of titles) {
    const page = pages.get(canonical(title));
    if (!page || page.missing) continue;
    const source = page.revisions?.[0]?.slots?.main?.content;
    const profile = parseLiquipediaProfile(source);
    if (profile) result.set(title.toLowerCase(), profile);
  }
  return result;
}

export async function fetchLiquipediaProfiles(records, fetchImpl = fetch, options = {}) {
  const delayMs = options.delayMs === undefined ? PROFILE_DELAY_MS : Number(options.delayMs);
  const titles = [...new Set(records.map(function (record) { return record.wikiPage || record.id; }).filter(Boolean))];
  const profiles = new Map();
  const batches = chunks(titles, PROFILE_BATCH_SIZE);
  for (let index = 0; index < batches.length; index += 1) {
    const found = await fetchProfileBatch(batches[index], fetchImpl);
    for (const [title, profile] of found) profiles.set(title, profile);
    if (delayMs > 0 && index < batches.length - 1) await sleep(delayMs);
  }
  return {
    records:records.map(function (record) {
      return { ...record, ...(profiles.get(String(record.wikiPage || record.id).toLowerCase()) || {}) };
    }),
    requests:batches.length,
    resolved:profiles.size
  };
}

export async function fetchLiquipediaWikitext(fetchImpl = fetch) {
  const response = await fetchImpl(PLAYER_DATABASE_API_URL, {
    headers:{ Accept:"application/json", "User-Agent":USER_AGENT }
  });
  if (!response.ok) throw new Error("Liquipedia Major 数据请求失败：HTTP " + response.status + " " + (await response.text()).slice(0, 300));
  const payload = await response.json();
  const wikitext = payload?.parse?.wikitext?.["*"];
  if (typeof wikitext !== "string" || wikitext.length < 10_000) throw new Error("Liquipedia Major 数据格式异常");
  return wikitext;
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

export async function main(fetchImpl = fetch) {
  const parsed = parsePlayerDatabase(await fetchLiquipediaWikitext(fetchImpl));
  if (parsed.length < 100) throw new Error("Liquipedia 解析结果仅 " + parsed.length + " 位选手，拒绝覆盖现有数据");
  const profiles = await fetchLiquipediaProfiles(parsed, fetchImpl);
  const payload = {
    schemaVersion:3,
    source:SOURCE_URL,
    sourceApi:PLAYER_DATABASE_API_URL,
    updatedAt:new Date().toISOString(),
    scope:"Liquipedia Player Database 中记录的全部 CS:GO / CS2 Major 正赛参赛者",
    definition:"majorApps 为去重后的 Major 赛事数；majorWins 为最终名次为 1 的赛事数",
    stats:{ records:profiles.records.length, profilesResolved:profiles.resolved, profileRequests:profiles.requests },
    records:profiles.records
  };
  await writeAtomic(OUTPUT, payload);
  console.log("Major records updated: " + profiles.records.length + " players, " + profiles.resolved + " profiles resolved");
  return payload;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(function (error) {
    console.error(error.message);
    process.exitCode = 1;
  });
}
