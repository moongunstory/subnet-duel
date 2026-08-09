const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

const isConfigured = Boolean(url && token);

// In-Memory Fallback Storage
const memoryStore = {
  soloZsets: new Map(), // difficulty -> Map(nickname -> score)
  soloRecords: new Map(), // `${difficulty}:${nickname}` -> record object
  duelZset: new Map(), // nickname -> elo
  userStats: new Map() // nickname -> stats object
};

async function redisCommand(commandArray) {
  if (!isConfigured) return null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(commandArray)
    });
    if (!res.ok) {
      console.error("[Redis Error]", res.status, res.statusText);
      return null;
    }
    const data = await res.json();
    return data.result;
  } catch (err) {
    console.error("[Redis Fetch Error]", err.message);
    return null;
  }
}

async function redisPipeline(commandsArray) {
  if (!isConfigured) return null;
  try {
    const res = await fetch(`${url}/pipeline`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(commandsArray)
    });
    if (!res.ok) {
      console.error("[Redis Pipeline Error]", res.status, res.statusText);
      return null;
    }
    const data = await res.json();
    return data.map((item) => item.result);
  } catch (err) {
    console.error("[Redis Pipeline Fetch Error]", err.message);
    return null;
  }
}

// -------------------------------------------------------------
// Solo Speedrun Ranking Logic
// -------------------------------------------------------------

function calculateSoloZScore(accuracy, elapsedMs, score) {
  const normAccuracy = Math.min(100, Math.max(0, Math.round(accuracy)));
  const normElapsedMs = Math.min(99999999, Math.max(0, Math.round(elapsedMs)));
  const normScore = Math.min(9999, Math.max(0, Math.round(score)));
  
  // ZScore = (Accuracy * 10^10) + ((99999999 - ElapsedMs) * 10^4) + Score
  return (normAccuracy * 10000000000) + ((99999999 - normElapsedMs) * 10000) + normScore;
}

async function saveSoloRecord(record) {
  const { nickname, difficulty, accuracy, elapsedMs, score, correct, total } = record;
  if (!nickname || !difficulty) return false;

  const zscore = calculateSoloZScore(accuracy, elapsedMs, score);
  const now = Date.now();

  if (isConfigured) {
    const key = `leaderboard:solo:${difficulty}`;
    const hashKey = `record:solo:${difficulty}:${nickname}`;

    // Check existing score
    const currentScoreStr = await redisCommand(["ZSCORE", key, nickname]);
    const currentScore = currentScoreStr ? Number(currentScoreStr) : 0;

    if (zscore > currentScore) {
      await redisPipeline([
        ["ZADD", key, zscore, nickname],
        ["HSET", hashKey,
          "nickname", nickname,
          "difficulty", difficulty,
          "accuracy", String(accuracy),
          "elapsedMs", String(elapsedMs),
          "score", String(score),
          "correct", String(correct),
          "total", String(total),
          "timestamp", String(now)
        ]
      ]);
      return true;
    }
    return false;
  } else {
    // In-Memory Fallback
    if (!memoryStore.soloZsets.has(difficulty)) {
      memoryStore.soloZsets.set(difficulty, new Map());
    }
    const zset = memoryStore.soloZsets.get(difficulty);
    const existingZScore = zset.get(nickname) || 0;

    if (zscore > existingZScore) {
      zset.set(nickname, zscore);
      memoryStore.soloRecords.set(`${difficulty}:${nickname}`, {
        nickname,
        difficulty,
        accuracy,
        elapsedMs,
        score,
        correct,
        total,
        timestamp: now
      });
      return true;
    }
    return false;
  }
}

