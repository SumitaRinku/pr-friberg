import crypto from "node:crypto";
import Engine from "./js/engine.js";

const MAX_GUESSES = 8;
const SETTLEMENT_MS = 5000;
const ROUND_INTERMISSION_MS = 5000;
const MATCH_DURATION_MS = 2 * 60 * 1000;
const MIN_ROUND_DURATION_SECONDS = 30;
const MAX_ROUND_DURATION_SECONDS = 600;
const REMATCH_WINDOW_MS = 60 * 1000;
const ROOM_TTL_MS = 6 * 60 * 60 * 1000;
const ROOM_INACTIVITY_MS = 20 * 60 * 1000;
const SINGLE_TTL_MS = 2 * 60 * 60 * 1000;
const SERIES_OPTIONS = [1, 3, 5];
const MATCHMAKING_SERIES = 3;
const PRIVATE_PLAYER_OPTIONS = [2, 3, 4];
const MIN_SCORE_TO_WIN = 1;
const MAX_SCORE_TO_WIN = 9;
const QUESTION_MODES = ["full", "simple", "beginner"];

function token(bytes = 24) { return crypto.randomBytes(bytes).toString("base64url"); }
function roomCode() {
  const alphabet = "0123456789";
  const bytes = crypto.randomBytes(6);
  return Array.from(bytes, byte => alphabet[byte % alphabet.length]).join("");
}
function cleanName(value) {
  const name = String(value || "玩家").trim().replace(/[<>]/g, "").slice(0, 18);
  return name || "玩家";
}
function normalizeSeries(value) {
  const parsed = Number(value);
  return SERIES_OPTIONS.includes(parsed) ? parsed : 1;
}
function normalizeMaxPlayers(value) {
  const parsed = Number(value);
  return PRIVATE_PLAYER_OPTIONS.includes(parsed) ? parsed : 2;
}
function normalizeScoreToWin(value, fallbackSeries = 1) {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= MIN_SCORE_TO_WIN && parsed <= MAX_SCORE_TO_WIN) return parsed;
  return Math.ceil(normalizeSeries(fallbackSeries) / 2);
}
function normalizeRoundDurationMs(value) { const seconds = Number(value); return Number.isInteger(seconds) && seconds >= MIN_ROUND_DURATION_SECONDS && seconds <= MAX_ROUND_DURATION_SECONDS ? seconds * 1000 : MATCH_DURATION_MS; }
function normalizeQuestionMode(value) { return QUESTION_MODES.includes(String(value)) ? String(value) : "full"; }
function isActivePlayer(player) { return player.status === "\u73b0\u5f79" || player.status === "active"; }
function isBeginnerEligible(player) { return Number(player.majorWins) >= 1 || (isActivePlayer(player) && Number(player.majorApps) >= 10); }
function isQuestionEligible(player, questionMode) {
  const mode = normalizeQuestionMode(questionMode);
  if (mode === "simple") return Number(player.majorApps) >= 1;
  if (mode === "beginner") return isBeginnerEligible(player);
  return true;
}
function questionModeError(questionMode) {
  return normalizeQuestionMode(questionMode) === "beginner"
    ? "\u65b0\u624b\u7248\u9898\u5e93\u53ea\u5305\u542b Major \u51a0\u519b\u6216\u53c2\u8d5b\u81f3\u5c11 10 \u6b21\u7684\u73b0\u5f79\u9009\u624b"
    : "\u7b80\u5355\u7248\u9898\u5e93\u53ea\u5305\u542b\u53c2\u52a0\u8fc7 Major \u7684\u9009\u624b";
}
function answerView(player) {
  return { id:player.id, team:player.team, country:player.country, region:player.region, age:player.age, role:player.role, majorWins:player.majorWins, majorApps:player.majorApps, status:player.status };
}

export function evaluateGuess(guess, target) {
  const feedback = { nickname:guess.id.toLowerCase() === target.id.toLowerCase() ? "exact" : "miss" };
  Engine.FIELD_ORDER.forEach(field => { feedback[field] = Engine.feedbackForField(guess, target, field); });
  return feedback;
}

