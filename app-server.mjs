import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { parseEnv, validPlayers, sanitizePlayers, createPlayersScript, contentType } from "./server.mjs";
import { buildDatabase, fetchActivePlayers } from "./scripts/sync-pandascore.mjs";
import { GameManager } from "./game-engine.mjs";
import { ArknightsGameManager } from "./arknights-game-engine.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const ARKNIGHTS_OPERATORS = require("./data/arknights-operators.js");
const DATA_FILE = path.join(ROOT, "data", "players.json");
const DAY_MS = 86_400_000;

async function loadEnv() {
  try {
    const values = parseEnv(await fs.readFile(path.join(ROOT, ".env"), "utf8"));
    for (const [key,value] of Object.entries(values)) if (process.env[key] === undefined) process.env[key] = value;
  } catch (error) { if (error.code !== "ENOENT") console.warn(`[env] ${error.message}`); }
}

async function loadBuiltIn() {
  await import(pathToFileURL(path.join(ROOT, "js", "players.js")).href + `?app=${Date.now()}`);
  return globalThis.DEFAULT_PLAYERS || [];
}

async function loadCache() {
  try {
    const payload = JSON.parse(await fs.readFile(DATA_FILE, "utf8"));
    payload.players = sanitizePlayers(payload.players);
    return validPlayers(payload.players) ? payload : null;
  } catch { return null; }
}

