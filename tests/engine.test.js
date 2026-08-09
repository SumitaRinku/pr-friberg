"use strict";

const assert = require("node:assert/strict");
const Engine = require("../js/engine.js");

function player(id, country, region, age, wins, apps, team, role, status) {
  return { id, country, region, age, majorWins:wins, majorApps:apps, team:team || "T", role:role || "步枪手", status:status || "现役" };
}

const guess = player("guess", "法国", "欧洲", 24, 1, 5, "Alpha", "步枪手", "现役");
const same = player("same", "法国", "欧洲", 24, 1, 5, "Alpha", "步枪手", "现役");
const nearby = player("near", "瑞典", "欧洲", 27, 2, 4, "Beta", "狙击手", "退役");
const far = player("far", "巴西", "南美洲", 31, 4, 9, "Gamma", "指挥", "现役");

assert.equal(Engine.feedbackForField(guess, same, "country"), "exact");
assert.equal(Engine.feedbackForField(guess, nearby, "country"), "close");
assert.equal(Engine.feedbackForField(guess, far, "country"), "miss");
assert.equal(Engine.feedbackForField(guess, nearby, "age"), "close-up");
assert.equal(Engine.feedbackForField(guess, far, "age"), "miss-up");
assert.equal(Engine.feedbackForField(guess, nearby, "majorWins"), "close-up");
assert.equal(Engine.feedbackForField(guess, far, "majorApps"), "miss-up");
assert.equal(Engine.feedbackForField(guess, nearby, "team"), "miss");

assert.equal(Engine.matchesField(nearby, guess, "country", "close"), true);
assert.equal(Engine.matchesField(far, guess, "country", "close"), false);
assert.equal(Engine.matchesField(nearby, guess, "age", "close-up"), true);
assert.equal(Engine.matchesField(far, guess, "age", "close-up"), false);
assert.equal(Engine.matchesField(far, guess, "age", "miss-up"), true);

const generatedFeedback = {};
Engine.FIELD_ORDER.forEach((field) => { generatedFeedback[field] = Engine.feedbackForField(guess, nearby, field); });
const candidates = Engine.filterCandidates([guess, nearby, far], [{ player:guess, source:"me", feedback:generatedFeedback }]);
assert.deepEqual(candidates.map((p) => p.id), ["near"]);

const ranked = Engine.rankGuesses([guess, nearby,far], [nearby,far], []);
assert.equal(ranked.length, 3);
assert.ok(ranked[0].entropy >= ranked[1].entropy);

console.log("engine.test.js: all rules passed");
