import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAdminServer } from "../admin-server.mjs";

const players=Array.from({length:60},(_,index)=>({
  id:index===0?"Answer":`P${index}`,team:index%2?"A":"B",country:"法国",region:"欧洲",
  age:18+index%20,role:index%3?"步枪手":"狙击手",majorWins:index%2,majorApps:index%8,status:"现役"
}));
const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),"fragle-admin-test-"));
let releaseMajor;const majorGate=new Promise(resolve=>releaseMajor=resolve);let holdMajor=false;
const syncFetch=async()=>{if(holdMajor)await majorGate;throw new Error("mock network unavailable");};
const instance=await createAdminServer({players,apiKey:null,adminPassword:"test-password",dataDir,disableInitialSync:true,syncFetch,gameOptions:{random:()=>0}});
await new Promise((resolve,reject)=>{instance.server.once("error",reject);instance.server.listen(0,"127.0.0.1",resolve);});
const base=`http://127.0.0.1:${instance.server.address().port}`;

async function request(url,options={}){
  const response=await fetch(base+url,options);
  const contentType=response.headers.get("content-type")||"";
  const data=contentType.includes("application/json")?await response.json():await response.text();
  return{response,data};
}
function auth(token,method="GET",body){
  return{method,headers:{Authorization:`Bearer ${token}`,"Content-Type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})};
}

try{
  let result=await request("/admin");
  assert.equal(result.response.status,200);
  assert.match(result.data,/管理员登录/);

  result=await request("/play");
  assert.equal(result.response.status,200);
  assert.match(result.data,/hltv-overrides\.css/);
  assert.match(result.data,/href="\/admin"/);

  result=await request("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"wrong"})});
  assert.equal(result.response.status,401);

  result=await request("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"test-password"})});
  assert.equal(result.response.status,200);
  const token=result.data.token;
  assert.ok(token);

  for(let attempt=0;attempt<10;attempt+=1){
    result=await request("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json","X-Forwarded-For":"198.51.100.10"},body:JSON.stringify({password:"wrong"})});
    assert.equal(result.response.status,401);
  }
  result=await request("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json","X-Forwarded-For":"198.51.100.10"},body:JSON.stringify({password:"wrong"})});
  assert.equal(result.response.status,429);
  result=await request("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json","X-Forwarded-For":"198.51.100.11"},body:JSON.stringify({password:"test-password"})});
  assert.equal(result.response.status,200);

  result=await request("/api/admin/overview",auth(token));
  assert.equal(result.response.status,200);
  assert.equal(result.data.players,60);
  assert.equal(result.data.settings.syncIntervalHours,24);

  result=await request("/api/admin/settings",auth(token,"PUT",{autoSyncEnabled:true,syncIntervalHours:12.5}));
  assert.equal(result.response.status,200);
  assert.equal(result.data.syncIntervalHours,12.5);
  assert.ok(result.data.nextSyncAt);

  const added={id:"NewPlayer",team:"Test Team",country:"中国",region:"亚太",age:22,role:"指挥",majorWins:0,majorApps:1,status:"现役"};
  result=await request("/api/admin/players",auth(token,"POST",added));
  assert.equal(result.response.status,201);
  assert.equal(result.data.player.id,"NewPlayer");

  result=await request("/api/admin/players",auth(token,"POST",{...added,id:"BadTeam",team:"|status=Active"}));
  assert.equal(result.response.status,400);

  result=await request("/api/admin/players/NewPlayer",auth(token,"PUT",{...added,team:"Updated Team",age:23}));
  assert.equal(result.response.status,200);
  assert.equal(result.data.player.team,"Updated Team");

  result=await request("/api/admin/players/NewPlayer",auth(token,"DELETE"));
  assert.equal(result.response.status,200);

  result=await request("/api/admin/players",auth(token));
  assert.equal(result.data.players.some(player=>player.id==="NewPlayer"),false);

  // 四个手动同步端点 + 干员 CRUD 均要求管理员会话
  for(const kind of ["players","major","roles","arknights"]){
    result=await request(`/api/admin/sync/${kind}`,{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
    assert.equal(result.response.status,401);
  }
  result=await request("/api/admin/arknights/operators",{method:"POST",headers:{"Content-Type":"application/json"},body:"{}"});
  assert.equal(result.response.status,401);

  // 干员列表：来自种子数据，直接可用于游戏
  result=await request("/api/admin/arknights/operators",auth(token));
  assert.equal(result.response.status,200);
  const seedCount=result.data.operators.length;
  assert.ok(seedCount>=50);

  // 新增干员 -> 立即反映到公开游戏 API 与动态 /data/arknights-operators.js
  const operator={id:"ZZ99",name:"测试干员",en:"Test Operator",rarity:5,class:"近卫",subclass:"强攻手",faction:"罗德岛",group:"罗德岛",year:2024,position:["地面"],tags:["测试"],alterOf:null};
  result=await request("/api/admin/arknights/operators",auth(token,"POST",operator));
  assert.equal(result.response.status,201);
  assert.equal(result.data.operator.hasAlter,false);
  result=await request("/api/admin/arknights/operators",auth(token,"POST",operator));
  assert.equal(result.response.status,409);
  result=await request("/api/admin/arknights/operators",auth(token,"POST",{...operator,id:"BadRarity",rarity:9}));
  assert.equal(result.response.status,400);

  result=await request("/api/arknights/operators");
  assert.equal(result.response.status,200);
  assert.ok(result.data.operators.some(item=>item.id==="ZZ99"));
  result=await request("/data/arknights-operators.js");
  assert.equal(result.response.status,200);
  assert.match(String(result.data),/ZZ99/);

  // 重命名（旧 ID 进入删除名单，新 ID 覆盖）与删除
  result=await request("/api/admin/arknights/operators/ZZ99",auth(token,"PUT",{...operator,id:"ZZ98",name:"改名干员"}));
  assert.equal(result.response.status,200);
  result=await request("/api/admin/arknights/operators/ZZ99",auth(token,"PUT",{...operator,id:"ZZ98"}));
  assert.equal(result.response.status,404);
  result=await request("/api/arknights/operators");
  assert.equal(result.data.operators.some(item=>item.id==="ZZ98"),true);
  assert.equal(result.data.operators.some(item=>item.id==="ZZ99"),false);
  assert.equal(result.data.operators.length,seedCount+1);
  result=await request("/api/admin/arknights/operators/ZZ98",auth(token,"DELETE"));
  assert.equal(result.response.status,200);
  result=await request("/api/arknights/operators");
  assert.equal(result.data.operators.some(item=>item.id==="ZZ98"),false);
  assert.equal(result.data.operators.length,seedCount);

  // 手动同步互斥：第一个 major 同步挂起时，第二个请求应返回 409
  holdMajor=true;
  const first=request("/api/admin/sync/major",auth(token,"POST",{}));
  await new Promise(resolve=>setTimeout(resolve,150));
  result=await request("/api/admin/sync/major",auth(token,"POST",{}));
  assert.equal(result.response.status,409);
  releaseMajor();holdMajor=false;
  const firstResult=await first;
  assert.notEqual(firstResult.response.status,409);
  assert.ok(firstResult.data.error);

  // 失败结果也记录到 syncStatus，并可在 overview 中读取
  result=await request("/api/admin/overview",auth(token));
  assert.equal(result.response.status,200);
  assert.equal(result.data.syncStatus.major.ok,false);
  assert.ok(result.data.arknightsOperators>=50);

  const stored=JSON.parse(await fs.readFile(path.join(dataDir,"admin-state.json"),"utf8"));
  assert.equal(stored.settings.syncIntervalHours,12.5);
  assert.ok(stored.deletedIds.includes("newplayer"));
  assert.ok(stored.arknightsDeletedIds.includes("zz98"),"renamed/deleted operator ids recorded");
  assert.ok(stored.syncStatus.major&&stored.syncStatus.major.ok===false);
}finally{
  await instance.close();
  await fs.rm(dataDir,{recursive:true,force:true});
}

console.log("admin-server.test.mjs: all admin HTTP flows passed");