export class GameManager {
  constructor(players, options = {}) {
    if (!Array.isArray(players) || !players.length) throw new Error("GameManager requires players");
    this.players = players;
    this.playerMap = new Map(players.map(player => [player.id.toLowerCase(), player]));
    this.singles = new Map();
    this.rooms = new Map();
    this.tickets = new Map();
    this.queue = [];
    this.now = options.now || (() => Date.now());
    this.random = options.random || Math.random;
  }

  setPlayers(players) {
    if (!Array.isArray(players) || players.length < 50) return false;
    this.players = players;
    this.playerMap = new Map(players.map(player => [player.id.toLowerCase(), player]));
    return true;
  }

  pickTarget(questionMode = "full") {
    const mode = normalizeQuestionMode(questionMode);
    const eligible = mode === "full"
      ? this.players.filter(isActivePlayer)
      : this.players.filter(player => isQuestionEligible(player, mode));
    const pool = mode === "full" && eligible.length < 30 ? this.players : eligible;
    return pool[Math.floor(this.random() * pool.length) % pool.length];
  }

  findPlayer(id) { return this.playerMap.get(String(id || "").trim().toLowerCase()) || null; }

  createSingle(playerName, questionMode = "full") {
    const id = token(15), accessToken = token(), mode = normalizeQuestionMode(questionMode);
    const game = { id, accessToken, playerName:cleanName(playerName), questionMode:mode, target:this.pickTarget(mode), guesses:[], status:"playing", finishReason:null, createdAt:this.now(), finishedAt:null };
    this.singles.set(id, game);
    return { gameId:id, playerToken:accessToken, state:this.singleState(game) };
  }

  requireSingle(id, accessToken) {
    const game = this.singles.get(id);
    if (!game || game.accessToken !== accessToken) throw Object.assign(new Error("对局不存在或凭证无效"), { status:404 });
    return game;
  }

  singleState(game) {
    return {
      mode:"single", status:game.status, playerName:game.playerName, questionMode:game.questionMode, maxGuesses:MAX_GUESSES,
      finishReason:game.finishReason,
      guesses:game.guesses, remaining:Math.max(0, MAX_GUESSES - game.guesses.length),
      answer:game.status === "playing" ? null : answerView(game.target)
    };
  }

  getSingle(id, accessToken) { return this.singleState(this.requireSingle(id, accessToken)); }

  guessSingle(id, accessToken, playerId) {
    const game = this.requireSingle(id, accessToken);
    if (game.status !== "playing") throw Object.assign(new Error("本局已经结束"), { status:409 });
    const guess = this.findPlayer(playerId);
    if (!guess) throw Object.assign(new Error("没有找到这名选手"), { status:400 });
    if (!isQuestionEligible(guess, game.questionMode)) throw Object.assign(new Error(questionModeError(game.questionMode)), { status:400 });
    if (game.guesses.some(row => row.player.id.toLowerCase() === guess.id.toLowerCase())) throw Object.assign(new Error("这名选手已经猜过"), { status:409 });
    const feedback = evaluateGuess(guess, game.target);
    game.guesses.push({ number:game.guesses.length + 1, player:answerView(guess), feedback, at:this.now() });
    if (feedback.nickname === "exact") {
      game.status = "won";
      game.finishReason = "guessed";
    } else if (game.guesses.length >= MAX_GUESSES) {
      game.status = "lost";
      game.finishReason = "attempts";
    }
    if (game.status !== "playing") game.finishedAt = this.now();
    return this.singleState(game);
  }

  revealSingle(id, accessToken) {
    const game = this.requireSingle(id, accessToken);
    if (game.status !== "playing") throw Object.assign(new Error("\u672c\u5c40\u5df2\u7ecf\u7ed3\u675f"), { status:409 });
    game.status = "lost";
    game.finishReason = "revealed";
    game.finishedAt = this.now();
    return this.singleState(game);
  }

