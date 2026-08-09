import assert from "node:assert/strict";
import { GameManager, evaluateGuess, GAME_CONSTANTS } from "../game-engine.mjs";

assert.equal(GAME_CONSTANTS.REMATCH_WINDOW_MS, 60_000);
assert.equal(GAME_CONSTANTS.MATCH_DURATION_MS, 2 * 60 * 1000);
assert.equal(GAME_CONSTANTS.ROUND_INTERMISSION_MS, 5_000);
assert.equal(GAME_CONSTANTS.ROOM_INACTIVITY_MS, 20 * 60 * 1000);
assert.deepEqual(GAME_CONSTANTS.PRIVATE_PLAYER_OPTIONS, [2, 3, 4]);
assert.deepEqual(GAME_CONSTANTS.QUESTION_MODES, ["full", "simple", "beginner"]);

const players = Array.from({ length:60 }, (_, index) => ({
  id:index === 0 ? "Answer" : `Player${index}`,
  team:index % 2 ? "A" : "B",
  country:index % 3 ? "France" : "Sweden",
  region:"Europe",
  age:18 + (index % 20),
  role:index % 4 ? "Rifler" : "AWPer",
  majorWins:index % 3,
  majorApps:index % 9,
  status:"active"
}));

function readyAndStart(manager, host, ...guests) {
  manager.setRoomReady(host.roomCode, host.playerToken, true);
  for (const guest of guests) manager.setRoomReady(host.roomCode, guest.playerToken, true);
  return manager.startPrivateRoom(host.roomCode, host.playerToken);
}

assert.equal(evaluateGuess(players[1], players[0]).nickname, "miss");
assert.equal(evaluateGuess(players[0], players[0]).nickname, "exact");

let now = 1_000;
const manager = new GameManager(players, { now:()=>now, random:()=>0 });
const single = manager.createSingle("Solo");
assert.equal(single.state.status, "playing");
const singleWon = manager.guessSingle(single.gameId, single.playerToken, "Answer");
assert.equal(singleWon.status, "won");
assert.deepEqual(singleWon.answer, players[0]);

const lobby = manager.createRoom("Host", "private", null, { maxPlayers:4, scoreToWin:2 });
assert.match(lobby.roomCode, /^\d{6}$/);
assert.equal(lobby.state.maxPlayers, 4);
assert.equal(lobby.state.scoreToWin, 2);
assert.equal(lobby.state.series, 3);
assert.equal(lobby.state.status, "waiting");
assert.equal(lobby.state.youIsHost, true);
assert.equal(lobby.state.canStart, false);
assert.throws(()=>manager.startPrivateRoom(lobby.roomCode, lobby.playerToken), /2/);
const guest1 = manager.joinRoom(lobby.roomCode, "Guest 1");
assert.equal(guest1.state.status, "waiting");
assert.throws(()=>manager.startPrivateRoom(lobby.roomCode, guest1.playerToken), /房主/);
manager.setRoomReady(lobby.roomCode, lobby.playerToken, true);
assert.equal(manager.getRoom(lobby.roomCode, lobby.playerToken).canStart, false);
manager.setRoomReady(lobby.roomCode, guest1.playerToken, true);
assert.equal(manager.getRoom(lobby.roomCode, lobby.playerToken).canStart, true);
const startedLobby = manager.startPrivateRoom(lobby.roomCode, lobby.playerToken);
assert.equal(startedLobby.status, "playing");
assert.equal(startedLobby.players.length, 2);

