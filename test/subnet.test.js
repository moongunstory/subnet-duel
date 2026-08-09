const test = require("node:test");
const assert = require("node:assert/strict");
const {
  checkAnswer,
  cidrToMask,
  normalizeAnswer,
  scoreQuestion,
  subnetInfo
} = require("../src/subnet");

test("calculates /21 subnet values like the reference example", () => {
  const info = subnetInfo("172.28.216.107", 21);
  assert.equal(cidrToMask(21), "255.255.248.0");
  assert.equal(info.totalAddresses, 2048);
  assert.equal(info.usableHostCount, 2045);
  assert.equal(info.networkId, "172.28.216.0");
  assert.equal(info.broadcast, "172.28.223.255");
  assert.equal(info.gateway, "172.28.223.254");
  assert.equal(info.usableRange, "172.28.216.1 ~ 172.28.223.253");
  assert.equal(info.groupCount, 32);
  assert.equal(info.groupNumber, 27);
});

test("normalizes direct input answers", () => {
  assert.equal(normalizeAnswer("255.255.248.0", "mask", 21), "255.255.248.0");
  assert.equal(normalizeAnswer("/21", "mask", 21), "");
  assert.equal(normalizeAnswer("172.28.216.0 - 172.28.223.255", "range", 21), "172.28.216.0 ~ 172.28.223.255");
  assert.equal(normalizeAnswer("2,048개", "number", 21), "2048");
});

test("checks answers by question type", () => {
  assert.equal(checkAnswer({ type: "mask", answer: "255.255.248.0", cidr: 21 }, "/21"), false);
  assert.equal(checkAnswer({ type: "mask", answer: "255.255.248.0", cidr: 21 }, "255.255.248.0"), true);
  assert.equal(checkAnswer({ type: "ip", answer: "172.28.216.0", cidr: 21 }, "172.28.216.0"), true);
  assert.equal(checkAnswer({ type: "range", answer: "172.28.216.0 ~ 172.28.223.255", cidr: 21 }, "172.28.216.0-172.28.223.255"), true);
  assert.equal(checkAnswer({ type: "number", answer: "32", cidr: 21 }, "33"), false);
});

test("awards no score for wrong answers and a speed bonus for fast correct answers", () => {
  const question = { points: 100 };
  assert.equal(scoreQuestion(question, false, 1000), 0);
  assert.equal(scoreQuestion(question, true, 0), 120);
  assert.equal(scoreQuestion(question, true, 45_000), 100);
});