async function getSoloLeaderboard(difficulty = "random", limit = 50) {
  if (isConfigured) {
    const key = `leaderboard:solo:${difficulty}`;
    const members = await redisCommand(["ZREVRANGE", key, 0, limit - 1]);
    if (!members || members.length === 0) return [];

    const pipelineCmds = members.map((nick) => ["HGETALL", `record:solo:${difficulty}:${nick}`]);
    const results = await redisPipeline(pipelineCmds);

    return (results || []).map((rawHash, i) => {
      const nick = members[i];
      if (!rawHash || rawHash.length === 0) {
        return { nickname: nick, accuracy: 0, elapsedMs: 0, score: 0 };
      }
      const obj = {};
      if (Array.isArray(rawHash)) {
        for (let j = 0; j < rawHash.length; j += 2) {
          obj[rawHash[j]] = rawHash[j + 1];
        }
      } else if (typeof rawHash === "object") {
        Object.assign(obj, rawHash);
      }
      return {
        nickname: obj.nickname || nick,
        difficulty: obj.difficulty || difficulty,
        accuracy: Number(obj.accuracy || 0),
        elapsedMs: Number(obj.elapsedMs || 0),
        score: Number(obj.score || 0),
        correct: Number(obj.correct || 0),
        total: Number(obj.total || 0),
        timestamp: Number(obj.timestamp || 0)
      };
    });
  } else {
    // In-Memory Fallback
    const zset = memoryStore.soloZsets.get(difficulty);
    if (!zset) return [];

    const sorted = [...zset.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return sorted.map(([nick]) => {
      return memoryStore.soloRecords.get(`${difficulty}:${nick}`) || { nickname: nick };
    });
  }
}

// -------------------------------------------------------------
// 1v1 Competitive ELO & Stats Logic
// -------------------------------------------------------------

function calculateEloChange(ratingA, ratingB, actualScoreA, K = 32) {
  const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
  const changeA = Math.round(K * (actualScoreA - expectedA));
  return changeA;
}

async function getUserDuelStats(nickname) {
  if (isConfigured) {
    const raw = await redisCommand(["HGETALL", `user:${nickname}:stats`]);
    const obj = {};
    if (Array.isArray(raw)) {
      for (let j = 0; j < raw.length; j += 2) {
        obj[raw[j]] = raw[j + 1];
      }
    } else if (typeof raw === "object" && raw !== null) {
      Object.assign(obj, raw);
    }
    return {
      nickname,
      elo: Number(obj.elo || 1000),
      wins: Number(obj.wins || 0),
      losses: Number(obj.losses || 0),
      draws: Number(obj.draws || 0),
      totalMatches: Number(obj.totalMatches || 0),
      lastPlayed: Number(obj.lastPlayed || 0)
    };
  } else {
    return memoryStore.userStats.get(nickname) || {
      nickname,
      elo: 1000,
      wins: 0,
      losses: 0,
      draws: 0,
      totalMatches: 0,
      lastPlayed: 0
    };
  }
}

async function updateDuelResult(playerAName, playerBName, isDraw = false, winnerName = null) {
  if (!playerAName || !playerBName || playerAName === playerBName) return null;

  const statsA = await getUserDuelStats(playerAName);
  const statsB = await getUserDuelStats(playerBName);

  let scoreA = 0.5;
  let scoreB = 0.5;

  if (!isDraw) {
    if (winnerName === playerAName) {
      scoreA = 1;
      scoreB = 0;
    } else {
      scoreA = 0;
      scoreB = 1;
    }
  }

  const changeA = calculateEloChange(statsA.elo, statsB.elo, scoreA);
  const changeB = calculateEloChange(statsB.elo, statsA.elo, scoreB);

  const newEloA = Math.max(100, statsA.elo + changeA);
  const newEloB = Math.max(100, statsB.elo + changeB);

  const now = Date.now();

  const updatedA = {
    nickname: playerAName,
    elo: newEloA,
    wins: statsA.wins + (scoreA === 1 ? 1 : 0),
    losses: statsA.losses + (scoreA === 0 ? 1 : 0),
    draws: statsA.draws + (isDraw ? 1 : 0),
    totalMatches: statsA.totalMatches + 1,
    lastPlayed: now,
    lastChange: changeA
  };

  const updatedB = {
    nickname: playerBName,
    elo: newEloB,
    wins: statsB.wins + (scoreB === 1 ? 1 : 0),
    losses: statsB.losses + (scoreB === 0 ? 1 : 0),
    draws: statsB.draws + (isDraw ? 1 : 0),
    totalMatches: statsB.totalMatches + 1,
    lastPlayed: now,
    lastChange: changeB
  };

  if (isConfigured) {
    const key = "leaderboard:duel";
    await redisPipeline([
      ["ZADD", key, updatedA.elo, playerAName],
      ["ZADD", key, updatedB.elo, playerBName],
      ["HSET", `user:${playerAName}:stats`,
        "elo", String(updatedA.elo),
        "wins", String(updatedA.wins),
        "losses", String(updatedA.losses),
        "draws", String(updatedA.draws),
        "totalMatches", String(updatedA.totalMatches),
        "lastPlayed", String(now)
      ],
      ["HSET", `user:${playerBName}:stats`,
        "elo", String(updatedB.elo),
        "wins", String(updatedB.wins),
        "losses", String(updatedB.losses),
        "draws", String(updatedB.draws),
        "totalMatches", String(updatedB.totalMatches),
        "lastPlayed", String(now)
      ]
    ]);
  } else {
    // In-Memory Fallback
    memoryStore.duelZset.set(playerAName, updatedA.elo);
    memoryStore.duelZset.set(playerBName, updatedB.elo);
    memoryStore.userStats.set(playerAName, updatedA);
    memoryStore.userStats.set(playerBName, updatedB);
  }

  return { playerA: updatedA, playerB: updatedB };
}

async function getDuelLeaderboard(limit = 50) {
  if (isConfigured) {
    const key = "leaderboard:duel";
    const members = await redisCommand(["ZREVRANGE", key, 0, limit - 1]);
    if (!members || members.length === 0) return [];

    const pipelineCmds = members.map((nick) => ["HGETALL", `user:${nick}:stats`]);
    const results = await redisPipeline(pipelineCmds);

    return (results || []).map((rawHash, i) => {
      const nick = members[i];
      const obj = {};
      if (Array.isArray(rawHash)) {
        for (let j = 0; j < rawHash.length; j += 2) {
          obj[rawHash[j]] = rawHash[j + 1];
        }
      } else if (typeof rawHash === "object" && rawHash !== null) {
        Object.assign(obj, rawHash);
      }
      const wins = Number(obj.wins || 0);
      const losses = Number(obj.losses || 0);
      const total = Number(obj.totalMatches || wins + losses);
      const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;

      return {
        nickname: nick,
        elo: Number(obj.elo || 1000),
        wins,
        losses,
        draws: Number(obj.draws || 0),
        totalMatches: total,
        winRate,
        lastPlayed: Number(obj.lastPlayed || 0)
      };
    });
  } else {
    // In-Memory Fallback
    const sorted = [...memoryStore.duelZset.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit);

    return sorted.map(([nick]) => {
      const stats = memoryStore.userStats.get(nick) || { elo: 1000, wins: 0, losses: 0, draws: 0, totalMatches: 0 };
      const total = stats.totalMatches || stats.wins + stats.losses;
      const winRate = total > 0 ? Math.round((stats.wins / total) * 100) : 0;
      return {
        nickname: nick,
        elo: stats.elo,
        wins: stats.wins,
        losses: stats.losses,
        draws: stats.draws,
        totalMatches: total,
        winRate,
        lastPlayed: stats.lastPlayed || 0
      };
    });
  }
}

module.exports = {
  isConfigured,
  saveSoloRecord,
  getSoloLeaderboard,
  updateDuelResult,
  getDuelLeaderboard,
  getUserDuelStats
};