let customNow = 0;
const customDuration = new GameManager(players, { now:()=>customNow, random:()=>0 });
const customHost = customDuration.createRoom("Timer Host", "private", null, { scoreToWin:2, roundDurationSeconds:45 });
const customGuest = customDuration.joinRoom(customHost.roomCode, "Timer Guest");
let customState = readyAndStart(customDuration, customHost, customGuest);
assert.equal(customState.roundDurationSeconds, 45);
assert.equal(customState.timeLeftMs, 45_000);
customState = customDuration.guessRoom(customHost.roomCode, customHost.playerToken, "Answer");
assert.equal(customState.status, "round_settling");
customNow += GAME_CONSTANTS.ROUND_INTERMISSION_MS;
customState = customDuration.getRoom(customHost.roomCode, customGuest.playerToken);
assert.equal(customState.status, "playing");
assert.equal(customState.timeLeftMs, 45_000);
const invalidDuration = customDuration.createRoom("Default Timer", "private", null, { roundDurationSeconds:29 });
assert.equal(invalidDuration.state.roundDurationSeconds, 120);

let inactivityNow = 0;
const inactivity = new GameManager(players, { now:()=>inactivityNow, random:()=>0 });
const inactiveRoom = inactivity.createRoom("Inactive Host");
inactivityNow = GAME_CONSTANTS.ROOM_INACTIVITY_MS - 1;
inactivity.cleanup();
assert.equal(inactivity.rooms.has(inactiveRoom.roomCode), true);
inactivity.getRoom(inactiveRoom.roomCode, inactiveRoom.playerToken);
inactivityNow += GAME_CONSTANTS.ROOM_INACTIVITY_MS - 1;
inactivity.cleanup();
assert.equal(inactivity.rooms.has(inactiveRoom.roomCode), true);
inactivityNow += 1;
inactivity.cleanup();
assert.equal(inactivity.rooms.has(inactiveRoom.roomCode), false);
assert.throws(()=>inactivity.getRoom(inactiveRoom.roomCode, inactiveRoom.playerToken));

const capacity4 = manager.createRoom("Capacity Host", "private", null, { maxPlayers:4 });
manager.joinRoom(capacity4.roomCode, "P2");
manager.joinRoom(capacity4.roomCode, "P3");
manager.joinRoom(capacity4.roomCode, "P4");
assert.throws(()=>manager.joinRoom(capacity4.roomCode, "P5"), /房间已满/);
const capacity2 = manager.createRoom("Capacity Two", "private", null, { maxPlayers:2 });
manager.joinRoom(capacity2.roomCode, "P2");
assert.throws(()=>manager.joinRoom(capacity2.roomCode, "P3"), /房间已满/);

const kickLobby = manager.createRoom("Kick Host", "private", null, { maxPlayers:3, scoreToWin:2 });
const kickGuestA = manager.joinRoom(kickLobby.roomCode, "Kick Guest A");
const kickGuestB = manager.joinRoom(kickLobby.roomCode, "Kick Guest B");
assert.throws(()=>manager.kickRoomPlayer(kickLobby.roomCode, kickGuestA.playerToken, kickGuestB.playerId), error=>error.status===403);
assert.throws(()=>manager.kickRoomPlayer(kickLobby.roomCode, kickLobby.playerToken, kickLobby.playerId), error=>error.status===409);
const kickedWaitingState = manager.kickRoomPlayer(kickLobby.roomCode, kickLobby.playerToken, kickGuestA.playerId);
assert.equal(kickedWaitingState.players.length, 2);
assert.equal(kickedWaitingState.players.some(player=>player.id===kickGuestA.playerId), false);
assert.throws(()=>manager.getRoom(kickLobby.roomCode, kickGuestA.playerToken), error=>error.status===403&&/房主/.test(error.message));
const replacementGuest = manager.joinRoom(kickLobby.roomCode, "Replacement Guest");
assert.equal(replacementGuest.state.players.length, 3);