  createRoom(playerName, kind = "private", provided = null, options = {}) {
    let code = provided || roomCode();
    while (this.rooms.has(code)) code = roomCode();
    const scoreToWin = kind === "private" ? normalizeScoreToWin(options.scoreToWin, options.series) : Math.ceil(MATCHMAKING_SERIES / 2);
    const series = kind === "private" ? scoreToWin * 2 - 1 : MATCHMAKING_SERIES;
    const maxPlayers = kind === "private" ? normalizeMaxPlayers(options.maxPlayers) : 2;
    const questionMode = normalizeQuestionMode(options.questionMode);
    const roundDurationMs = kind === "private" ? normalizeRoundDurationMs(options.roundDurationSeconds) : MATCH_DURATION_MS;
    const hasVisibilityChoice = Object.prototype.hasOwnProperty.call(options, "showOpponentGuesses");
    const opponentVisibility = kind === "matchmaking" ? "feedback" : hasVisibilityChoice ? (options.showOpponentGuesses ? "live" : "never") : "after";
    const room = {
      code, kind, series, questionMode, maxPlayers, scoreToWin, winsNeeded:scoreToWin, roundDurationMs, hostToken:null, opponentVisibility, showOpponentGuesses:opponentVisibility !== "never",
      target:this.pickTarget(questionMode), status:"waiting", players:[], spectators:[], kickedTokens:new Set(), winnerToken:null, result:null,
      createdAt:this.now(), lastActivityAt:this.now(), startedAt:null, deadlineAt:null, nextRoundAt:null, endedAt:null, revealAt:null, rematchUntil:null,
      rematchVotes:[], currentRound:1, roundWins:{}, roundResults:[], matchNumber:1
    };
    this.rooms.set(code, room);
    const participant = this.addParticipant(room, playerName);
    room.hostToken = participant.token;
    return { roomCode:code, playerToken:participant.token, playerId:participant.id, state:this.roomState(room, participant.token) };
  }

  startRoom(room, rematch = false) {
    room.status = "playing";
    if (rematch) room.matchNumber += 1;
    room.winnerToken = null; room.result = null; room.endedAt = null; room.revealAt = null; room.rematchUntil = null; room.nextRoundAt = null;
    room.startedAt = this.now();
    room.deadlineAt = room.startedAt + room.roundDurationMs;
    room.currentRound = 1;
    room.roundWins = Object.fromEntries(room.players.map(player => [player.id, 0]));
    room.roundResults = [];
    room.rematchVotes = [];
    room.target = this.pickTarget(room.questionMode);
    room.players.forEach(player => { player.guesses = []; player.failed = false; player.surrendered = false; player.ready = true; });
  }

  resetRound(room) {
    room.status = "playing";
    room.nextRoundAt = null;
    room.currentRound += 1;
    room.deadlineAt = this.now() + room.roundDurationMs;
    room.target = this.pickTarget(room.questionMode);
    room.players.forEach(player => {
      player.guesses = [];
      player.failed = Boolean(player.left);
      player.surrendered = Boolean(player.left);
      player.ready = !player.left;
    });
  }

  addParticipant(room, playerName, providedToken = null) {
    if (room.players.length >= room.maxPlayers) throw Object.assign(new Error("房间已满"), { status:409 });
    const participant = { id:token(8), token:providedToken || token(), name:cleanName(playerName), guesses:[], failed:false, surrendered:false, ready:room.kind === "matchmaking", joinedAt:this.now() };
    room.players.push(participant);
    return participant;
  }

  addSpectator(room, spectatorName) {
    const spectator = { id:token(8), token:token(), name:cleanName(spectatorName || "观众"), joinedAt:this.now() };
    room.spectators.push(spectator);
    return spectator;
  }

  joinRoom(code, playerName) {
    const room = this.rooms.get(String(code || "").trim().toUpperCase());
    if (!room) throw Object.assign(new Error("房间不存在"), { status:404 });
    if (room.status !== "waiting") throw Object.assign(new Error("房间已经开始或结束"), { status:409 });
    const participant = this.addParticipant(room, playerName);
    return { roomCode:room.code, playerToken:participant.token, playerId:participant.id, state:this.roomState(room, participant.token) };
  }

  setRoomReady(code, accessToken, ready = true) {
    const { room, participant } = this.requireRoom(code, accessToken);
    if (room.kind !== "private" || room.status !== "waiting") throw Object.assign(new Error("只能在未开始的私人房间中准备"), { status:409 });
    participant.ready = Boolean(ready);
    return this.roomState(room, accessToken);
  }

