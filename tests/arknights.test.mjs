import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { createAppServer } from "../app-server.mjs";
import { ArknightsGameManager, ARKNIGHTS_GAME_CONSTANTS, evaluateArknightsGuess } from "../arknights-game-engine.mjs";

const require = createRequire(import.meta.url);
const operators = require("../data/arknights-operators.js");

const decodeHtml = value => String(value || "")
  .replace(/<[^>]+>/g, "")
  .replace(/&nbsp;/gi, " ")
  .replace(/&amp;/gi, "&")
  .replace(/&quot;/gi, '"')
  .replace(/&#39;|&apos;/gi, "'")
  .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
  .replace(/\s+/g, " ")
  .trim();
const dataAttr = (tag, field) => decodeHtml(tag.match(new RegExp("\\bdata-" + field + "\\s*=\\s*[\"']([^\"']*)[\"']", "i"))?.[1] || "");
const rosterHtml = fs.readFileSync(new URL("../data/prts-operators.html", import.meta.url), "utf8");
const timelineHtml = fs.readFileSync(new URL("../data/prts-operator-release-dates.html", import.meta.url), "utf8");
const prtsRoster = new Map([...rosterHtml.matchAll(/<[^>]+data-zh=["'][^"']+["'][^>]*>/gi)].map(match => [dataAttr(match[0], "zh"), match[0]]));
const prtsTimeline = new Map();
for (const row of timelineHtml.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || []) {
  const cells = [...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(match => decodeHtml(match[1]));
  const year = cells[2]?.match(/(20\d{2})\s*年/)?.[1];
  if (cells.length >= 3 && Number.isInteger(Number(cells[1])) && year) prtsTimeline.set(cells[0], {rarity:Number(cells[1]),year:Number(year)});
}

assert.equal(operators.length, 427, "题库应与当前 PRTS 主列表的 427 位干员一致");
assert.equal(operators.length, prtsRoster.size);
assert.ok(operators.every(operator => !operator.id.startsWith("story-")));
assert.ok(operators.every(operator => operator.subclass !== "特殊作战单位"));
assert.equal(new Set(operators.map(operator => operator.id)).size, operators.length);
const alterFamilyIds = new Set(operators.filter(operator => operator.alterOf).flatMap(operator => [operator.id,operator.alterOf]));
for (const operator of operators) {
  for (const field of ["id","name","en","rarity","class","subclass","faction","group","year","tags","position","hasAlter"]) {
    assert.notEqual(operator[field], undefined, operator.id + " 缺少 " + field);
  }
  assert.ok(Number.isInteger(operator.rarity) && operator.rarity >= 1 && operator.rarity <= 6);
  assert.ok(Number.isInteger(operator.year) && operator.year >= 2019);
  assert.ok(Array.isArray(operator.tags) && operator.tags.length > 0);
  assert.ok(Array.isArray(operator.position) && operator.position.length > 0);
  if (operator.alterOf) assert.ok(operators.some(candidate => candidate.id === operator.alterOf), operator.id + " 的原型不存在");
  assert.equal(operator.hasAlter, alterFamilyIds.has(operator.id), operator.id + " 的异格有无标记不一致");

  const tag = prtsRoster.get(operator.name);
  const release = prtsTimeline.get(operator.name);
  assert.ok(tag, operator.name + " 不在 PRTS 主列表中");
  assert.ok(release, operator.name + " 不在 PRTS 上线时间表中");
  assert.equal(operator.rarity, Number(dataAttr(tag, "rarity")) + 1, operator.name + " 星级与 PRTS 主列表不一致");
  assert.equal(operator.rarity, release.rarity, operator.name + " 星级与 PRTS 上线表不一致");
  assert.equal(operator.year, release.year, operator.name + " 上线年份不一致");
  assert.equal(operator.class, dataAttr(tag, "profession"), operator.name + " 职业不一致");
  assert.equal(operator.subclass, dataAttr(tag, "subprofession"), operator.name + " 子职业不一致");
  const faction = dataAttr(tag, "logo") || dataAttr(tag, "nation");
  assert.equal(operator.faction, faction, operator.name + " 阵营不一致");
  assert.equal(operator.group, dataAttr(tag, "group") || dataAttr(tag, "nation") || faction, operator.name + " 阵营组不一致");
  const expectedTags = dataAttr(tag, "tag").split(/[\s,，、]+/).filter(value => value && value !== "近战位" && value !== "远程位");
  assert.deepEqual(operator.tags, expectedTags, operator.name + " 词缀不一致");
  const rawPosition = dataAttr(tag, "position");
  const expectedPosition = ["推击手","钩索师"].includes(operator.subclass) ? ["地面","高台"] : rawPosition === "远程位" ? ["高台"] : ["地面"];
  assert.deepEqual(operator.position, expectedPosition, operator.name + " 部署位不一致");
}
assert.equal(operators.filter(operator => operator.alterOf).length, 38);
assert.equal(operators.filter(operator => operator.hasAlter).length, 75);
assert.equal(operators.find(operator => operator.name === "12F").rarity, 2);
assert.equal(operators.find(operator => operator.name === "12F").year, 2019);
assert.equal(operators.find(operator => operator.name === "阿").rarity, 6);
for (const name of ["予愿安洁莉娜","嘉辛塔","时隙","珊比"]) assert.ok(operators.some(operator => operator.name === name), "缺少新干员 " + name);

const target = {id:"target",name:"目标",en:"Target",rarity:6,class:"近卫",subclass:"强攻手",faction:"罗德岛-A1",group:"罗德岛",year:2022,tags:["输出","群攻"],position:["近战位"],hasAlter:true};
const closeGuess = {id:"close",name:"接近",en:"Close",rarity:5,class:"近卫",subclass:"剑豪",faction:"罗德岛-A4",group:"罗德岛",year:2021,tags:["输出","生存"],position:["近战位","远程位"],hasAlter:true,alterOf:"target"};
const feedback = evaluateArknightsGuess(closeGuess, target);
assert.deepEqual(feedback, {
  nickname:"miss", rarity:"close-up", class:"exact", subclass:"close", faction:"close",
  year:"close-up", tags:"close", position:"close", alter:"exact"
});
assert.equal(evaluateArknightsGuess({...closeGuess,hasAlter:false}, target).alter, "miss");
assert.equal(evaluateArknightsGuess({...closeGuess,hasAlter:false}, {...target,hasAlter:false}).alter, "exact");
assert.equal(ARKNIGHTS_GAME_CONSTANTS.MAX_GUESSES, 10);
assert.deepEqual(ARKNIGHTS_GAME_CONSTANTS.PRIVATE_PLAYER_OPTIONS, [2,3,4]);
assert.deepEqual(ARKNIGHTS_GAME_CONSTANTS.QUESTION_MODES, ["full","simple","beginner"]);

let now = 1_000;
const manager = new ArknightsGameManager(operators, {now:()=>now, random:()=>0});
const answer = operators[0];
const single = manager.createSingle("Solo");
assert.equal(single.state.maxGuesses, 10);
assert.equal(manager.guessSingle(single.gameId, single.playerToken, answer.id).status, "won");

const queued = manager.matchmake("Queue A", 1, "full");
assert.equal(queued.status, "waiting");
const matched = manager.matchmake("Queue B", 5, "full");
assert.equal(matched.status, "matched");
assert.equal(matched.series, 3);
const matchedA = manager.getTicket(queued.ticketId, queued.playerToken);
assert.equal(manager.getRoom(matchedA.roomCode, matchedA.playerToken).status, "playing");

const room = manager.createRoom("Host", "private", null, {maxPlayers:4,scoreToWin:2,roundDurationSeconds:45});
const guestA = manager.joinRoom(room.roomCode, "Guest A");
const guestB = manager.joinRoom(room.roomCode, "Guest B");
assert.equal(manager.spectateRoom(room.roomCode, "Caster").state.viewerType, "spectator");
assert.throws(()=>manager.startPrivateRoom(room.roomCode, room.playerToken), /准备/);
for (const participant of [room,guestA,guestB]) manager.setRoomReady(room.roomCode, participant.playerToken, true);
const started = manager.startPrivateRoom(room.roomCode, room.playerToken);
assert.equal(started.status, "playing");
assert.equal(started.maxPlayers, 4);
assert.equal(started.roundDurationSeconds, 45);
assert.equal(started.scoreToWin, 2);
assert.equal(manager.surrenderRoom(room.roomCode, guestA.playerToken).status, "playing");
const kicked = manager.kickRoomPlayer(room.roomCode, room.playerToken, guestB.playerId);
assert.equal(kicked.players.length, 2);
assert.equal(kicked.status, "playing");
assert.equal(manager.guessRoom(room.roomCode, room.playerToken, answer.id).status, "round_settling");
now += ARKNIGHTS_GAME_CONSTANTS.ROUND_INTERMISSION_MS;
assert.equal(manager.getRoom(room.roomCode, room.playerToken).status, "playing");

const rematchRoom = manager.createRoom("Rematch Host", "private", null, {scoreToWin:1});
const rematchGuest = manager.joinRoom(rematchRoom.roomCode, "Rematch Guest");
for (const participant of [rematchRoom,rematchGuest]) manager.setRoomReady(rematchRoom.roomCode, participant.playerToken, true);
manager.startPrivateRoom(rematchRoom.roomCode, rematchRoom.playerToken);
manager.guessRoom(rematchRoom.roomCode, rematchRoom.playerToken, answer.id);
assert.equal(manager.rematchRoom(rematchRoom.roomCode, rematchRoom.playerToken).rematchCount, 1);
assert.equal(manager.rematchRoom(rematchRoom.roomCode, rematchGuest.playerToken).status, "playing");

const players = Array.from({length:60}, (_,index)=>({
  id:"P"+index,team:index%2?"A":"B",country:"China",region:"Asia",age:18+index%20,
  role:"Rifler",majorWins:0,majorApps:index%4,status:"active"
}));
const app = await createAppServer({players,apiKey:null,disableInitialSync:true,arknightsGameOptions:{random:()=>0}});
await new Promise((resolve,reject)=>{
  app.server.once("error",reject);
  app.server.listen(0,"127.0.0.1",resolve);
});
const base = "http://127.0.0.1:" + app.server.address().port;
const jsonHeaders = {"Content-Type":"application/json"};
const tokenHeaders = token => ({...jsonHeaders,"X-Player-Token":token});

try {
  let response = await fetch(base + "/arknights");
  assert.equal(response.status, 200);
  const gameHtml = await response.text();
  assert.match(gameHtml, /方舟弗一把/);
  assert.equal((gameHtml.match(/class="home-mode-card"/g)||[]).length, 3);
  for (const id of ["view-single","view-match","view-room","roomMaxPlayers","roomInviteModal"]) assert.match(gameHtml, new RegExp('id="' + id + '"'));
  assert.ok(gameHtml.includes("/arknights-tool"));
  assert.ok(gameHtml.includes("/js/arknights-game-config.js"));
  assert.ok(gameHtml.includes("/js/game.js"));
  assert.doesNotMatch(gameHtml, /id="operatorSearch"/);

  response = await fetch(base + "/api/arknights/operators");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).operators.length, operators.length);

  response = await fetch(base + "/arknights-tool");
  assert.equal(response.status, 200);
  const toolHtml = await response.text();
  for (const id of ["filterClass","filterSubclass","filterRarity","filterFaction","filterPosition","operatorRows"]) assert.match(toolHtml, new RegExp('id="' + id + '"'));

  for (const asset of ["/css/arknights.css","/css/arknights-game.css","/css/arknights-tool.css","/js/arknights-game-config.js","/js/arknights-tool.js","/data/arknights-operators.js"]) {
    response = await fetch(base + asset);
    assert.equal(response.status, 200, asset);
  }
  response = await fetch(base + "/js/arknights-game-config.js");
  const gameSource = await response.text();
  assert.ok(gameSource.includes('apiRoot:"/api/arknights"'));
  assert.match(gameSource, /maxGuesses:10/);
  assert.match(gameSource, /inviteBrand:"方舟弗一把"/);
  assert.ok(gameSource.includes("operator.name,operator.en,operator.id"));
  assert.match(gameSource, /arknights-game-table/);
  assert.match(gameSource, /hasAlter\?"有":"无"/);

  response = await fetch(base + "/api/arknights/game/single", {method:"POST",headers:jsonHeaders,body:JSON.stringify({playerName:"HTTP Solo"})});
  const httpSingle = await response.json();
  assert.equal(response.status, 201);
  response = await fetch(base + "/api/arknights/game/single/" + httpSingle.gameId + "/guess", {method:"POST",headers:tokenHeaders(httpSingle.playerToken),body:JSON.stringify({playerId:answer.id})});
  assert.equal((await response.json()).status, "won");

  response = await fetch(base + "/api/arknights/rooms", {method:"POST",headers:jsonHeaders,body:JSON.stringify({playerName:"HTTP Host",maxPlayers:3,scoreToWin:2})});
  const httpHost = await response.json();
  assert.equal(response.status, 201);
  response = await fetch(base + "/api/arknights/rooms/" + httpHost.roomCode + "/join", {method:"POST",headers:jsonHeaders,body:JSON.stringify({playerName:"HTTP Guest"})});
  const httpGuest = await response.json();
  assert.equal(response.status, 200);
  for (const participant of [httpHost,httpGuest]) {
    response = await fetch(base + "/api/arknights/rooms/" + httpHost.roomCode + "/ready", {method:"POST",headers:tokenHeaders(participant.playerToken),body:JSON.stringify({ready:true})});
    assert.equal(response.status, 200);
  }
  response = await fetch(base + "/api/arknights/rooms/" + httpHost.roomCode + "/start", {method:"POST",headers:tokenHeaders(httpHost.playerToken)});
  assert.equal((await response.json()).status, "playing");
} finally {
  await app.close();
}

console.log("arknights.test.mjs: roster, UI, API, and multiplayer rules passed");
