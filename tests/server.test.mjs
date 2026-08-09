import assert from "node:assert/strict";
import { parseEnv, validPlayers, sanitizeTeam, sanitizePlayers, createPlayersScript, contentType } from "../server.mjs";

assert.deepEqual(parseEnv("# comment\nPORT=3000\nHOST='127.0.0.1'\nNAME=hello=world\n"), {
  PORT:"3000", HOST:"127.0.0.1", NAME:"hello=world"
});
assert.equal(contentType("index.html"), "text/html; charset=utf-8");
assert.equal(contentType("app.js"), "text/javascript; charset=utf-8");
assert.equal(validPlayers([]), false);

const sample = Array.from({length:50}, (_, index) => ({
  id:`p${index}`, team:"T", country:"法国", region:"欧洲", age:20,
  role:"步枪手", majorWins:0, majorApps:0, status:"现役", privateValue:"hidden"
}));
assert.equal(validPlayers(sample), true);
assert.equal(sanitizeTeam("|roles=awp", "现役"), "无队伍");
assert.equal(sanitizeTeam("|status=Active", "现役"), "无队伍");
assert.equal(sanitizeTeam("|team2=", "现役"), "无队伍");
assert.equal(sanitizeTeam("???", "现役"), "无队伍");
assert.equal(sanitizeTeam("Vitality", "现役"), "Vitality");
assert.equal(sanitizePlayers([{team:"|csgo=y",status:"退役"}])[0].team, "退役");
assert.equal(validPlayers(sample.map((player,index)=>index?player:{...player,team:"|roles=awp"})), false);
const source = createPlayersScript(sample, "2026-07-24T00:00:00Z");
assert.match(source, /root\.DEFAULT_PLAYERS=/);
assert.doesNotMatch(source, /privateValue/);

console.log("server.test.mjs: all server rules passed");
