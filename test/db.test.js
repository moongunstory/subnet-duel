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

test("updates solo record when user gets higher score with same accuracy even if time is slightly longer", async () => {
  await saveSoloRecord({
    nickname: "David",
    difficulty: "medium",
    accuracy: 100,
    elapsedMs: 20000,
    score: 1000,
    correct: 10,
    total: 10
  });

  // David gets a higher score (1500 vs 1000) but took 22s (slightly longer)
  const isNewBest = await saveSoloRecord({
    nickname: "David",
    difficulty: "medium",
    accuracy: 100,
    elapsedMs: 22000,
    score: 1500,
    correct: 10,
    total: 10
  });

  assert.equal(isNewBest, true);

  const list = await getSoloLeaderboard("medium");
  assert.equal(list.length, 1);
  assert.equal(list[0].nickname, "David");
  assert.equal(list[0].score, 1500);
});

test("saves and fetches solo record for custom difficulty", async () => {
  await saveSoloRecord({
    nickname: "Eve",
    difficulty: "custom",
    accuracy: 100,
    elapsedMs: 15000,
    score: 1800,
    correct: 10,
    total: 10
  });

  const list = await getSoloLeaderboard("custom");
  assert.equal(list.length, 1);
  assert.equal(list[0].nickname, "Eve");
  assert.equal(list[0].score, 1800);
});

test("saves record even if accuracy is 0% and score is 0 when user has no existing record", async () => {
  const isSaved = await saveSoloRecord({
    nickname: "ZeroUser",
    difficulty: "easy",
    accuracy: 0,
    elapsedMs: 60000,
    score: 0,
    correct: 0,
    total: 10
  });

  assert.equal(isSaved, true);

  const list = await getSoloLeaderboard("easy");
  const found = list.find(r => r.nickname === "ZeroUser");
  assert.ok(found);
  assert.equal(found.accuracy, 0);
  assert.equal(found.score, 0);
});

test("fetches all solo records across difficulties when using 'all'", async () => {
  const list = await getSoloLeaderboard("all");
  assert.ok(list.length >= 4);
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