const liveKick = manager.createRoom("Live Kick Host", "private", null, { maxPlayers:3, scoreToWin:2 });
const liveKickGuestA = manager.joinRoom(liveKick.roomCode, "Live Kick A");
const liveKickGuestB = manager.joinRoom(liveKick.roomCode, "Live Kick B");
readyAndStart(manager, liveKick, liveKickGuestA, liveKickGuestB);
let liveKickState = manager.kickRoomPlayer(liveKick.roomCode, liveKick.playerToken, liveKickGuestA.playerId);
assert.equal(liveKickState.status, "playing");
assert.equal(liveKickState.players.length, 2);
liveKickState = manager.kickRoomPlayer(liveKick.roomCode, liveKick.playerToken, liveKickGuestB.playerId);
assert.equal(liveKickState.status, "settling");
assert.equal(liveKickState.winnerId, liveKick.playerId);
assert.equal(liveKickState.result, "player_kicked");
const scoreRoom = manager.createRoom("Scorer", "private", null, { maxPlayers:2, scoreToWin:2 });
const scoreGuest = manager.joinRoom(scoreRoom.roomCode, "Opponent");
readyAndStart(manager, scoreRoom, scoreGuest);
let scoreState = manager.guessRoom(scoreRoom.roomCode, scoreRoom.playerToken, "Answer");
assert.equal(scoreState.status, "round_settling");
assert.equal(scoreState.currentRound, 1);
assert.equal(scoreState.roundWins[scoreRoom.playerId], 1);
assert.equal(scoreState.roundIntermissionLeftMs, GAME_CONSTANTS.ROUND_INTERMISSION_MS);
assert.deepEqual(scoreState.answer, players[0]);
assert.equal(scoreState.players.find(player=>player.id===scoreRoom.playerId).guesses.length, 1);
assert.equal(scoreState.roundResults[0].answer.id, "Answer");
assert.equal(scoreState.roundResults[0].players.find(player=>player.id===scoreRoom.playerId).guesses[0].player.id, "Answer");
const opponentIntermission = manager.getRoom(scoreRoom.roomCode, scoreGuest.playerToken);
assert.deepEqual(opponentIntermission.answer, players[0]);
assert.equal(opponentIntermission.players.find(player=>player.id===scoreRoom.playerId).guesses[0].player.id, "Answer");
now += GAME_CONSTANTS.ROUND_INTERMISSION_MS;
scoreState = manager.getRoom(scoreRoom.roomCode, scoreRoom.playerToken);
assert.equal(scoreState.status, "playing");
assert.equal(scoreState.currentRound, 2);
assert.equal(scoreState.timeLeftMs, GAME_CONSTANTS.MATCH_DURATION_MS);
const roundTwoDeadline = scoreState.deadlineAt;
const opponentRoundTwo = manager.getRoom(scoreRoom.roomCode, scoreGuest.playerToken);
assert.equal(opponentRoundTwo.deadlineAt, roundTwoDeadline);
assert.equal(opponentRoundTwo.timeLeftMs, GAME_CONSTANTS.MATCH_DURATION_MS);
assert.equal(opponentRoundTwo.players.every(player=>player.guesses.length===0), true);
now += 30_000;
assert.equal(manager.getRoom(scoreRoom.roomCode, scoreRoom.playerToken).timeLeftMs, GAME_CONSTANTS.MATCH_DURATION_MS - 30_000);
assert.equal(manager.getRoom(scoreRoom.roomCode, scoreGuest.playerToken).timeLeftMs, GAME_CONSTANTS.MATCH_DURATION_MS - 30_000);
scoreState = manager.guessRoom(scoreRoom.roomCode, scoreRoom.playerToken, "Answer");
assert.equal(scoreState.status, "settling");
assert.equal(scoreState.winnerId, scoreRoom.playerId);
assert.equal(scoreState.answer, null);
assert.equal(scoreState.roundResults.length, 2);
assert.equal(scoreState.roundResults[0].answer.id, "Answer");
assert.equal(scoreState.roundResults[1].answer, null);
assert.equal(scoreState.roundResults[1].players, null);
now += GAME_CONSTANTS.SETTLEMENT_MS;
const scoreRevealed = manager.getRoom(scoreRoom.roomCode, scoreGuest.playerToken);
assert.equal(scoreRevealed.status, "finished");
assert.deepEqual(scoreRevealed.answer, players[0]);
assert.equal(scoreRevealed.roundResults.length, 2);
assert.equal(scoreRevealed.roundResults.every(round=>round.answer.id==="Answer"), true);
assert.equal(scoreRevealed.roundResults.every(round=>round.players.length===2), true);
assert.equal(scoreRevealed.roundResults[1].players.find(player=>player.id===scoreRoom.playerId).guesses[0].player.id, "Answer");

