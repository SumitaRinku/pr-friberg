import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const OUTPUT=path.join(ROOT,"data","players.json");
const MAJOR_RECORDS=path.join(ROOT,"data","major-records.json");
const ROLE_OVERRIDES=path.join(ROOT,"data","player-role-overrides.json");
const API_ROOT="https://api.pandascore.co";
const PAGE_SIZE=100;
const PROFESSIONAL_TIERS=["s","a","b"];

const REGION_CODES={
  "欧洲":new Set("AD AL AT BA BE BG CH CY CZ DE DK EE ES FI FR GB GR HR HU IE IS IT LT LU LV MC ME MK MT NL NO PL PT RO RS SE SI SK UA XK".split(" ")),
  "独联体":new Set("AM AZ BY GE KZ KG MD RU TJ TM UZ".split(" ")),
  "亚太":new Set("AF AE BD BH BN BT CN HK ID IN IQ IR JO JP KH KR KW LA LB LK MM MN MO MV MY NP OM PH PK PS QA SA SG SY TH TL TR TW VN YE".split(" ")),
  "大洋洲":new Set("AU FJ FM KI MH NR NZ PG PW SB TO TV VU WS".split(" ")),
  "北美洲":new Set("AG BS BB BZ CA CR CU DM DO GD GT HN HT JM KN LC MX NI PA SV TT US VC".split(" ")),
  "南美洲":new Set("AR BO BR CL CO EC GY PE PY SR UY VE".split(" ")),
  "非洲和以色列":new Set("AO BF BI BJ BW CD CF CG CI CM CV DJ DZ EG ER ET GA GH GM GN GQ GW IL KE KM LR LS LY MA MG ML MR MU MW MZ NA NE NG RW SC SD SL SN SO SS ST SZ TD TG TN TZ UG ZA ZM ZW".split(" "))
};
const COUNTRY_ALIASES={"Bosnia and Herzegovina":"波黑","Czech Republic":"捷克","United Kingdom":"英国","United States":"美国","South Korea":"韩国","North Macedonia":"北马其顿","Hong Kong":"中国香港","Taiwan":"中国台湾","Mongolia":"蒙古","Russia":"俄罗斯","Ukraine":"乌克兰","Kazakhstan":"哈萨克斯坦","Israel":"以色列","Turkey":"土耳其","Türkiye":"土耳其"};
const REGION_BY_NAME={"俄罗斯":"独联体","白俄罗斯":"独联体","哈萨克斯坦":"独联体","阿塞拜疆":"独联体","乌兹别克斯坦":"独联体","中国":"亚太","中国香港":"亚太","中国台湾":"亚太","蒙古":"亚太","土耳其":"亚太","澳大利亚":"大洋洲","新西兰":"大洋洲","美国":"北美洲","加拿大":"北美洲","墨西哥":"北美洲","危地马拉":"北美洲","巴西":"南美洲","阿根廷":"南美洲","乌拉圭":"南美洲","智利":"南美洲","以色列":"非洲和以色列","南非":"非洲和以色列"};

function cleanCode(value){const code=String(value||"").trim().toUpperCase();return/^[A-Z]{2}$/.test(code)?code:null;}
function chunks(items,size){const result=[];for(let index=0;index<items.length;index+=size)result.push(items.slice(index,index+size));return result;}
function addDays(date,days){const result=new Date(date);result.setUTCDate(result.getUTCDate()+days);return result;}
function deduplicate(players){const result=new Map();for(const player of players){const key=player.id.toLowerCase(),existing=result.get(key);if(!existing||(!existing.team||existing.team==="无队伍")&&player.team!=="无队伍")result.set(key,player);}return[...result.values()];}

