import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAppServer } from "./app-server.mjs";
import { parseEnv, validPlayers, sanitizePlayers, isInvalidTeamValue, resolveClientIp } from "./server.mjs";
import { main as syncMajorRecords } from "./scripts/sync-major-records.mjs";
import { synchronizeRoles } from "./scripts/sync-liquipedia-roles.mjs";
import { main as generateArknightsData } from "./scripts/generate-arknights-data.mjs";

const ROOT=path.dirname(fileURLToPath(import.meta.url));
const SESSION_MS=8*60*60*1000;

async function loadEnv(){try{const values=parseEnv(await fs.readFile(path.join(ROOT,".env"),"utf8"));for(const [key,value] of Object.entries(values))if(process.env[key]===undefined)process.env[key]=value;}catch(error){if(error.code!=="ENOENT")console.warn(`[env] ${error.message}`);}}
function sendJson(response,status,data,extra={}){response.writeHead(status,{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...extra});response.end(JSON.stringify(data));}
async function readJson(request){const chunks=[];let size=0;for await(const chunk of request){size+=chunk.length;if(size>65_536)throw Object.assign(new Error("请求内容过大"),{status:413});chunks.push(chunk);}if(!chunks.length)return{};try{return JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{throw Object.assign(new Error("JSON 格式错误"),{status:400});}}
function hash(value){return crypto.createHash("sha256").update(String(value)).digest();}
function safePasswordEqual(a,b){const left=hash(a),right=hash(b);return crypto.timingSafeEqual(left,right);}
function clientIp(request){return resolveClientIp(request);}
function cleanString(value,max=80){return String(value??"").trim().slice(0,max);}
function normalizePlayer(input){return{id:cleanString(input.id,40),team:cleanString(input.team,80)||"无队伍",country:cleanString(input.country,30)||"未知",region:cleanString(input.region,30)||"欧洲",age:Number(input.age),role:cleanString(input.role,30)||"步枪手",majorWins:Number(input.majorWins),majorApps:Number(input.majorApps),status:input.status==="退役"?"退役":"现役"};}
function validatePlayer(player){if(!player.id)throw Object.assign(new Error("选手 ID 不能为空"),{status:400});if(isInvalidTeamValue(player.team))throw Object.assign(new Error("战队名称无效，不能填写 Liquipedia 模板字段"),{status:400});if(!Number.isInteger(player.age)||player.age<14||player.age>80)throw Object.assign(new Error("年龄必须为 14–80 的整数"),{status:400});for(const field of ["majorWins","majorApps"])if(!Number.isInteger(player[field])||player[field]<0||player[field]>100)throw Object.assign(new Error("Major 数据必须是非负整数"),{status:400});return player;}
async function writeAtomic(filePath,data){await fs.mkdir(path.dirname(filePath),{recursive:true});const temporary=`${filePath}.${process.pid}.tmp`;await fs.writeFile(temporary,JSON.stringify(data,null,2)+"\n","utf8");try{await fs.rename(temporary,filePath);}catch(error){if(error.code!=="EEXIST"&&error.code!=="EPERM")throw error;await fs.copyFile(temporary,filePath);await fs.unlink(temporary);}}

// 干员种子数据：generate-arknights-data 生成的 data/arknights-operators.js。
// 用带查询串的 import 穿透模块缓存，同步后可重新加载。
async function loadOperatorSeed(){
  await import(pathToFileURL(path.join(ROOT,"data","arknights-operators.js")).href+`?seed=${Date.now()}`);
  const operators=globalThis.ARKNIGHTS_OPERATORS;
  if(!Array.isArray(operators)||operators.length<50)throw new Error("干员种子数据无效");
  return operators;
}
function cleanList(value,max=8,length=20){
  const items=Array.isArray(value)?value:String(value??"").split(/[,，、]/);
  return items.map(item=>cleanString(item,length)).filter(Boolean).slice(0,max);
}
function normalizeOperator(input){
  return{
    id:cleanString(input.id,40),name:cleanString(input.name,40),en:cleanString(input.en,60),
    rarity:Number(input.rarity),class:cleanString(input.class,20),subclass:cleanString(input.subclass,30),
    faction:cleanString(input.faction,40),group:cleanString(input.group,40),year:Number(input.year),
    tags:cleanList(input.tags,8,20),position:cleanList(input.position,2,10),
    alterOf:cleanString(input.alterOf,40)||null
  };
}
function validateOperator(operator){
  if(!operator.id||!operator.name||!operator.en)throw Object.assign(new Error("干员 ID、名称与英文名不能为空"),{status:400});
  if(!Number.isInteger(operator.rarity)||operator.rarity<1||operator.rarity>6)throw Object.assign(new Error("星级必须为 1–6 的整数"),{status:400});
  for(const field of ["class","subclass","faction","group"])if(!operator[field])throw Object.assign(new Error("职业、分支、阵营与团队不能为空"),{status:400});
  const currentYear=new Date().getFullYear();
  if(!Number.isInteger(operator.year)||operator.year<2019||operator.year>currentYear)throw Object.assign(new Error(`年份必须为 2019–${currentYear} 的整数`),{status:400});
  return operator;
}

export async function createAdminServer(options={}){
  await loadEnv();
  const dataDir=options.dataDir||path.join(ROOT,"data");
  const adminStatePath=path.join(dataDir,"admin-state.json");
  const playerDataPath=path.join(dataDir,"players.json");
  let adminData={settings:{autoSyncEnabled:true,syncIntervalHours:24},overrides:{},deletedIds:[],arknightsOverrides:{},arknightsDeletedIds:[],syncStatus:{}};
  try{const loaded=JSON.parse(await fs.readFile(adminStatePath,"utf8"));adminData={settings:{...adminData.settings,...loaded.settings},overrides:loaded.overrides||{},deletedIds:Array.isArray(loaded.deletedIds)?loaded.deletedIds:[],arknightsOverrides:loaded.arknightsOverrides||{},arknightsDeletedIds:Array.isArray(loaded.arknightsDeletedIds)?loaded.arknightsDeletedIds:[],syncStatus:loaded.syncStatus&&typeof loaded.syncStatus==="object"?loaded.syncStatus:{}};}catch{}
  const app=await createAppServer({players:options.players,apiKey:options.apiKey,disableInitialSync:true,disableSyncTimer:true,gameOptions:options.gameOptions});
  let operatorSeed=await loadOperatorSeed();
  const adminPassword=options.adminPassword??process.env.ADMIN_PASSWORD??"";
  const sessions=new Map(),loginAttempts=new Map();
  let autoTimer=null,nextSyncAt=null,syncLock=false;

  function applyOverrides(){const map=new Map(app.state.players.map(player=>[player.id.toLowerCase(),player]));for(const id of adminData.deletedIds)map.delete(id.toLowerCase());for(const player of Object.values(adminData.overrides)){map.set(player.id.toLowerCase(),player);}const merged=sanitizePlayers([...map.values()]).sort((a,b)=>a.id.localeCompare(b.id));if(!validPlayers(merged))throw new Error("应用管理员覆盖后选手数据无效");app.state.players=merged;app.games.setPlayers(merged);return merged;}
  // 生效干员 = 种子 + 管理员覆盖 − 删除；hasalter/alterOf 在合并后统一重算。
  function applyArknightsOverrides(){
    const map=new Map(operatorSeed.map(operator=>[operator.id.toLowerCase(),operator]));
    for(const id of adminData.arknightsDeletedIds)map.delete(id.toLowerCase());
    for(const operator of Object.values(adminData.arknightsOverrides))map.set(operator.id.toLowerCase(),operator);
    const merged=[...map.values()].sort((a,b)=>a.name.localeCompare(b.name,"zh-CN")||a.id.localeCompare(b.id));
    if(merged.length<50)throw new Error("应用管理员覆盖后干员数据不足 50 位");
    const idLookup=new Map(merged.map(operator=>[operator.id.toLowerCase(),operator.id]));
    for(const operator of merged)operator.hasAlter=false;
    for(const operator of merged){
      const sourceId=operator.alterOf?idLookup.get(operator.alterOf.toLowerCase()):null;
      operator.alterOf=sourceId||null;
      if(sourceId){const source=map.get(sourceId.toLowerCase());if(source)source.hasAlter=true;}
    }
    app.state.operators=merged;app.state.operatorsUpdatedAt=new Date().toISOString();
    if(!app.arknightsGames.setPlayers(merged))throw new Error("应用干员数据到游戏引擎失败");
    return merged;
  }
  applyOverrides();applyArknightsOverrides();
  async function persistPlayers(source="Admin"){const updatedAt=new Date().toISOString();await writeAtomic(playerDataPath,{schemaVersion:1,source,updatedAt,stats:{players:app.state.players.length},players:app.state.players});app.state.source=source;app.state.updatedAt=updatedAt;}
  async function persistAdmin(){await writeAtomic(adminStatePath,adminData);}
  async function syncNow(){const success=await app.synchronize();if(!success)return false;applyOverrides();await persistPlayers("PandaScore + Admin overrides");return true;}
  // 手动同步统一入口：互斥（进行中 409），每个数据源记录最近一次结果到 admin-state.json。
  async function runSync(kind,worker){
    if(syncLock||app.state.syncing)throw Object.assign(new Error("已有同步正在进行中"),{status:409});
    syncLock=true;const started=Date.now();
    try{
      const summary=await worker();
      adminData.syncStatus[kind]={ok:true,lastRunAt:new Date().toISOString(),durationMs:Date.now()-started,summary:String(summary)};
      await persistAdmin();
      return adminData.syncStatus[kind];
    }catch(error){
      adminData.syncStatus[kind]={ok:false,lastRunAt:new Date().toISOString(),durationMs:Date.now()-started,summary:String(error.message||error)};
      try{await persistAdmin();}catch{}
      throw error;
    }finally{syncLock=false;}
  }
  async function syncPlayersWorker(){
    const ok=await syncNow();
    if(!ok)throw Object.assign(new Error(app.state.lastError||"同步失败"),{status:502});
    return `${app.state.players.length} 位选手`;
  }
  async function syncMajorWorker(){
    const payload=await syncMajorRecords(options.syncFetch);
    let summary=`${payload.stats?.records??0} 条 Major 记录`;
    const merged=await syncNow();
    summary+=merged?`，已合并至 ${app.state.players.length} 位选手`:"；PandaScore 选手合并未执行（缺少 API Key 或失败）";
    return summary;
  }
  async function syncRolesWorker(){
    const payload=await synchronizeRoles({fetchImpl:options.syncFetch});
    const loaded=JSON.parse(await fs.readFile(playerDataPath,"utf8"));
    const players=sanitizePlayers(loaded.players);
    if(!validPlayers(players))throw new Error("位置同步后的选手数据无效");
    app.state.players=players;app.games.setPlayers(players);applyOverrides();
    await persistPlayers("Liquipedia roles + Admin overrides");
    return `${payload.stats?.resolved??0} 个位置已刷新`;
  }
  async function syncArknightsWorker(){
    await generateArknightsData({force:true});
    operatorSeed=await loadOperatorSeed();
    applyArknightsOverrides();
    return `${operatorSeed.length} 位干员（PRTS 强制刷新）`;
  }
  // 定时器回调内的异常不能成为 unhandledRejection（Node 15+ 默认直接崩进程），必须就地捕获。
  async function runScheduledSync(label){try{await syncNow();}catch(error){console.error(`[admin] ${label}失败：${error.stack||error}`);}finally{schedule();}}
  function schedule(){if(autoTimer)clearTimeout(autoTimer);autoTimer=null;nextSyncAt=null;if(!adminData.settings.autoSyncEnabled)return;const hours=Math.min(168,Math.max(1,Number(adminData.settings.syncIntervalHours)||24));adminData.settings.syncIntervalHours=hours;nextSyncAt=new Date(Date.now()+hours*3_600_000).toISOString();autoTimer=setTimeout(()=>runScheduledSync("自动同步"),hours*3_600_000);autoTimer.unref();}
  schedule();if(adminData.settings.autoSyncEnabled&&!options.disableInitialSync)setTimeout(()=>runScheduledSync("初始同步"),200).unref();

  const innerPort=await new Promise((resolve,reject)=>{app.server.once("error",reject);app.server.listen(0,"127.0.0.1",()=>resolve(app.server.address().port));});
  function sessionFrom(request){const header=String(request.headers.authorization||"");const token=header.startsWith("Bearer ")?header.slice(7):"";const session=sessions.get(token);if(!session||session.expiresAt<Date.now()){if(token)sessions.delete(token);return null;}session.expiresAt=Date.now()+SESSION_MS;return session;}
  function requireAdmin(request){const session=sessionFrom(request);if(!session)throw Object.assign(new Error("管理员登录已失效"),{status:401});return session;}
  function proxy(request,response){const ip=clientIp(request);const headers={...request.headers,host:`127.0.0.1:${innerPort}`,"x-forwarded-for":ip,"x-real-ip":ip};const upstream=http.request({host:"127.0.0.1",port:innerPort,path:request.url,method:request.method,headers},upstreamResponse=>{response.writeHead(upstreamResponse.statusCode||502,upstreamResponse.headers);upstreamResponse.pipe(response);});upstream.on("error",()=>sendJson(response,502,{error:"内部应用服务不可用"}));request.pipe(upstream);}
  async function page(response,fileName,transform=false){let html=await fs.readFile(path.join(ROOT,fileName),"utf8");if(transform){html=html.replace("</head>",'<link rel="stylesheet" href="/css/hltv-overrides.css"></head>');if(fileName==="play.html")html=html.replace("</nav>",'<a href="/admin">管理</a></nav>');else html=html.replace("<nav>",'<nav><a class="link-btn" href="/play" style="text-decoration:none">游戏大厅</a><a class="link-btn" href="/admin" style="text-decoration:none">管理</a>');}response.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-cache","X-Content-Type-Options":"nosniff"});response.end(html);}

  const server=http.createServer(async(request,response)=>{try{const url=new URL(request.url||"/","http://localhost"),pathname=url.pathname,method=request.method||"GET";if((pathname==="/admin"||pathname==="/admin/")&&method==="GET"){await page(response,"admin.html");return;}if(pathname==="/"&&method==="GET"){await page(response,"home.html");return;}if((pathname==="/play"||pathname==="/play/")&&method==="GET"){await page(response,"play.html",true);return;}if((pathname==="/tool"||pathname==="/tool/")&&method==="GET"){await page(response,"index.html",true);return;}
    if(pathname==="/api/admin/login"&&method==="POST"){const ip=clientIp(request),attempt=loginAttempts.get(ip)||{count:0,resetAt:Date.now()+900_000};if(Date.now()>attempt.resetAt){attempt.count=0;attempt.resetAt=Date.now()+900_000;}if(attempt.count>=10){sendJson(response,429,{error:"登录失败次数过多，请稍后再试"});return;}const body=await readJson(request);if(!adminPassword){sendJson(response,503,{error:"服务器尚未配置 ADMIN_PASSWORD"});return;}if(!safePasswordEqual(body.password||"",adminPassword)){attempt.count++;loginAttempts.set(ip,attempt);sendJson(response,401,{error:"管理员密码错误"});return;}loginAttempts.delete(ip);const token=crypto.randomBytes(32).toString("base64url");sessions.set(token,{createdAt:Date.now(),expiresAt:Date.now()+SESSION_MS});sendJson(response,200,{token,expiresIn:SESSION_MS});return;}
    if(pathname==="/api/admin/logout"&&method==="POST"){const header=String(request.headers.authorization||"");if(header.startsWith("Bearer "))sessions.delete(header.slice(7));sendJson(response,200,{ok:true});return;}
    if(pathname.startsWith("/api/admin/")){requireAdmin(request);
      if(pathname==="/api/admin/overview"&&method==="GET"){sendJson(response,200,{players:app.state.players.length,source:app.state.source,updatedAt:app.state.updatedAt,syncing:app.state.syncing,lastAttemptAt:app.state.lastAttemptAt,lastError:app.state.lastError,apiConfigured:Boolean(process.env.PANDASCORE_API_KEY||options.apiKey),rooms:app.games.rooms.size,waiting:app.games.queue.length,arknightsOperators:app.state.operators.length,nextSyncAt,settings:adminData.settings,syncStatus:adminData.syncStatus});return;}
      if(pathname==="/api/admin/settings"&&method==="GET"){sendJson(response,200,{...adminData.settings,nextSyncAt});return;}
      if(pathname==="/api/admin/settings"&&method==="PUT"){const body=await readJson(request),hours=Number(body.syncIntervalHours);if(!Number.isFinite(hours)||hours<1||hours>168)throw Object.assign(new Error("同步间隔必须为 1–168 小时"),{status:400});adminData.settings={autoSyncEnabled:Boolean(body.autoSyncEnabled),syncIntervalHours:Math.round(hours*10)/10};await persistAdmin();schedule();sendJson(response,200,{...adminData.settings,nextSyncAt});return;}
      if(pathname==="/api/admin/sync"&&method==="POST"){await runSync("players",syncPlayersWorker);sendJson(response,200,{ok:true,players:app.state.players.length,updatedAt:app.state.updatedAt});return;}
      if(pathname==="/api/admin/sync/players"&&method==="POST"){sendJson(response,200,await runSync("players",syncPlayersWorker));return;}
      if(pathname==="/api/admin/sync/major"&&method==="POST"){sendJson(response,200,await runSync("major",syncMajorWorker));return;}
      if(pathname==="/api/admin/sync/roles"&&method==="POST"){sendJson(response,200,await runSync("roles",syncRolesWorker));return;}
      if(pathname==="/api/admin/sync/arknights"&&method==="POST"){sendJson(response,200,await runSync("arknights",syncArknightsWorker));return;}
      if(pathname==="/api/admin/players"&&method==="GET"){sendJson(response,200,{players:app.state.players,overrides:Object.keys(adminData.overrides),deletedIds:adminData.deletedIds});return;}
      if(pathname==="/api/admin/players"&&method==="POST"){const player=validatePlayer(normalizePlayer(await readJson(request)));if(app.state.players.some(item=>item.id.toLowerCase()===player.id.toLowerCase()))throw Object.assign(new Error("选手 ID 已存在"),{status:409});adminData.overrides[player.id.toLowerCase()]=player;adminData.deletedIds=adminData.deletedIds.filter(id=>id!==player.id.toLowerCase());applyOverrides();await Promise.all([persistAdmin(),persistPlayers()]);sendJson(response,201,{player});return;}
      const match=pathname.match(/^\/api\/admin\/players\/(.+)$/);if(match){const original=decodeURIComponent(match[1]),key=original.toLowerCase(),current=app.state.players.find(player=>player.id.toLowerCase()===key);if(!current)throw Object.assign(new Error("选手不存在"),{status:404});if(method==="PUT"){const player=validatePlayer(normalizePlayer(await readJson(request))),newKey=player.id.toLowerCase();if(newKey!==key&&app.state.players.some(item=>item.id.toLowerCase()===newKey))throw Object.assign(new Error("新选手 ID 已存在"),{status:409});delete adminData.overrides[key];if(newKey!==key&&!adminData.deletedIds.includes(key))adminData.deletedIds.push(key);adminData.overrides[newKey]=player;adminData.deletedIds=adminData.deletedIds.filter(id=>id!==newKey);applyOverrides();await Promise.all([persistAdmin(),persistPlayers()]);sendJson(response,200,{player});return;}if(method==="DELETE"){if(app.state.players.length<=50)throw Object.assign(new Error("至少必须保留 50 位选手"),{status:409});delete adminData.overrides[key];if(!adminData.deletedIds.includes(key))adminData.deletedIds.push(key);applyOverrides();await Promise.all([persistAdmin(),persistPlayers()]);sendJson(response,200,{ok:true});return;}}
      if(pathname==="/api/admin/arknights/operators"&&method==="GET"){sendJson(response,200,{operators:app.state.operators,overrides:Object.keys(adminData.arknightsOverrides),deletedIds:adminData.arknightsDeletedIds});return;}
      if(pathname==="/api/admin/arknights/operators"&&method==="POST"){
        const operator=validateOperator(normalizeOperator(await readJson(request)));
        if(app.state.operators.some(item=>item.id.toLowerCase()===operator.id.toLowerCase()))throw Object.assign(new Error("干员 ID 已存在"),{status:409});
        adminData.arknightsOverrides[operator.id.toLowerCase()]=operator;
        adminData.arknightsDeletedIds=adminData.arknightsDeletedIds.filter(id=>id!==operator.id.toLowerCase());
        applyArknightsOverrides();await persistAdmin();
        sendJson(response,201,{operator});return;
      }
      const operatorMatch=pathname.match(/^\/api\/admin\/arknights\/operators\/(.+)$/);
      if(operatorMatch){
        const original=decodeURIComponent(operatorMatch[1]),key=original.toLowerCase();
        const current=app.state.operators.find(operator=>operator.id.toLowerCase()===key);
        if(!current)throw Object.assign(new Error("干员不存在"),{status:404});
        if(method==="PUT"){
          const operator=validateOperator(normalizeOperator(await readJson(request))),newKey=operator.id.toLowerCase();
          if(newKey!==key&&app.state.operators.some(item=>item.id.toLowerCase()===newKey))throw Object.assign(new Error("新干员 ID 已存在"),{status:409});
          delete adminData.arknightsOverrides[key];
          if(newKey!==key&&!adminData.arknightsDeletedIds.includes(key))adminData.arknightsDeletedIds.push(key);
          adminData.arknightsOverrides[newKey]=operator;
          adminData.arknightsDeletedIds=adminData.arknightsDeletedIds.filter(id=>id!==newKey);
          applyArknightsOverrides();await persistAdmin();
          sendJson(response,200,{operator});return;
        }
        if(method==="DELETE"){
          if(app.state.operators.length<=50)throw Object.assign(new Error("至少必须保留 50 位干员"),{status:409});
          delete adminData.arknightsOverrides[key];
          if(!adminData.arknightsDeletedIds.includes(key))adminData.arknightsDeletedIds.push(key);
          applyArknightsOverrides();await persistAdmin();
          sendJson(response,200,{ok:true});return;
        }
      }
      sendJson(response,404,{error:"管理员接口不存在"});return;
    }
    proxy(request,response);
  }catch(error){const status=error.status||500;if(status>=500)console.error(`[admin] ${error.stack||error}`);sendJson(response,status,{error:status===500?"服务器内部错误":error.message});}});
  const close=async()=>{if(autoTimer)clearTimeout(autoTimer);for(const token of sessions.keys())sessions.delete(token);await Promise.all([new Promise(resolve=>server.close(resolve)),app.close()]);};
  return{server,app,close,adminData,get nextSyncAt(){return nextSyncAt;}};
}

export async function startAdminServer(options={}){const instance=await createAdminServer(options),port=Number(options.port??process.env.PORT)||3000,host=options.host??process.env.HOST??"127.0.0.1";await new Promise((resolve,reject)=>{instance.server.once("error",reject);instance.server.listen(port,host,resolve);});console.log(`[server] http://${host}:${port} · game + solver + admin`);if(!process.env.ADMIN_PASSWORD)console.warn("[admin] ADMIN_PASSWORD not configured; admin login disabled");return{...instance,url:`http://${host}:${port}`};}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  process.on("unhandledRejection",error=>{console.error(`[admin] unhandledRejection: ${error?.stack||error}`);});
  startAdminServer().then(instance=>{const stop=async()=>{console.log("\n[server] shutting down");await instance.close();process.exit(0);};process.once("SIGINT",stop);process.once("SIGTERM",stop);}).catch(error=>{console.error(error);process.exitCode=1;});
}