  startPrivateRoom(code, accessToken) {
    const { room } = this.requireRoom(code, accessToken);
    if (room.kind !== "private" || room.status !== "waiting") throw Object.assign(new Error("房间不在等待开始状态"), { status:409 });
    if (room.hostToken !== accessToken) throw Object.assign(new Error("只有房主可以开始游戏"), { status:403 });
    if (room.players.length < 2) throw Object.assign(new Error("至少需要 2 名玩家"), { status:409 });
    if (!room.players.every(player => player.ready)) throw Object.assign(new Error("请等待所有玩家准备"), { status:409 });
    this.startRoom(room);
    return this.roomState(room, accessToken);
  }

  matchmake(playerName, series = 1, questionMode = "full") {
    this.cleanQueue();
    const requestedSeries = MATCHMAKING_SERIES;
    const requestedQuestionMode = normalizeQuestionMode(questionMode);
    const waitingIndex = this.queue.findIndex(id => this.tickets.get(id)?.status === "waiting" && this.tickets.get(id)?.series === requestedSeries && this.tickets.get(id)?.questionMode === requestedQuestionMode);
    if (waitingIndex >= 0) {
      const waitingId = this.queue.splice(waitingIndex, 1)[0];
      const waiting = this.tickets.get(waitingId);
      const created = this.createRoom(waiting.playerName, "matchmaking", null, { series:requestedSeries, questionMode:requestedQuestionMode, showOpponentGuesses:false });
      const room = this.rooms.get(created.roomCode);
      room.players[0].token = waiting.playerToken;
      waiting.status = "matched"; waiting.roomCode = room.code; waiting.playerId = room.players[0].id;
      const second = this.addParticipant(room, playerName);
      this.startRoom(room);
      const ticket = { id:token(12), playerName:second.name, playerToken:second.token, playerId:second.id, status:"matched", roomCode:room.code, series:requestedSeries, questionMode:requestedQuestionMode, createdAt:this.now() };
      this.tickets.set(ticket.id, ticket);
      return this.ticketView(ticket);
    }
    const ticket = { id:token(12), playerName:cleanName(playerName), playerToken:token(), playerId:null, status:"waiting", roomCode:null, series:requestedSeries, questionMode:requestedQuestionMode, createdAt:this.now() };
    this.tickets.set(ticket.id, ticket); this.queue.push(ticket.id);
    return this.ticketView(ticket);
  }

  ticketView(ticket) {
    return { ticketId:ticket.id, playerToken:ticket.playerToken, playerId:ticket.playerId, status:ticket.status, roomCode:ticket.roomCode, series:ticket.series, questionMode:ticket.questionMode };
  }