async function writeAtomic(payload) {
  await fs.mkdir(path.dirname(DATA_FILE), {recursive:true});
  const temporary = `${DATA_FILE}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(payload,null,2)+"\n", "utf8");
  try { await fs.rename(temporary, DATA_FILE); }
  catch (error) {
    if (error.code !== "EEXIST" && error.code !== "EPERM") throw error;
    await fs.copyFile(temporary, DATA_FILE); await fs.unlink(temporary);
  }
}

function json(response, status, data, extra = {}) {
  response.writeHead(status, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...extra});
  response.end(JSON.stringify(data));
}

async function bodyJson(request) {
  const chunks=[]; let length=0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32_768) throw Object.assign(new Error("请求内容过大"),{status:413});
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("JSON 格式错误"),{status:400}); }
}

function secureHeaders(type) {
  return {
    "Content-Type":type, "X-Content-Type-Options":"nosniff", "X-Frame-Options":"SAMEORIGIN",
    "Referrer-Policy":"strict-origin-when-cross-origin",
    "Content-Security-Policy":"default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-src 'self'"
  };
}

export async function createAppServer(options = {}) {
  await loadEnv();
  const builtIn = sanitizePlayers(options.players || await loadBuiltIn());
  const cached = options.players ? null : await loadCache();
  const state = {
    players:cached?.players || builtIn, source:cached?(cached.source||"PandaScore cache"):"built-in",
    updatedAt:cached?.updatedAt || null, syncing:false, lastAttemptAt:null, lastError:null
  };
  const games = new GameManager(state.players, options.gameOptions);
  const arknightsGames = new ArknightsGameManager(ARKNIGHTS_OPERATORS, options.arknightsGameOptions);
  const apiKey = options.apiKey ?? process.env.PANDASCORE_API_KEY;
  const syncInterval = Math.max(3_600_000, Number(process.env.SYNC_INTERVAL_MS)||DAY_MS);
  const rate = new Map();

  async function synchronize() {
    if (!apiKey || state.syncing) return false;
    state.syncing=true; state.lastAttemptAt=new Date().toISOString();
    try {
      const fetched=await fetchActivePlayers(apiKey);
      const merged=sanitizePlayers(await buildDatabase(fetched.players,state.players,builtIn,new Date()));
      if(!validPlayers(merged)) throw new Error(`同步结果异常：${merged.length} 位`);
      const majorPayload=JSON.parse(await fs.readFile(path.join(ROOT,"data","major-records.json"),"utf8"));const payload={schemaVersion:3,source:"PandaScore professional players + Liquipedia Major Player Database",majorSource:majorPayload.source,majorUpdatedAt:majorPayload.updatedAt,updatedAt:new Date().toISOString(),stats:{players:merged.length,apiRecords:fetched.players.length,requests:fetched.requests},players:merged};
      await writeAtomic(payload); state.players=merged;state.source="PandaScore";state.updatedAt=payload.updatedAt;state.lastError=null;games.setPlayers(merged);
      console.log(`[sync] updated ${merged.length} players`); return true;
    } catch(error){state.lastError=error.message;console.error(`[sync] ${error.message}`);return false;}
    finally{state.syncing=false;}
  }

  async function staticResponse(request,response,urlPath) {
    let relative=urlPath;
    if(urlPath==="/") relative="home.html";
    else if(urlPath==="/play"||urlPath==="/play/") relative="play.html";
    else if(urlPath==="/tool"||urlPath==="/tool/") relative="index.html";
    else if(urlPath==="/arknights"||urlPath==="/arknights/") relative="arknights.html";
    else if(urlPath==="/arknights-tool"||urlPath==="/arknights-tool/") relative="arknights-tool.html";
    else relative=decodeURIComponent(urlPath).replace(/^[/\\]+/,"");
    const filePath=path.resolve(ROOT,relative);
    if(filePath!==ROOT&&!filePath.startsWith(ROOT+path.sep)){response.writeHead(403);response.end("Forbidden");return;}
    let body=await fs.readFile(filePath);

    response.writeHead(200,{...secureHeaders(contentType(filePath)),"Cache-Control":/\.(html|js|css)$/i.test(filePath)?"no-cache":"public, max-age=3600"});
    if(request.method==="HEAD")response.end();else response.end(body);
  }

  const server=http.createServer(async(request,response)=>{
    const started=Date.now();
    try{
      const url=new URL(request.url||"/","http://localhost");
      const forwarded=String(request.headers["x-forwarded-for"]||"").split(",")[0].trim();
      const ip=forwarded||request.socket.remoteAddress||"unknown";
      const bucket=rate.get(ip)||{at:Date.now(),count:0};
      if(Date.now()-bucket.at>60_000){bucket.at=Date.now();bucket.count=0;} bucket.count++;rate.set(ip,bucket);
      if(bucket.count>300){json(response,429,{error:"请求过于频繁"},{"Retry-After":"60"});return;}

      const method=request.method||"GET", pathname=url.pathname;
      const accessToken=String(request.headers["x-player-token"]||"");
      if(pathname==="/healthz"){json(response,200,{ok:true});return;}
      if(pathname==="/api/status"&&method==="GET"){json(response,200,{source:state.source,players:state.players.length,updatedAt:state.updatedAt,syncing:state.syncing,lastAttemptAt:state.lastAttemptAt,lastError:state.lastError,configured:Boolean(apiKey),rooms:games.rooms.size,waiting:games.queue.length,arknightsRooms:arknightsGames.rooms.size,arknightsWaiting:arknightsGames.queue.length});return;}
      if(pathname==="/api/players"&&method==="GET"){json(response,200,{updatedAt:state.updatedAt,players:state.players});return;}
      if(pathname==="/js/players.js"&&method==="GET"){response.writeHead(200,{...secureHeaders("text/javascript; charset=utf-8"),"Cache-Control":"no-cache"});response.end(createPlayersScript(state.players,state.updatedAt));return;}

      if(pathname==="/api/game/single"&&method==="POST"){const body=await bodyJson(request);json(response,201,games.createSingle(body.playerName,body.questionMode));return;}
      let match=pathname.match(/^\/api\/game\/single\/([^/]+)$/);
      if(match&&method==="GET"){json(response,200,games.getSingle(match[1],accessToken));return;}
      match=pathname.match(/^\/api\/game\/single\/([^/]+)\/guess$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,games.guessSingle(match[1],accessToken,body.playerId));return;}
      match=pathname.match(/^\/api\/game\/single\/([^/]+)\/reveal$/);
      if(match&&method==="POST"){json(response,200,games.revealSingle(match[1],accessToken));return;}

      if(pathname==="/api/matchmaking"&&method==="POST"){const body=await bodyJson(request);json(response,201,games.matchmake(body.playerName,body.series,body.questionMode));return;}
      match=pathname.match(/^\/api\/matchmaking\/([^/]+)$/);
      if(match&&method==="GET"){json(response,200,games.getTicket(match[1],accessToken));return;}
      if(match&&method==="DELETE"){json(response,200,games.cancelTicket(match[1],accessToken));return;}

      if(pathname==="/api/rooms"&&method==="POST"){const body=await bodyJson(request);json(response,201,games.createRoom(body.playerName,"private",null,{maxPlayers:body.maxPlayers,scoreToWin:body.scoreToWin,series:body.series,questionMode:body.questionMode,showOpponentGuesses:body.showOpponentGuesses,roundDurationSeconds:body.roundDurationSeconds}));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)\/join$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,games.joinRoom(match[1],body.playerName));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)\/spectate$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,games.spectateRoom(match[1],body.playerName));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)$/);
      if(match&&method==="GET"){json(response,200,games.getRoom(match[1],accessToken));return;}
      if(match&&method==="DELETE"){json(response,200,games.leaveRoom(match[1],accessToken));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)\/ready$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,games.setRoomReady(match[1],accessToken,body.ready));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)\/start$/);
      if(match&&method==="POST"){json(response,200,games.startPrivateRoom(match[1],accessToken));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)\/kick$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,games.kickRoomPlayer(match[1],accessToken,body.playerId));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)\/guess$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,games.guessRoom(match[1],accessToken,body.playerId));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)\/surrender$/);
      if(match&&method==="POST"){json(response,200,games.surrenderRoom(match[1],accessToken));return;}
      match=pathname.match(/^\/api\/rooms\/([^/]+)\/rematch$/);
      if(match&&method==="POST"){json(response,200,games.rematchRoom(match[1],accessToken));return;}

      if(pathname==="/api/arknights/operators"&&method==="GET"){json(response,200,{operators:ARKNIGHTS_OPERATORS});return;}
      if(pathname==="/api/arknights/game/single"&&method==="POST"){const body=await bodyJson(request);json(response,201,arknightsGames.createSingle(body.playerName,body.questionMode));return;}
      match=pathname.match(/^\/api\/arknights\/game\/single\/([^/]+)$/);
      if(match&&method==="GET"){json(response,200,arknightsGames.getSingle(match[1],accessToken));return;}
      match=pathname.match(/^\/api\/arknights\/game\/single\/([^/]+)\/guess$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,arknightsGames.guessSingle(match[1],accessToken,body.playerId));return;}
      match=pathname.match(/^\/api\/arknights\/game\/single\/([^/]+)\/reveal$/);
      if(match&&method==="POST"){json(response,200,arknightsGames.revealSingle(match[1],accessToken));return;}

      if(pathname==="/api/arknights/matchmaking"&&method==="POST"){const body=await bodyJson(request);json(response,201,arknightsGames.matchmake(body.playerName,body.series,body.questionMode));return;}
      match=pathname.match(/^\/api\/arknights\/matchmaking\/([^/]+)$/);
      if(match&&method==="GET"){json(response,200,arknightsGames.getTicket(match[1],accessToken));return;}
      if(match&&method==="DELETE"){json(response,200,arknightsGames.cancelTicket(match[1],accessToken));return;}

      if(pathname==="/api/arknights/rooms"&&method==="POST"){const body=await bodyJson(request);json(response,201,arknightsGames.createRoom(body.playerName,"private",null,{maxPlayers:body.maxPlayers,scoreToWin:body.scoreToWin,series:body.series,questionMode:body.questionMode,showOpponentGuesses:body.showOpponentGuesses,roundDurationSeconds:body.roundDurationSeconds}));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)\/join$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,arknightsGames.joinRoom(match[1],body.playerName));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)\/spectate$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,arknightsGames.spectateRoom(match[1],body.playerName));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)$/);
      if(match&&method==="GET"){json(response,200,arknightsGames.getRoom(match[1],accessToken));return;}
      if(match&&method==="DELETE"){json(response,200,arknightsGames.leaveRoom(match[1],accessToken));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)\/ready$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,arknightsGames.setRoomReady(match[1],accessToken,body.ready));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)\/start$/);
      if(match&&method==="POST"){json(response,200,arknightsGames.startPrivateRoom(match[1],accessToken));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)\/kick$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,arknightsGames.kickRoomPlayer(match[1],accessToken,body.playerId));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)\/guess$/);
      if(match&&method==="POST"){const body=await bodyJson(request);json(response,200,arknightsGames.guessRoom(match[1],accessToken,body.playerId));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)\/surrender$/);
      if(match&&method==="POST"){json(response,200,arknightsGames.surrenderRoom(match[1],accessToken));return;}
      match=pathname.match(/^\/api\/arknights\/rooms\/([^/]+)\/rematch$/);
      if(match&&method==="POST"){json(response,200,arknightsGames.rematchRoom(match[1],accessToken));return;}
      if(pathname.startsWith("/api/")){json(response,404,{error:"接口不存在"});return;}
      if(method!=="GET"&&method!=="HEAD"){json(response,405,{error:"Method not allowed"},{Allow:"GET, HEAD"});return;}
      await staticResponse(request,response,pathname);
    }catch(error){const status=error.status||((error.code==="ENOENT"||error.code==="EISDIR")?404:500);if(status>=500)console.error(`[http] ${error.stack||error}`);json(response,status,{error:status===500?"服务器内部错误":error.message});}
    finally{if(Date.now()-started>1000)console.warn(`[slow] ${request.method} ${request.url} ${Date.now()-started}ms`);}
  });

  const cleanup=setInterval(()=>{games.cleanup();arknightsGames.cleanup();},60_000);cleanup.unref();
  const syncTimer=setInterval(synchronize,syncInterval);syncTimer.unref();
  if(apiKey&&!options.disableInitialSync)setTimeout(synchronize,100).unref();
  return {server,state,games,arknightsGames,synchronize,close:()=>new Promise(resolve=>server.close(resolve))};
}

export async function startAppServer(options={}) {
  const app=await createAppServer(options);
  const port=Number(options.port??process.env.PORT)||3000;
  const host=options.host ?? process.env.HOST ?? "127.0.0.1";
  await new Promise((resolve,reject)=>{app.server.once("error",reject);app.server.listen(port,host,resolve);});
  console.log(`[server] http://${host}:${port} · game + solver`);
  if(!process.env.PANDASCORE_API_KEY&&!options.apiKey)console.warn("[sync] PANDASCORE_API_KEY not configured; using cache/built-in data");
  return {...app,url:`http://${host}:${port}`};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  startAppServer().then(app=>{const stop=async()=>{console.log("\n[server] shutting down");await app.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);}).catch(error=>{console.error(error);process.exitCode=1;});
}

