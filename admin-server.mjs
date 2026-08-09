import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAppServer } from "./app-server.mjs";
import { parseEnv, validPlayers, sanitizePlayers, isInvalidTeamValue } from "./server.mjs";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const DAY_MS=86_400_000;
const SESSION_MS=8*60*60*1000;

async function loadEnv(){try{const values=parseEnv(await fs.readFile(path.join(ROOT,".env"),"utf8"));for(const [key,value] of Object.entries(values))if(process.env[key]===undefined)process.env[key]=value;}catch(error){if(error.code!=="ENOENT")console.warn(`[env] ${error.message}`);}}
function sendJson(response,status,data,extra={}){response.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...extra});response.end(JSON.stringify(data));}
async function readJson(request){const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>65_536)throw Object.assign(new Error("请求内容过大"),{status:413});chunks.push(chunk);}if(!chunks.length)return{};try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw Object.assign(new Error("JSON 格式错误"),{status:400});}}
function hash(value){return crypto.createHash("sha256").update(String(value)).digest();}
function safePasswordEqual(a,b){const left=hash(a),right=hash(b);return crypto.timingSafeEqual(left,right);}
function clientIp(request){const forwarded=String(request.headers["x-forwarded-for"]||"").split(",")[0].trim();return forwarded||request.socket.remoteAddress||"unknown";}
function cleanString(value,max=80){return String(value??"").trim().slice(0,max);}
function normalizePlayer(input){return{id:cleanString(input.id,40),team:cleanString(input.team,80)||"无队伍",country:cleanString(input.country,30)||"未知",region:cleanString(input.region,30)||"欧洲",age:Number(input.age),role:cleanString(input.role,30)||"步枪手",majorWins:Number(input.majorWins),majorApps:Number(input.majorApps),status:input.status==="退役"?"退役":"现役"};}
function validatePlayer(player){if(!player.id)throw Object.assign(new Error("选手 ID 不能为空"),{status:400});if(isInvalidTeamValue(player.team))throw Object.assign(new Error("战队名称无效，不能填写 Liquipedia 模板字段"),{status:400});if(!Number.isInteger(player.age)||player.age<14||player.age>80)throw Object.assign(new Error("年龄必须为 14–80 的整数"),{status:400});for(const field of ["majorWins","majorApps"])if(!Number.isInteger(player[field])||player[field]<0||player[field]>100)throw Object.assign(new Error("Major 数据必须是非负整数"),{status:400});return player;}
async function writeAtomic(filePath,data){await fs.mkdir(path.dirname(filePath),{recursive:true});const temporary=`${filePath}.${process.pid}.tmp`;await fs.writeFile(temporary,JSON.stringify(data,null,2)+"\n","utf8");try{await fs.rename(temporary,filePath);}catch(error){if(error.code!=="EEXIST"&&error.code!=="EPERM")throw error;await fs.copyFile(temporary,filePath);await fs.unlink(temporary);}}