  getTicket(id, accessToken) {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.playerToken !== accessToken) throw Object.assign(new Error("匹配凭证无效"), { status:404 });
    return this.ticketView(ticket);
  }

  cancelTicket(id, accessToken) {
    const ticket = this.tickets.get(id);
    if (!ticket || ticket.playerToken !== accessToken) throw Object.assign(new Error("匹配凭证无效"), { status:404 });
    if (ticket.status === "waiting") ticket.status = "cancelled";
    return this.ticketView(ticket);
  }

  requireRoom(code, accessToken) {
    const room = this.rooms.get(String(code || "").trim().toUpperCase());
    if (room?.kickedTokens?.has(accessToken)) throw Object.assign(new Error("\u4f60\u5df2\u88ab\u623f\u4e3b\u79fb\u51fa\u623f\u95f4"), { status:403 });
    const participant = room?.players.find(player => player.token === accessToken && !player.left);
    if (!room || !participant) throw Object.assign(new Error("房间不存在或凭证无效"), { status:404 });
    return { room, participant };
  }

  requireRoomViewer(code, accessToken) {
    const room = this.rooms.get(String(code || "").trim().toUpperCase());
    if (room?.kickedTokens?.has(accessToken)) throw Object.assign(new Error("\u4f60\u5df2\u88ab\u623f\u4e3b\u79fb\u51fa\u623f\u95f4"), { status:403 });
    const participant = room?.players.find(player => player.token === accessToken && !player.left);
    const spectator = room?.spectators.find(viewer => viewer.token === accessToken);
    if (!room || (!participant && !spectator)) throw Object.assign(new Error("房间不存在或凭证无效"), { status:404 });
    return { room, participant, spectator };
  }

  expireRoom(room) {
    if (room.status === "playing" && room.deadlineAt && this.now() >= room.deadlineAt) this.finishRound(room, null, "timeout");
    if (room.status === "round_settling" && room.nextRoundAt && this.now() >= room.nextRoundAt) this.resetRound(room);
  }

  finishRoom(room, winnerToken, result) {
    if (room.status !== "playing") return;
    room.status = "settling"; room.winnerToken = winnerToken; room.result = result;
    room.nextRoundAt = null;
    room.endedAt = this.now(); room.revealAt = room.endedAt + SETTLEMENT_MS; room.rematchUntil = room.endedAt + REMATCH_WINDOW_MS; room.rematchVotes = [];
  }

  finishRound(room, winnerToken, result) {
    const winner = winnerToken ? room.players.find(player => player.token === winnerToken) : null;
    if (winner) room.roundWins[winner.id] = (room.roundWins[winner.id] || 0) + 1;
    room.roundResults.push({
      round:room.currentRound,
      winnerId:winner?.id || null,
      result,
      answer:answerView(room.target),
      scores:{ ...room.roundWins },
      players:room.players.map(player => ({
        id:player.id,
        name:player.name,
        guesses:player.guesses.map(row => ({ ...row, player:{ ...row.player }, feedback:{ ...row.feedback } }))
      }))
    });
    if (!winner && room.series === 1) {
      this.finishRoom(room, null, result);
      return;
    }
    if (winner && room.roundWins[winner.id] >= room.winsNeeded) {
      this.finishRoom(room, winnerToken, room.series === 1 ? result : "series_won");
      return;
    }
    room.status = "round_settling";
    room.deadlineAt = null;
    room.nextRoundAt = this.now() + ROUND_INTERMISSION_MS;
  }

  guessRoom(code, accessToken, playerId) {
    const { room, participant } = this.requireRoom(code, accessToken);
    this.expireRoom(room);
    if (room.status !== "playing") throw Object.assign(new Error("本局尚未开始或已经结束"), { status:409 });
    if (participant.failed || participant.surrendered) throw Object.assign(new Error("你本轮已经结束"), { status:409 });
    const guess = this.findPlayer(playerId);
    if (!guess) throw Object.assign(new Error("没有找到这名选手"), { status:400 });
    if (!isQuestionEligible(guess, room.questionMode)) throw Object.assign(new Error(questionModeError(room.questionMode)), { status:400 });
    if (participant.guesses.some(row => row.player.id.toLowerCase() === guess.id.toLowerCase())) throw Object.assign(new Error("这名选手已经猜过"), { status:409 });
    const feedback = evaluateGuess(guess, room.target);
    participant.guesses.push({ number:participant.guesses.length + 1, player:answerView(guess), feedback, at:this.now() });
    if (feedback.nickname === "exact") this.finishRound(room, participant.token, "guessed");
    else if (participant.guesses.length >= MAX_GUESSES) {
      participant.failed = true;
      // 与投降、退出保持同一语义：只剩一名可作答玩家时该玩家立即赢下本局，
      // 全部耗尽则本局平局，不再拖到超时判平。
      const active = room.players.filter(player => !player.left && !player.failed && !player.surrendered);
      if (active.length === 1) this.finishRound(room, active[0].token, "last_active");
      else if (active.length === 0) this.finishRound(room, null, "all_failed");
    }
    return this.roomState(room, accessToken);
  }

  surrenderRoom(code, accessToken) {
    const { room, participant } = this.requireRoom(code, accessToken);
    this.expireRoom(room);
    if (room.status !== "playing") throw Object.assign(new Error("本局尚未开始或已经结束"), { status:409 });
    participant.surrendered = true;
    const active = room.players.filter(player => !player.left && !player.failed && !player.surrendered);
    if (active.length === 1) this.finishRound(room, active[0].token, "last_active");
    else if (active.length === 0) this.finishRound(room, null, "all_surrendered");
    return this.roomState(room, accessToken);
  }

  spectateRoom(code, spectatorName) {
    const room = this.rooms.get(String(code || "").trim().toUpperCase());
    if (!room) throw Object.assign(new Error("房间不存在"), { status:404 });
    const spectator = this.addSpectator(room, spectatorName);
    return { roomCode:room.code, spectatorToken:spectator.token, spectatorId:spectator.id, state:this.roomState(room, spectator.token) };
  }
  leaveRoom(code, accessToken) {
    const room = this.rooms.get(String(code || "").trim().toUpperCase());
    const participant = room?.players.find(player => player.token === accessToken);
    const spectator = room?.spectators.find(viewer => viewer.token === accessToken);
    if (!room || (!participant && !spectator)) throw Object.assign(new Error("\u623f\u95f4\u4e0d\u5b58\u5728\u6216\u51ed\u8bc1\u65e0\u6548"), { status:404 });
    if (spectator) {
      room.spectators = room.spectators.filter(viewer => viewer !== spectator);
      room.lastActivityAt = this.now();
      return { roomCode:room.code, dissolved:false, left:true, viewerType:"spectator" };
    }
    if (room.kind === "private" && room.hostToken === accessToken) {
      this.rooms.delete(room.code);
      return { roomCode:room.code, dissolved:true, left:true, viewerType:"player" };
    }
    if (room.status === "waiting") {
      room.players = room.players.filter(player => player !== participant);
    } else {
      if (room.status === "playing" && !participant.failed && !participant.surrendered) {
        participant.surrendered = true;
        const active = room.players.filter(player => !player.left && !player.failed && !player.surrendered);
        if (active.length === 1) this.finishRoom(room, active[0].token, "opponent_left");
        else if (active.length === 0) this.finishRoom(room, null, "all_left");
      }
      participant.left = true;
      participant.ready = false;
    }
    room.lastActivityAt = this.now();
    return { roomCode:room.code, dissolved:false, left:true, viewerType:"player" };
  }


  kickRoomPlayer(code, accessToken, playerId) {
    const { room } = this.requireRoom(code, accessToken);
    if (room.kind !== "private") throw Object.assign(new Error("\u968f\u673a\u5339\u914d\u4e0d\u652f\u6301\u79fb\u51fa\u73a9\u5bb6"), { status:409 });
    if (room.hostToken !== accessToken) throw Object.assign(new Error("\u53ea\u6709\u623f\u4e3b\u53ef\u4ee5\u79fb\u51fa\u73a9\u5bb6"), { status:403 });
    if (!["waiting", "playing"].includes(room.status)) throw Object.assign(new Error("\u5f53\u524d\u9636\u6bb5\u4e0d\u80fd\u79fb\u51fa\u73a9\u5bb6"), { status:409 });
    const target = room.players.find(player => player.id === String(playerId || "") && !player.left);
    if (!target) throw Object.assign(new Error("\u73a9\u5bb6\u4e0d\u5728\u5f53\u524d\u623f\u95f4"), { status:404 });
    if (target.token === accessToken) throw Object.assign(new Error("\u623f\u4e3b\u4e0d\u80fd\u79fb\u51fa\u81ea\u5df1"), { status:409 });
    room.kickedTokens.add(target.token);
    room.players = room.players.filter(player => player !== target);
    room.rematchVotes = room.rematchVotes.filter(tokenValue => tokenValue !== target.token);
    room.lastActivityAt = this.now();
    if (room.status === "playing" && room.players.length === 1) this.finishRoom(room, room.players[0].token, "player_kicked");
    return this.roomState(room, accessToken);
  }
  rematchRoom(code, accessToken) {
    const { room, participant } = this.requireRoom(code, accessToken);
    const now = this.now();
    if (!["settling", "finished"].includes(room.status) || !room.rematchUntil || now > room.rematchUntil) throw Object.assign(new Error("再战窗口已结束"), { status:409 });
    if (!room.rematchVotes.includes(participant.token)) room.rematchVotes.push(participant.token);
    const activePlayers = room.players.filter(player => !player.left);
    if (activePlayers.length >= 2 && activePlayers.every(player => room.rematchVotes.includes(player.token))) this.startRoom(room, true);
    return this.roomState(room, accessToken);
  }

  roomState(room, accessToken) {
    this.expireRoom(room);
    const now = this.now();
    room.lastActivityAt = now;
    const revealed = Boolean(room.revealAt && now >= room.revealAt);
    const status = room.status === "settling" && revealed ? "finished" : room.status;
    const activePlayers = room.players.filter(player => !player.left);
    const viewer = activePlayers.find(player => player.token === accessToken);
    const spectator = room.spectators.find(item => item.token === accessToken);
    const viewerIsParticipant = Boolean(viewer);
    const roundSettling = room.status === "round_settling";
    const revealOpponent = roundSettling || room.opponentVisibility === "live" || (room.opponentVisibility === "after" && revealed);
    return {
      mode:room.kind, roomCode:room.code, status, maxGuesses:MAX_GUESSES,
      series:room.series, questionMode:room.questionMode, maxPlayers:room.maxPlayers, scoreToWin:room.scoreToWin, winsNeeded:room.winsNeeded, roundDurationMs:room.roundDurationMs, roundDurationSeconds:room.roundDurationMs / 1000, currentRound:room.currentRound, matchNumber:room.matchNumber,
      roundWins:room.roundWins,
      roundResults:room.roundResults.map(round => {
        const detailsVisible = revealed || roundSettling || round.round < room.currentRound;
        return {
          round:round.round,
          winnerId:round.winnerId,
          result:round.result,
          scores:round.scores,
          answer:detailsVisible ? round.answer : null,
          players:detailsVisible ? round.players : null
        };
      }),
      showOpponentGuesses:room.showOpponentGuesses, opponentVisibility:room.opponentVisibility,
      startedAt:room.startedAt, deadlineAt:room.deadlineAt, timeLeftMs:room.deadlineAt ? Math.max(0, room.deadlineAt - now) : null,
      nextRoundAt:room.nextRoundAt, roundIntermissionLeftMs:room.nextRoundAt ? Math.max(0, room.nextRoundAt - now) : null,
      result:room.result, revealAt:room.revealAt, rematchUntil:room.rematchUntil, rematchCount:room.rematchVotes.length,
      canRematch:viewerIsParticipant && activePlayers.length >= 2 && ["settling", "finished"].includes(status) && Boolean(room.rematchUntil && now <= room.rematchUntil),
      rematchVoted:viewerIsParticipant && room.rematchVotes.includes(accessToken), revealed,
      youIsHost:viewerIsParticipant && room.hostToken === accessToken,
      canStart:viewerIsParticipant && room.kind === "private" && room.hostToken === accessToken && status === "waiting" && activePlayers.length >= 2 && activePlayers.every(player => player.ready),
      winnerId:room.winnerToken ? activePlayers.find(player => player.token === room.winnerToken)?.id || null : null,
      you:viewer?.id || null, viewerType:viewer ? "player" : spectator ? "spectator" : null,
      spectators:room.spectators.map(item => ({ id:item.id, name:item.name })),
      players:activePlayers.map(player => ({
        id:player.id, name:player.name, ready:Boolean(player.ready), isHost:player.token === room.hostToken, failed:player.failed, surrendered:player.surrendered,
        remaining:Math.max(0, MAX_GUESSES - player.guesses.length),
        guesses:player.guesses.map(row => ({ ...row, player:player.token === accessToken || revealOpponent ? row.player : null }))
      })),
      answer:roundSettling || revealed ? answerView(room.target) : null
    };
  }

  getRoom(code, accessToken) {
    const { room } = this.requireRoomViewer(code, accessToken);
    return this.roomState(room, accessToken);
  }

  cleanQueue() {
    const cutoff = this.now() - 5 * 60 * 1000;
    this.queue = this.queue.filter(id => { const ticket=this.tickets.get(id); return ticket && ticket.status === "waiting" && ticket.createdAt > cutoff; });
  }

  cleanup() {
    const now = this.now();
    for (const [id, game] of this.singles) if (now - (game.finishedAt || game.createdAt) > SINGLE_TTL_MS) this.singles.delete(id);
    for (const [code, room] of this.rooms) if (now - (room.lastActivityAt ?? room.createdAt) >= ROOM_INACTIVITY_MS) this.rooms.delete(code);
    for (const [id, ticket] of this.tickets) if (now - ticket.createdAt > ROOM_TTL_MS) this.tickets.delete(id);
    this.cleanQueue();
  }
}

export const GAME_CONSTANTS = { MAX_GUESSES, SETTLEMENT_MS, ROUND_INTERMISSION_MS, MATCH_DURATION_MS, MATCHMAKING_SERIES, MIN_ROUND_DURATION_SECONDS, MAX_ROUND_DURATION_SECONDS, REMATCH_WINDOW_MS, ROOM_INACTIVITY_MS, SERIES_OPTIONS, PRIVATE_PLAYER_OPTIONS, MIN_SCORE_TO_WIN, MAX_SCORE_TO_WIN, QUESTION_MODES };