let multiNow = 0;
const multi = new GameManager(players, { now:()=>multiNow, random:()=>0 });
const multiHost = multi.createRoom("P1", "private", null, { maxPlayers:3, scoreToWin:2 });
const multiP2 = multi.joinRoom(multiHost.roomCode, "P2");
const multiP3 = multi.joinRoom(multiHost.roomCode, "P3");
const multiSpectator = multi.spectateRoom(multiHost.roomCode, "Caster");
readyAndStart(multi, multiHost, multiP2, multiP3);
assert.equal(multi.surrenderRoom(multiHost.roomCode, multiHost.playerToken).status, "playing");
const lastActive = multi.surrenderRoom(multiHost.roomCode, multiP2.playerToken);
assert.equal(lastActive.status, "round_settling");
assert.equal(lastActive.currentRound, 1);
assert.equal(lastActive.roundWins[multiP3.playerId], 1);
assert.deepEqual(lastActive.answer, players[0]);
const spectatorIntermission = multi.getRoom(multiHost.roomCode, multiSpectator.spectatorToken);
assert.equal(spectatorIntermission.status, "round_settling");
assert.deepEqual(spectatorIntermission.answer, players[0]);
multiNow += GAME_CONSTANTS.ROUND_INTERMISSION_MS;
const multiNextRound = multi.getRoom(multiHost.roomCode, multiP3.playerToken);
assert.equal(multiNextRound.status, "playing");
assert.equal(multiNextRound.currentRound, 2);
assert.equal(multiNextRound.timeLeftMs, GAME_CONSTANTS.MATCH_DURATION_MS);

let failedNow = 0;
const failed = new GameManager(players, { now:()=>failedNow, random:()=>0 });
const failedHost = failed.createRoom("Failed A", "private", null, { scoreToWin:2 });
const failedGuest = failed.joinRoom(failedHost.roomCode, "Failed B");
readyAndStart(failed, failedHost, failedGuest);
for (let index=1; index<=8; index+=1) failed.guessRoom(failedHost.roomCode, failedHost.playerToken, `Player${index}`);
let failedState;
for (let index=1; index<=8; index+=1) failedState = failed.guessRoom(failedHost.roomCode, failedGuest.playerToken, `Player${index}`);
assert.equal(failedState.status, "round_settling");
assert.equal(failedState.currentRound, 1);
assert.equal(failedState.roundResults[0].result, "all_failed");
assert.deepEqual(failedState.answer, players[0]);
failedNow += GAME_CONSTANTS.ROUND_INTERMISSION_MS;
const failedNextRound = failed.getRoom(failedHost.roomCode, failedGuest.playerToken);
assert.equal(failedNextRound.status, "playing");
assert.equal(failedNextRound.currentRound, 2);
assert.equal(failedNextRound.timeLeftMs, GAME_CONSTANTS.MATCH_DURATION_MS);

let timeoutNow = 0;
const timeout = new GameManager(players, { now:()=>timeoutNow, random:()=>0 });
const timeoutHost = timeout.createRoom("Timeout A", "private", null, { scoreToWin:2 });
const timeoutGuest = timeout.joinRoom(timeoutHost.roomCode, "Timeout B");
readyAndStart(timeout, timeoutHost, timeoutGuest);
timeoutNow = GAME_CONSTANTS.MATCH_DURATION_MS;
const timeoutIntermission = timeout.getRoom(timeoutHost.roomCode, timeoutGuest.playerToken);
assert.equal(timeoutIntermission.status, "round_settling");
assert.equal(timeoutIntermission.currentRound, 1);
assert.equal(timeoutIntermission.roundResults[0].result, "timeout");
assert.deepEqual(timeoutIntermission.answer, players[0]);
timeoutNow += GAME_CONSTANTS.ROUND_INTERMISSION_MS;
const nextAfterTimeout = timeout.getRoom(timeoutHost.roomCode, timeoutGuest.playerToken);
assert.equal(nextAfterTimeout.status, "playing");
assert.equal(nextAfterTimeout.currentRound, 2);
assert.equal(nextAfterTimeout.timeLeftMs, GAME_CONSTANTS.MATCH_DURATION_MS);
assert.equal(timeout.getRoom(timeoutHost.roomCode, timeoutHost.playerToken).deadlineAt, nextAfterTimeout.deadlineAt);