export async function createAdminServer(options={}){
  await loadEnv();
  const dataDir=options.dataDir||path.join(ROOT,"data");
  const adminStatePath=path.join(dataDir,"admin-state.json");
  const playerDataPath=path.join(dataDir,"players.json");
  let adminData={settings:{autoSyncEnabled:true,syncIntervalHours:24},overrides:{},deletedIds:[]};
  try{const loaded=JSON.parse(await fs.readFile(adminStatePath,"utf8"));adminData={settings:{...adminData.settings,...loaded.settings},overrides:loaded.overrides||{},deletedIds:Array.isArray(loaded.deletedIds)?loaded.deletedIds:[]};}catch{}
  const originalInterval=process.env.SYNC_INTERVAL_MS;process.env.SYNC_INTERVAL_MS=String(24*DAY_MS);
  const app=await createAppServer({players:options.players,apiKey:options.apiKey,disableInitialSync:true,gameOptions:options.gameOptions});
  if(originalInterval===undefined)delete process.env.SYNC_INTERVAL_MS;else process.env.SYNC_INTERVAL_MS=originalInterval;
  const adminPassword=options.adminPassword??process.env.ADMIN_PASSWORD??"";
  const sessions=new Map(),loginAttempts=new Map();
  let autoTimer=null,nextSyncAt=null;

  function applyOverrides(){const map=new Map(app.state.players.map(player=>[player.id.toLowerCase(),player]));for(const id of adminData.deletedIds)map.delete(id.toLowerCase());for(const player of Object.values(adminData.overrides)){map.set(player.id.toLowerCase(),player);}const merged=sanitizePlayers([...map.values()]).sort((a,b)=>a.id.localeCompare(b.id));if(!validPlayers(merged))throw new Error("应用管理员覆盖后选手数据无效");app.state.players=merged;app.games.setPlayers(merged);return merged;}
  applyOverrides();
  async function persistPlayers(source="Admin"){const updatedAt=new Date().toISOString();await writeAtomic(playerDataPath,{schemaVersion:1,source,updatedAt,stats:{players:app.state.players.length},players:app.state.players});app.state.source=source;app.state.updatedAt=updatedAt;}
  async function persistAdmin(){await writeAtomic(adminStatePath,adminData);}
  async function syncNow(){const success=await app.synchronize();if(!success)return false;applyOverrides();await persistPlayers("PandaScore + Admin overrides");return true;}
  function schedule(){if(autoTimer)clearTimeout(autoTimer);autoTimer=null;nextSyncAt=null;if(!adminData.settings.autoSyncEnabled)return;const hours=Math.min(168,Math.max(1,Number(adminData.settings.syncIntervalHours)||24));adminData.settings.syncIntervalHours=hours;nextSyncAt=new Date(Date.now()+hours*3_600_000).toISOString();autoTimer=setTimeout(async()=>{await syncNow();schedule();},hours*3_600_000);autoTimer.unref();}
  schedule();if(adminData.settings.autoSyncEnabled&&!options.disableInitialSync)setTimeout(async()=>{await syncNow();schedule();},200).unref();

  const innerPort=await new Promise((resolve,reject)=>{app.server.once("error",reject);app.server.listen(0,"127.0.0.1",()=>resolve(app.server.address().port));});
  function sessionFrom(request){const header=String(request.headers.authorization||"");const token=header.startsWith("Bearer ")?header.slice(7):"";const session=sessions.get(token);if(!session||session.expiresAt<Date.now()){if(token)sessions.delete(token);return null;}session.expiresAt=Date.now()+SESSION_MS;return session;}
  function requireAdmin(request){const session=sessionFrom(request);if(!session)throw Object.assign(new Error("管理员登录已失效"),{status:401});return session;}
  function proxy(request,response){const headers={...request.headers,host:`127.0.0.1:${innerPort}`,"x-forwarded-for":clientIp(request)};const upstream=http.request({host:"127.0.0.1",port:innerPort,path:request.url,method:request.method,headers},upstreamResponse=>{response.writeHead(upstreamResponse.statusCode||502,upstreamResponse.headers);upstreamResponse.pipe(response);});upstream.on("error",()=>sendJson(response,502,{error:"内部应用服务不可用"}));request.pipe(upstream);}
  async function page(response,fileName,transform=false){let html=await fs.readFile(path.join(ROOT,fileName),"utf8");if(transform){html=html.replace("</head>",'<link rel="stylesheet" href="/css/hltv-overrides.css"></head>');if(fileName==="play.html")html=html.replace("</nav>",'<a href="/admin">管理</a></nav>');else html=html.replace("<nav>",'<nav><a class="link-btn" href="/play" style="text-decoration:none">游戏大厅</a><a class="link-btn" href="/admin" style="text-decoration:none">管理</a>');}response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"});response.end(html);}

  const server=http.createServer(async(request,response)=>{try{const url=new URL(request.url||"/","http://localhost"),pathname=url.pathname,method=request.method||"GET";if((pathname==="/admin"||pathname==="/admin/")&&method==="GET"){await page(response,"admin.html");return;}if(pathname==="/"&&method==="GET"){await page(response,"home.html");return;}if((pathname==="/play"||pathname==="/play/")&&method==="GET"){await page(response,"play.html",true);return;}if((pathname==="/tool"||pathname==="/tool/")&&method==="GET"){await page(response,"index.html",true);return;}
    if(pathname==="/api/admin/login"&&method==="POST"){const ip=clientIp(request),attempt=loginAttempts.get(ip)||{count:0,resetAt:Date.now()+900_000};if(Date.now()>attempt.resetAt){attempt.count=0;attempt.resetAt=Date.now()+900_000;}if(attempt.count>=10){sendJson(response,429,{error:"登录失败次数过多，请稍后再试"});return;}const body=await readJson(request);if(!adminPassword){sendJson(response,503,{error:"服务器尚未配置 ADMIN_PASSWORD"});return;}if(!safePasswordEqual(body.password||"",adminPassword)){attempt.count++;loginAttempts.set(ip,attempt);sendJson(response,401,{error:"管理员密码错误"});return;}loginAttempts.delete(ip);const token=crypto.randomBytes(32).toString("base64url");sessions.set(token,{createdAt:Date.now(),expiresAt:Date.now()+SESSION_MS});sendJson(response,200,{token,expiresIn:SESSION_MS});return;}
    if(pathname==="/api/admin/logout"&&method==="POST"){const header=String(request.headers.authorization||"");if(header.startsWith("Bearer "))sessions.delete(header.slice(7));sendJson(response,200,{ok:true});return;}
    if(pathname.startsWith("/api/admin/")){requireAdmin(request);
      if(pathname==="/api/admin/overview"&&method==="GET"){sendJson(response,200,{players:app.state.players.length,source:app.state.source,updatedAt:app.state.updatedAt,syncing:app.state.syncing,lastAttemptAt:app.state.lastAttemptAt,lastError:app.state.lastError,apiConfigured:Boolean(process.env.PANDASCORE_API_KEY||options.apiKey),rooms:app.games.rooms.size,waiting:app.games.queue.length,nextSyncAt,settings:adminData.settings});return;}
      if(pathname==="/api/admin/settings"&&method==="GET"){sendJson(response,200,{...adminData.settings,nextSyncAt});return;}
      if(pathname==="/api/admin/settings"&&method==="PUT"){const body=await readJson(request),hours=Number(body.syncIntervalHours);if(!Number.isFinite(hours)||hours<1||hours>168)throw Object.assign(new Error("同步间隔必须为 1–168 小时"),{status:400});adminData.settings={autoSyncEnabled:Boolean(body.autoSyncEnabled),syncIntervalHours:Math.round(hours*10)/10};await persistAdmin();schedule();sendJson(response,200,{...adminData.settings,nextSyncAt});return;}
      if(pathname==="/api/admin/sync"&&method==="POST"){if(app.state.syncing)throw Object.assign(new Error("同步正在进行中"),{status:409});const success=await syncNow();if(!success)throw Object.assign(new Error(app.state.lastError||"同步失败"),{status:502});sendJson(response,200,{ok:true,players:app.state.players.length,updatedAt:app.state.updatedAt});return;}
      if(pathname==="/api/admin/players"&&method==="GET"){sendJson(response,200,{players:app.state.players,overrides:Object.keys(adminData.overrides),deletedIds:adminData.deletedIds});return;}
      if(pathname==="/api/admin/players"&&method==="POST"){const player=validatePlayer(normalizePlayer(await readJson(request)));if(app.state.players.some(item=>item.id.toLowerCase()===player.id.toLowerCase()))throw Object.assign(new Error("选手 ID 已存在"),{status:409});adminData.overrides[player.id.toLowerCase()]=player;adminData.deletedIds=adminData.deletedIds.filter(id=>id!==player.id.toLowerCase());applyOverrides();await Promise.all([persistAdmin(),persistPlayers()]);sendJson(response,201,{player});return;}
      const match=pathname.match(/^\/api\/admin\/players\/(.+)$/);if(match){const original=decodeURIComponent(match[1]),key=original.toLowerCase(),current=app.state.players.find(player=>player.id.toLowerCase()===key);if(!current)throw Object.assign(new Error("选手不存在"),{status:404});if(method==="PUT"){const player=validatePlayer(normalizePlayer(await readJson(request))),newKey=player.id.toLowerCase();if(newKey!==key&&app.state.players.some(item=>item.id.toLowerCase()===newKey))throw Object.assign(new Error("新选手 ID 已存在"),{status:409});delete adminData.overrides[key];if(newKey!==key&&!adminData.deletedIds.includes(key))adminData.deletedIds.push(key);adminData.overrides[newKey]=player;adminData.deletedIds=adminData.deletedIds.filter(id=>id!==newKey);applyOverrides();await Promise.all([persistAdmin(),persistPlayers()]);sendJson(response,200,{player});return;}if(method==="DELETE"){if(app.state.players.length<=50)throw Object.assign(new Error("至少必须保留 50 位选手"),{status:409});delete adminData.overrides[key];if(!adminData.deletedIds.includes(key))adminData.deletedIds.push(key);applyOverrides();await Promise.all([persistAdmin(),persistPlayers()]);sendJson(response,200,{ok:true});return;}}
      sendJson(response,404,{error:"管理员接口不存在"});return;
    }
    proxy(request,response);
  }catch(error){const status=error.status||500;if(status>=500)console.error(`[admin] ${error.stack||error}`);sendJson(response,status,{error:status===500?"服务器内部错误":error.message});}});
  const close=async()=>{if(autoTimer)clearTimeout(autoTimer);for(const token of sessions.keys())sessions.delete(token);await Promise.all([new Promise(resolve=>server.close(resolve)),app.close()]);};
  return{server,app,close,adminData,get nextSyncAt(){return nextSyncAt;}};
}

export async function startAdminServer(options={}){const instance=await createAdminServer(options),port=Number(options.port??process.env.PORT)||3000,host=options.host??process.env.HOST??"127.0.0.1";await new Promise((resolve,reject)=>{instance.server.once("error",reject);instance.server.listen(port,host,resolve);});console.log(`[server] http://${host}:${port} · game + solver + admin`);if(!process.env.ADMIN_PASSWORD)console.warn("[admin] ADMIN_PASSWORD not configured; admin login disabled");return{...instance,url:`http://${host}:${port}`};}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){startAdminServer().then(instance=>{const stop=async()=>{console.log("\n[server] shutting down");await instance.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);}).catch(error=>{console.error(error);process.exitCode=1;});}