export function regionFor(nationality,fallbackCountry,fallbackRegion="欧洲"){const code=cleanCode(nationality);if(code)for(const[region,codes]of Object.entries(REGION_CODES))if(codes.has(code))return region;return REGION_BY_NAME[fallbackCountry]||fallbackRegion;}
export function countryFor(nationality,fallback="未知"){if(!nationality)return fallback;const code=cleanCode(nationality);if(code){try{return new Intl.DisplayNames(["zh-CN"],{type:"region"}).of(code)||fallback;}catch{return fallback;}}return COUNTRY_ALIASES[nationality]||String(nationality);}
export function ageFromBirthday(birthday,now=new Date()){if(!birthday)return null;const born=new Date(`${birthday}T00:00:00Z`);if(Number.isNaN(born.getTime()))return null;let age=now.getUTCFullYear()-born.getUTCFullYear();if(now.getUTCMonth()<born.getUTCMonth()||now.getUTCMonth()===born.getUTCMonth()&&now.getUTCDate()<born.getUTCDate())age-=1;return age>=14&&age<=80?age:null;}
export function normalizeRole(role,fallback="步枪手"){const value=String(role||"").toLowerCase();if(/狙击手|awp|sniper/.test(value))return"狙击手";if(/指挥|igl|leader|captain/.test(value))return"指挥";if(/自由人|lurk|free/.test(value))return"自由人";if(/步枪手|rifl|entry|support|player/.test(value))return"步枪手";return fallback||"步枪手";}

export function normalizeTeamName(value,fallback="无队伍"){const team=String(value??"").trim();return !team||/^\|?\s*[a-z][a-z0-9_]*\s*=/i.test(team)||/[\r\n{}]/.test(team)||/^\?{2,}$/.test(team)?fallback:team;}

function hasPlayerRole(role){
  return /awp|sniper|igl|leader|captain|lurk|free|rifl|entry|support|player/i.test(String(role||""));
}

export function normalizePlayer(raw,previous=null,now=new Date()){
  const id=String(raw.name||raw.slug||"").trim();if(!id)return null;
  const country=countryFor(raw.nationality,previous?.country||"未知");
  const calculatedAge=ageFromBirthday(raw.birthday,now),apiAge=Number.isFinite(raw.age)?raw.age:null;
  const status=raw.active===false?"退役":"现役";
  return{id,team:normalizeTeamName(raw.current_team?.name||previous?.team,status==="退役"?"退役":"无队伍"),country,region:regionFor(raw.nationality,country,previous?.region||"欧洲"),age:calculatedAge??apiAge??previous?.age??18,role:normalizeRole(raw.role,previous?.role),majorWins:Number(previous?.majorWins||0),majorApps:Number(previous?.majorApps||0),status,pandascoreId:raw.id??null,birthday:raw.birthday||null,imageUrl:raw.image_url||null,modifiedAt:raw.modified_at||null};
}

async function apiGet(apiKey,pathname,params,fetchImpl){
  const url=new URL(pathname,API_ROOT);for(const[key,value]of Object.entries(params||{}))url.searchParams.set(key,String(value));
  const response=await fetchImpl(url,{headers:{Accept:"application/json",Authorization:`Bearer ${apiKey}`}});
  if(!response.ok){const detail=(await response.text()).slice(0,300);throw new Error(`PandaScore 请求失败：HTTP ${response.status} ${detail}`);}
  const data=await response.json();if(!Array.isArray(data))throw new Error("PandaScore 返回格式异常");
  return{data,total:Number(response.headers.get("x-total"))||data.length};
}