const visibility = new GameManager(players, { random:()=>0 });
const hiddenHost = visibility.createRoom("Hidden A", "private", null, { showOpponentGuesses:false });
const hiddenGuest = visibility.joinRoom(hiddenHost.roomCode, "Hidden B");
const waitingSpectator = visibility.spectateRoom(hiddenHost.roomCode, "Caster");
assert.equal(waitingSpectator.state.viewerType, "spectator");
assert.equal(waitingSpectator.state.canStart, false);
readyAndStart(visibility, hiddenHost, hiddenGuest);
visibility.guessRoom(hiddenHost.roomCode, hiddenHost.playerToken, "Player1");
const hiddenState = visibility.getRoom(hiddenHost.roomCode, hiddenGuest.playerToken);
assert.equal(hiddenState.players[0].guesses[0].player, null);

let rematchNow = 0;
const rematch = new GameManager(players, { now:()=>rematchNow, random:()=>0 });
const rematchHost = rematch.createRoom("Rematch A");
const rematchGuest = rematch.joinRoom(rematchHost.roomCode, "Rematch B");
readyAndStart(rematch, rematchHost, rematchGuest);
rematch.guessRoom(rematchHost.roomCode, rematchHost.playerToken, "Answer");
assert.equal(rematch.rematchRoom(rematchHost.roomCode, rematchHost.playerToken).rematchCount, 1);
const rematched = rematch.rematchRoom(rematchHost.roomCode, rematchGuest.playerToken);
assert.equal(rematched.status, "playing");
assert.equal(rematched.matchNumber, 2);

const matchmaking = new GameManager(players, { random:()=>0 });
const queued = matchmaking.matchmake("Queue A", 3);
assert.equal(queued.status, "waiting");
const matchedB = matchmaking.matchmake("Queue B", 3);
const matchedA = matchmaking.getTicket(queued.ticketId, queued.playerToken);
assert.equal(matchedB.status, "matched");
assert.match(matchedB.roomCode, /^\d{6}$/);
const matchState = matchmaking.getRoom(matchedA.roomCode, matchedA.playerToken);
assert.equal(matchState.status, "playing");
assert.equal(matchState.series, 3);
assert.equal(matchState.maxPlayers, 2);
assert.equal(matchState.roundDurationSeconds, 120);
assert.equal(matchState.roundDurationMs, GAME_CONSTANTS.MATCH_DURATION_MS);
matchmaking.guessRoom(matchState.roomCode, matchedB.playerToken, "Player1");
const hiddenMatch = matchmaking.getRoom(matchState.roomCode, matchedA.playerToken);
assert.equal(hiddenMatch.players.find(player=>player.id!==hiddenMatch.you).guesses[0].player, null);
const matchIntermission = matchmaking.guessRoom(matchState.roomCode, matchedB.playerToken, "Answer");
assert.equal(matchIntermission.status, "round_settling");
assert.deepEqual(matchIntermission.answer, players[0]);
assert.equal(matchIntermission.players.every(player=>player.guesses.every(row=>row.player)), true);

const queues = new GameManager(players, { random:()=>0 });
const forcedBo3Queue = queues.matchmake("Former BO1", 1, "full");
assert.equal(forcedBo3Queue.status, "waiting");
assert.equal(forcedBo3Queue.series, 3);
const forcedBo3Match = queues.matchmake("Former BO5", 5, "full");
assert.equal(forcedBo3Match.status, "matched");
assert.equal(forcedBo3Match.series, 3);
assert.equal(queues.matchmake("Simple", 1, "simple").series, 3);
assert.equal(queues.matchmake("Beginner", 5, "beginner").series, 3);

