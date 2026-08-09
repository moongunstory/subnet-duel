const test = require("node:test");
const assert = require("node:assert/strict");
const {
  saveSoloRecord,
  getSoloLeaderboard,
  updateDuelResult,
  getDuelLeaderboard
} = require("../src/db");

test("saves solo speedrun record and fetches leaderboard sorted by accuracy and time", async () => {
  await saveSoloRecord({
    nickname: "Alice",
    difficulty: "easy",
    accuracy: 90,
    elapsedMs: 25000,
    score: 1200,
    correct: 9,
    total: 10
  });

  await saveSoloRecord({
    nickname: "Bob",
    difficulty: "easy",
    accuracy: 100,
    elapsedMs: 30000,
    score: 1500,
    correct: 10,
    total: 10
  });

  await saveSoloRecord({
    nickname: "Charlie",
    difficulty: "easy",
    accuracy: 100,
    elapsedMs: 20000,
    score: 1600,
    correct: 10,
    total: 10
  });

  const list = await getSoloLeaderboard("easy");
  assert.equal(list.length, 3);
  // Charlie should be #1 (100% accuracy, 20s), Bob #2 (100% accuracy, 30s), Alice #3 (90% accuracy)
  assert.equal(list[0].nickname, "Charlie");
  assert.equal(list[1].nickname, "Bob");
  assert.equal(list[2].nickname, "Alice");
});

test("updates 1v1 duel ELO rating and calculates rank", async () => {
  await updateDuelResult("Player1", "Player2", false, "Player1");

  const list = await getDuelLeaderboard();
  assert.equal(list.length, 2);
  assert.equal(list[0].nickname, "Player1");
  assert.ok(list[0].elo > 1000);
  assert.equal(list[1].nickname, "Player2");
  assert.ok(list[1].elo < 1000);
});