export async function fetchActivePlayers(apiKey,fetchImpl=fetch,now=new Date()){
  if(!apiKey)throw new Error("缺少 PANDASCORE_API_KEY 环境变量");
  const from=addDays(now,-365),to=addDays(now,120),tournaments=[];let requests=0,page=1,total=0;
  do{
    const result=await apiGet(apiKey,"/csgo/tournaments",{"filter[tier]":PROFESSIONAL_TIERS.join(","),"range[begin_at]":`${from.toISOString()},${to.toISOString()}`,"page[size]":PAGE_SIZE,"page[number]":page,"sort":"-begin_at"},fetchImpl);
    requests+=1;total=result.total;tournaments.push(...result.data);if(result.data.length<PAGE_SIZE||tournaments.length>=total)break;page+=1;
  }while(page<=5);
  if(page>5&&tournaments.length<total)throw new Error(`职业赛事超过安全分页上限 ${5*PAGE_SIZE}`);
  const teamIds=[...new Set(tournaments.flatMap(item=>item.teams||[]).map(team=>team.id).filter(Boolean))];
  const teams=[];
  for(const batch of chunks(teamIds,PAGE_SIZE)){
    const result=await apiGet(apiKey,"/csgo/teams",{"filter[id]":batch.join(","),"page[size]":PAGE_SIZE},fetchImpl);requests+=1;teams.push(...result.data);
  }
  const playerMap=new Map();for(const team of teams)for(const player of team.players||[]){const key=String(player.name||"").trim().toLowerCase();if(key&&player.active!==false)playerMap.set(key,{...player,current_team:{id:team.id,name:team.name}});}const players=[...playerMap.values()];
  if(players.length<50)throw new Error(`职业赛事阵容仅 ${players.length} 位，拒绝覆盖现有数据`);
  return{players,requests,total:players.length,tournaments:tournaments.length,teams:teams.length};
}

export function normalizeMajorName(value){return String(value??"").trim();}
export function majorRecordKeys(record){
  const keys=[];
  const id=normalizeMajorName(record?.id);
  if(id)keys.push("name:"+id);
  if(record?.pandascoreId!==undefined&&record?.pandascoreId!==null)keys.push("ps:"+String(record.pandascoreId).trim());
  return keys;
}
export function majorRecordIdentity(record){
  const page=normalizeMajorName(record?.wikiPage).toLowerCase();
  if(page)return"wiki:"+page;
  return"name:"+normalizeMajorName(record?.id).toLowerCase()+":"+String(record?.countryCode||"").toUpperCase();
}
export function createMajorRecordIndex(records){
  const byPandascoreId=new Map(),byLowerName=new Map(),byExactName=new Map(),byWikiPage=new Map();
  for(const record of records||[]){
    const wikiPage=normalizeMajorName(record?.wikiPage).toLowerCase();if(wikiPage)byWikiPage.set(wikiPage,record);
    if(record?.pandascoreId!==undefined&&record?.pandascoreId!==null)byPandascoreId.set(String(record.pandascoreId).trim(),record);
    const names=[record?.id,record?.profileId,record?.wikiPage,...(Array.isArray(record?.alternateIds)?record.alternateIds:[])].map(normalizeMajorName).filter(Boolean);
    for(const name of new Set(names)){
      const key=name.toLowerCase();
      if(!byLowerName.has(key))byLowerName.set(key,[]);
      if(!byLowerName.get(key).includes(record))byLowerName.get(key).push(record);
    }
    const id=normalizeMajorName(record?.id);
    if(!id)continue;
    if(!byExactName.has(id))byExactName.set(id,[]);
    byExactName.get(id).push(record);
  }
  return{records:records||[],byPandascoreId,byLowerName,byExactName,byWikiPage};
}
export function majorRecordFor(player,index){
  const wikiPage=normalizeMajorName(player?.wikiPage).toLowerCase();if(wikiPage&&index.byWikiPage.has(wikiPage))return index.byWikiPage.get(wikiPage);
  const pandascoreId=player?.pandascoreId;
  if(pandascoreId!==undefined&&pandascoreId!==null){
    const byId=index.byPandascoreId.get(String(pandascoreId).trim());
    if(byId)return byId;
  }
  const name=normalizeMajorName(player?.id);
  if(!name)return null;
  const candidates=index.byLowerName.get(name.toLowerCase())||[];
  if(!candidates.length)return null;
  const playerCountry=normalizeMajorName(player?.country);
  if(playerCountry){
    const countryMatches=candidates.filter(function(record){return countryFor(record.countryCode,"未知")===playerCountry;});
    if(countryMatches.length===1)return countryMatches[0];
  }
  const exact=index.byExactName.get(name)||[];
  if(exact.length===1)return exact[0];
  return candidates.length===1?candidates[0]:null;
}
async function loadMajorRecords(){try{const payload=JSON.parse(await fs.readFile(MAJOR_RECORDS,"utf8"));return Array.isArray(payload.records)?payload.records:[];}catch{return[];}}
async function loadRoleOverrides(){try{const payload=JSON.parse(await fs.readFile(ROLE_OVERRIDES,"utf8"));return new Map(Object.entries(payload.roles||{}).map(([id,role])=>[id.toLowerCase(),normalizeRole(role,null)]).filter(([,role])=>role));}catch{return new Map();}}
async function loadSeedPlayers(){await import(pathToFileURL(path.join(ROOT,"js","players.js")).href+"?seed="+Date.now());return globalThis.DEFAULT_PLAYERS||[];}
async function loadPreviousPlayers(){try{const payload=JSON.parse(await fs.readFile(OUTPUT,"utf8"));return Array.isArray(payload)?payload:payload.players||[];}catch{return[];}}

