(function (root) {
  "use strict";

  const FIELD_META = {
    team: { label:"队伍", kind:"binary" },
    country: { label:"国家", kind:"region" },
    age: { label:"年龄", kind:"number", threshold:3 },
    role: { label:"位置", kind:"binary" },
    majorWins: { label:"冠军", kind:"number", threshold:1 },
    majorApps: { label:"参赛", kind:"number", threshold:1 },
    status: { label:"状态", kind:"binary" }
  };

  const FIELD_ORDER = Object.keys(FIELD_META);

  function feedbackForField(guess, target, field) {
    const meta = FIELD_META[field];
    const guessed = guess[field];
    const actual = target[field];
    if (guessed === actual) return "exact";
    if (meta.kind === "binary") return "miss";
    if (meta.kind === "region") return guess.region === target.region ? "close" : "miss";
    const direction = actual > guessed ? "up" : "down";
    const distance = Math.abs(actual - guessed);
    return (distance <= meta.threshold ? "close-" : "miss-") + direction;
  }

  function feedbackSignature(guess, target) {
    const values = [guess.id === target.id ? "exact" : "miss"];
    FIELD_ORDER.forEach(function (field) { values.push(feedbackForField(guess, target, field)); });
    return values.join("|");
  }

  function matchesField(candidate, guess, field, state) {
    if (!state || state === "unset") return true;
    const meta = FIELD_META[field];
    const guessed = guess[field];
    const actual = candidate[field];
    if (state === "exact") return actual === guessed;
    if (meta.kind === "binary") return state === "miss" && actual !== guessed;
    if (meta.kind === "region") {
      if (state === "close") return actual !== guessed && candidate.region === guess.region;
      return state === "miss" && candidate.region !== guess.region;
    }
    const diff = actual - guessed;
    const distance = Math.abs(diff);
    if (state === "close-up") return diff > 0 && distance <= meta.threshold;
    if (state === "close-down") return diff < 0 && distance <= meta.threshold;
    if (state === "miss-up") return diff > 0 && distance > meta.threshold;
    if (state === "miss-down") return diff < 0 && distance > meta.threshold;
    return false;
  }

  function matchesGuess(candidate, entry) {
    // 录入一行意味着该昵称没有猜中，所以答案不能仍是这名选手。
    if (candidate.id.toLowerCase() === entry.player.id.toLowerCase()) return false;
    return FIELD_ORDER.every(function (field) {
      return matchesField(candidate, entry.player, field, entry.feedback[field]);
    });
  }

  function filterCandidates(players, history) {
    return players.filter(function (candidate) {
      return history.every(function (entry) { return matchesGuess(candidate, entry); });
    });
  }

  function entropyForGuess(guess, candidates) {
    if (!candidates.length) return 0;
    const buckets = new Map();
    candidates.forEach(function (target) {
      const key = feedbackSignature(guess, target);
      buckets.set(key, (buckets.get(key) || 0) + 1);
    });
    let entropy = 0;
    buckets.forEach(function (count) {
      const probability = count / candidates.length;
      entropy -= probability * Math.log2(probability);
    });
    return entropy;
  }

  function rankGuesses(players, candidates, history) {
    const used = new Set(history.map(function (entry) { return entry.player.id.toLowerCase(); }));
    const maxEntropy = candidates.length > 1 ? Math.log2(candidates.length) : 1;
    return players
      .filter(function (player) { return !used.has(player.id.toLowerCase()); })
      .map(function (player) {
        const entropy = entropyForGuess(player, candidates);
        return {
          player: player,
          entropy: entropy,
          score: Math.round(Math.min(1, entropy / maxEntropy) * 100),
          possible: candidates.indexOf(player) !== -1
        };
      })
      .sort(function (a, b) {
        return b.entropy - a.entropy || Number(b.possible) - Number(a.possible) || a.player.id.localeCompare(b.player.id);
      });
  }

  function allowedStates(field) {
    const kind = FIELD_META[field].kind;
    if (kind === "binary") return ["exact", "miss"];
    if (kind === "region") return ["exact", "close", "miss"];
    return ["exact", "close-up", "close-down", "miss-up", "miss-down"];
  }

  const api = { FIELD_META, FIELD_ORDER, feedbackForField, feedbackSignature, matchesField, matchesGuess, filterCandidates, entropyForGuess, rankGuesses, allowedStates };
  root.CS2Engine = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