const simple = new GameManager(players, { random:()=>0 });
const simpleSingle = simple.createSingle("Simple", "simple");
assert.throws(()=>simple.guessSingle(simpleSingle.gameId, simpleSingle.playerToken, "Player9"), /Major/);
const simpleHost = simple.createRoom("Simple A", "private", null, { questionMode:"simple" });
const simpleGuest = simple.joinRoom(simpleHost.roomCode, "Simple B");
readyAndStart(simple, simpleHost, simpleGuest);
assert.throws(()=>simple.guessRoom(simpleHost.roomCode, simpleHost.playerToken, "Player9"), /Major/);

const beginner = new GameManager(players, { random:()=>0 });
const beginnerSingle = beginner.createSingle("Beginner", "beginner");
assert.equal(beginnerSingle.state.questionMode, "beginner");
assert.throws(()=>beginner.guessSingle(beginnerSingle.gameId, beginnerSingle.playerToken, "Player3"), /新手版/);
const beginnerReveal = beginner.revealSingle(beginnerSingle.gameId, beginnerSingle.playerToken);
assert.equal(beginnerReveal.answer.id, "Player1");
assert.equal(beginnerReveal.answer.majorWins, 1);
const beginnerHost = beginner.createRoom("Beginner A", "private", null, { questionMode:"beginner" });
const beginnerGuest = beginner.joinRoom(beginnerHost.roomCode, "Beginner B");
const beginnerStarted = readyAndStart(beginner, beginnerHost, beginnerGuest);
assert.equal(beginnerStarted.questionMode, "beginner");
assert.throws(()=>beginner.guessRoom(beginnerHost.roomCode, beginnerHost.playerToken, "Player3"), /新手版/);
const revealedSingle = manager.createSingle("Reveal Tester");
const revealedState = manager.revealSingle(revealedSingle.gameId, revealedSingle.playerToken);
assert.equal(revealedState.status, "lost");
assert.equal(revealedState.finishReason, "revealed");
assert.deepEqual(revealedState.answer, players[0]);
assert.throws(()=>manager.revealSingle(revealedSingle.gameId, revealedSingle.playerToken));

const leavingRoom = manager.createRoom("Leaving Host", "private", null, { maxPlayers:3, scoreToWin:2 });
const leavingGuest = manager.joinRoom(leavingRoom.roomCode, "Leaving Guest");
const stayingGuest = manager.joinRoom(leavingRoom.roomCode, "Staying Guest");
const leavingSpectator = manager.spectateRoom(leavingRoom.roomCode, "Leaving Caster");
assert.equal(manager.leaveRoom(leavingRoom.roomCode, leavingSpectator.spectatorToken).viewerType, "spectator");
assert.throws(()=>manager.getRoom(leavingRoom.roomCode, leavingSpectator.spectatorToken));
readyAndStart(manager, leavingRoom, leavingGuest, stayingGuest);
const playerLeaveResult = manager.leaveRoom(leavingRoom.roomCode, leavingGuest.playerToken);
assert.equal(playerLeaveResult.dissolved, false);
const roomAfterLeave = manager.getRoom(leavingRoom.roomCode, leavingRoom.playerToken);
assert.equal(roomAfterLeave.players.length, 2);
assert.equal(roomAfterLeave.players.some(player=>player.id===leavingGuest.playerId), false);
assert.throws(()=>manager.getRoom(leavingRoom.roomCode, leavingGuest.playerToken));
const dissolveResult = manager.leaveRoom(leavingRoom.roomCode, leavingRoom.playerToken);
assert.equal(dissolveResult.dissolved, true);
assert.equal(manager.rooms.has(leavingRoom.roomCode), false);

console.log("game.test.mjs: all game rules passed");