function lastMajorYear(record){
  const years=(record?.majorEvents||[]).flatMap(function(event){
    return[...String(event||"").matchAll(/\b(20\d{2})\b/g)].map(function(match){return Number(match[1]);});
  });
  return years.length?Math.max.apply(null,years):null;
}
function estimatedMajorAge(record,now){
  const first=Number(record?.firstMajorYear);
  const estimate=Number.isInteger(first)?now.getUTCFullYear()-first+20:30;
  return Math.max(18,Math.min(60,estimate));
}
function syntheticMajorStatus(record,now){
  const status=String(record?.profileStatus||"").toLowerCase();
  if(status.includes("retired"))return"退役";
  if(record?.role&&!hasPlayerRole(record.role))return"\u9000\u5f79";
  const yearsActive=String(record?.yearsActive||"").toLowerCase();
  if(status.includes("active")&&yearsActive.includes("present"))return"现役";
  const latest=lastMajorYear(record);
  return status.includes("active")&&latest&&latest>=now.getUTCFullYear()-1?"现役":"退役";
}
function uniqueMajorId(record,country,usedIds){
  const base=normalizeMajorName(record?.id)||"未知选手";
  if(!usedIds.has(base.toLowerCase()))return base;
  const qualifier=country&&country!=="未知"?country:normalizeMajorName(record?.wikiPage)||String(record?.countryCode||"Major");
  let candidate=base+" ("+qualifier+")",suffix=2;
  while(usedIds.has(candidate.toLowerCase()))candidate=base+" ("+qualifier+" "+suffix+++")";
  return candidate;
}
function syntheticMajorPlayer(record,id,roleOverrides,now){
  record={...record,latestMajorTeam:""};
  const country=countryFor(record.countryCode,"未知"),status=syntheticMajorStatus(record,now);
  const birthday=record.birthday||null,age=ageFromBirthday(birthday,now);
  const overrideKeys=[id,record.wikiPage,record.profileId,...(record.alternateIds||[])].map(function(value){return normalizeMajorName(value).toLowerCase();}).filter(Boolean);
  const roleOverride=overrideKeys.map(function(key){return roleOverrides.get(key);}).find(Boolean);
  const roleVerified=hasPlayerRole(record.role)||Boolean(roleOverride);
  if(roleOverride&&!roleOverrides.has(id.toLowerCase()))roleOverrides.set(id.toLowerCase(),roleOverride);
  return{
    id,
    team:status==="退役"?"退役":normalizeTeamName(record.currentTeam||record.latestMajorTeam),
    country,
    region:regionFor(record.countryCode,country,"欧洲"),
    age:age??estimatedMajorAge(record,now),
    ageEstimated:age===null,
    role:normalizeRole(record.role,roleOverrides.get(id.toLowerCase())||"步枪手"),
    majorWins:Number.isInteger(record.majorWins)?record.majorWins:0,
    roleEstimated:!roleVerified,
    majorApps:Number.isInteger(record.majorApps)?record.majorApps:0,
    status,
    pandascoreId:null,
    birthday,
    wikiPage:record.wikiPage||null,
    dataSource:"Liquipedia Major Player Database"
  };
}
export function mergeMajorParticipants(players,records,roleOverrides=new Map(),now=new Date()){
  const index=createMajorRecordIndex(records),matched=new Set();
  const basePlayers=players.filter(function(player){return player.dataSource!=="Liquipedia Major Player Database";});
  const enrichedCandidates=basePlayers.map(function(player){
    const record=majorRecordFor(player,index);
    if(!record)return{...player,majorWins:0,majorApps:0};
    matched.add(majorRecordIdentity(record));
    return{...player,majorWins:Number.isInteger(record.majorWins)?record.majorWins:0,majorApps:Number.isInteger(record.majorApps)?record.majorApps:0,_majorIdentity:majorRecordIdentity(record)};
  });
  const enriched=[];
  const enrichedByMajorIdentity=new Map();
  for(const candidate of enrichedCandidates){
    if(!candidate._majorIdentity){enriched.push(candidate);continue;}
    const existing=enrichedByMajorIdentity.get(candidate._majorIdentity);
    if(!existing){enrichedByMajorIdentity.set(candidate._majorIdentity,candidate);enriched.push(candidate);continue;}
    const candidateScore=(candidate.pandascoreId?2:0)+(candidate.imageUrl?1:0);
    const existingScore=(existing.pandascoreId?2:0)+(existing.imageUrl?1:0);
    if(candidateScore<=existingScore)continue;
    enriched[enriched.indexOf(existing)]=candidate;
    enrichedByMajorIdentity.set(candidate._majorIdentity,candidate);
  }
  const usedIds=new Set(enriched.map(function(player){return player.id.toLowerCase();}));
  const synthetic=[];
  for(const record of records){
    if(matched.has(majorRecordIdentity(record))||Number(record.majorApps)<1)continue;
    const country=countryFor(record.countryCode,"未知");
    const id=uniqueMajorId(record,country,usedIds);
    usedIds.add(id.toLowerCase());
    synthetic.push(syntheticMajorPlayer(record,id,roleOverrides,now));
  }
  return[...enriched,...synthetic].filter(function(player){
    const sourceVerified=Boolean(player.pandascoreId)&&(roleOverrides.has(player.id.toLowerCase())||player._roleVerified===true)&&player.country!=="\u672a\u77e5";
    return player.dataSource==="Liquipedia Major Player Database"||Number(player.majorApps)>0||sourceVerified;
  }).map(function(player){
    const override=roleOverrides.get(player.id.toLowerCase());
    delete player._roleVerified;
    delete player._majorIdentity;
    return override?{...player,role:override}:player;
  }).sort(function(a,b){return a.id.localeCompare(b.id);});
}

export async function buildDatabase(rawPlayers,previousPlayers,seedPlayers,now=new Date(),options={}){
  const previousMap=new Map([...seedPlayers,...previousPlayers].map(function(player){return[player.id.toLowerCase(),player];}));
  const majorRecords=Array.isArray(options.majorRecords)?options.majorRecords:await loadMajorRecords();
  const roleOverrides=options.roleOverrides instanceof Map?options.roleOverrides:await loadRoleOverrides();
  const apiPlayers=rawPlayers.map(function(raw){
    const player=normalizePlayer(raw,previousMap.get(String(raw.name||raw.slug||"").toLowerCase()),now);
    return player?{...player,_roleVerified:hasPlayerRole(raw.role)}:player;
  }).filter(Boolean);
  const apiIds=new Set(apiPlayers.map(function(player){return player.id.toLowerCase();}));
  const retained=[...previousMap.values()].filter(function(player){return!apiIds.has(player.id.toLowerCase());});
  return mergeMajorParticipants(deduplicate([...apiPlayers,...retained]),majorRecords,roleOverrides,now);
}
async function writeAtomic(filePath,payload){await fs.mkdir(path.dirname(filePath),{recursive:true});const temporary=`${filePath}.${process.pid}.tmp`;await fs.writeFile(temporary,JSON.stringify(payload,null,2)+"\n","utf8");try{await fs.rename(temporary,filePath);}catch(error){if(error.code!=="EEXIST"&&error.code!=="EPERM")throw error;await fs.copyFile(temporary,filePath);await fs.unlink(temporary);}}
async function loadLocalEnv(){if(process.env.PANDASCORE_API_KEY)return;try{const text=await fs.readFile(path.join(ROOT,".env"),"utf8");for(const line of text.split(/\r?\n/)){const match=line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);if(match&&process.env[match[1]]===undefined)process.env[match[1]]=match[2].replace(/^(["'])(.*)\1$/,"$2");}}catch{}}

export async function rebuildFromLocalData(){
  const now=new Date(),seedPlayers=await loadSeedPlayers(),previousPlayers=await loadPreviousPlayers();
  const roleOverrides=await loadRoleOverrides();
  const players=await buildDatabase([],previousPlayers,seedPlayers,now,{roleOverrides});
  if(players.length<50)throw new Error("本地重建结果仅 "+players.length+" 位，拒绝覆盖现有数据");
  const majorPayload=JSON.parse(await fs.readFile(MAJOR_RECORDS,"utf8"));
  let previousPayload={};try{previousPayload=JSON.parse(await fs.readFile(OUTPUT,"utf8"));}catch{}
  let previousRolePayload={};try{previousRolePayload=JSON.parse(await fs.readFile(ROLE_OVERRIDES,"utf8"));}catch{}
  const retainedRoles={};
  for(const player of players){const role=roleOverrides.get(player.id.toLowerCase());if(role)retainedRoles[player.id]=role;}
  const retainedRoleCount=Object.keys(retainedRoles).length;
  const rolePayload={...previousRolePayload,updatedAt:now.toISOString(),stats:{...(previousRolePayload.stats||{}),players:players.length,stored:retainedRoleCount},roles:retainedRoles};
  await writeAtomic(ROLE_OVERRIDES,rolePayload);

  const payload={
    ...previousPayload,
    schemaVersion:4,
    source:"Existing player database + Liquipedia Major Player Database",
    majorSource:majorPayload.source,
    majorUpdatedAt:majorPayload.updatedAt,
    updatedAt:now.toISOString(),
    stats:{...(previousPayload.stats||{}),players:players.length,majorPlayers:players.filter(function(player){return Number(player.majorApps)>=1;}).length,roleOverrides:retainedRoleCount,localMajorRebuild:true},
    players
  };
  await writeAtomic(OUTPUT,payload);
  console.log("Local Major pool rebuild complete: "+players.length+" players, "+payload.stats.majorPlayers+" Major participants");
  return payload;
}

export async function main(){await loadLocalEnv();const now=new Date(),seedPlayers=await loadSeedPlayers(),previousPlayers=await loadPreviousPlayers();const fetched=await fetchActivePlayers(process.env.PANDASCORE_API_KEY,fetch,now);const players=await buildDatabase(fetched.players,previousPlayers,seedPlayers,now);if(players.length<50)throw new Error(`同步结果仅 ${players.length} 位，拒绝覆盖现有数据`);const majorPayload=JSON.parse(await fs.readFile(MAJOR_RECORDS,"utf8"));const payload={schemaVersion:4,source:"PandaScore professional tournaments + Liquipedia Major Player Database",majorSource:majorPayload.source,majorUpdatedAt:majorPayload.updatedAt,updatedAt:now.toISOString(),stats:{players:players.length,majorPlayers:players.filter(function(player){return Number(player.majorApps)>=1;}).length,apiRecords:fetched.players.length,requests:fetched.requests,tournaments:fetched.tournaments,teams:fetched.teams},players};await writeAtomic(OUTPUT,payload);console.log(`PandaScore professional sync complete: ${players.length} players (${fetched.players.length} refreshed), ${fetched.requests} requests`);return payload;}

if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const operation=process.argv.includes("--local")?rebuildFromLocalData:main;
  operation().catch(error=>{console.error(error.message);process.exitCode=1;});
}