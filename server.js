const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");
const { checkAnswer, createChallenge, scoreQuestion } = require("./src/subnet");
const db = require("./src/db");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const clients = new Map();
const streams = new Map();
const waitingQueue = [];
const matches = new Map();
const practiceSessions = new Map();
const chatMessages = [];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp"
};

function safeJson(value) {
  return JSON.stringify(value).replaceAll("</", "<\\/");
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(safeJson(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

function publicUser(user, options = {}) {
  const isActive = user.status === "playing" || user.status === "practice" || user.status === "selecting_difficulty" || user.status === "queue";
  const hideLiveResults = options.hideLiveResults ?? isActive;
  return {
    id: user.id,
    nickname: user.nickname,
    status: user.status,
    progress: isActive ? (user.progress || 0) : null,  // 게임 중에만 progress 표시
    accuracy: hideLiveResults ? null : (user.totalAnswered ? Math.round((user.correct / user.totalAnswered) * 100) : 0),
    score: hideLiveResults ? null : (user.score || 0)
  };
}

function publicQuestions(challenge, revealAnswers = false) {
  if (revealAnswers) {
    return challenge.questions.map((question) => ({ ...question }));
  }
  return challenge.questions.map(({ answer, ...question }) => question);
}

function publicSubmission(submission, revealResults = false, blurAnswer = false) {
  const visible = {
    questionId: submission.questionId,
    index: submission.index,
    answer: blurAnswer ? (submission.answer ? "blurred" : "") : submission.answer,
    elapsedMs: submission.elapsedMs,
    submittedAt: submission.submittedAt
  };
  if (revealResults) {
    visible.correct = submission.correct;
    visible.score = submission.score;
  }
  return visible;
}

function getClient(id) {
  if (!id || !clients.has(id)) return null;
  const user = clients.get(id);
  user.lastSeen = Date.now();
  return user;
}

function broadcastLobby() {
  const payload = {
    type: "lobby",
    users: [...clients.values()].map(publicUser).sort((a, b) => b.score - a.score || a.nickname.localeCompare(b.nickname)),
    waiting: waitingQueue.length
  };
  broadcast(payload);
}

function broadcastChat() {
  broadcast({
    type: "chat",
    messages: chatMessages.slice(-40)
  });
}

function writeEvent(res, payload) {
  res.write(`data: ${safeJson(payload)}\n\n`);
}

function broadcast(payload) {
  for (const res of streams.values()) {
    writeEvent(res, payload);
  }
}

function sendToClient(clientId, payload) {
  const stream = streams.get(clientId);
  if (stream) writeEvent(stream, payload);
}

function snapshotMatchFor(clientId, match) {
  const me = match.players.find((id) => id === clientId);
  const opponent = match.players.find((id) => id !== clientId);
  const meState = match.playerState[me];
  const opponentState = match.playerState[opponent];
  const revealResults = match.status === "finished";
  return {
    id: match.id,
    status: match.status,
    startedAt: match.startedAt,
    completedAt: match.completedAt,
    questions: publicQuestions(match.challenge, revealResults),
    me: {
      ...publicUser(clients.get(me), { hideLiveResults: !revealResults }),
      currentIndex: meState.currentIndex,
      submissions: meState.submissions.map((submission) => publicSubmission(submission, revealResults, false))
    },
    opponent: {
      ...publicUser(clients.get(opponent), { hideLiveResults: !revealResults }),
      currentIndex: opponentState.currentIndex,
      submissions: opponentState.submissions.map((submission) => publicSubmission(submission, revealResults, !revealResults))
    },
    result: match.result || null
  };
}

function snapshotPracticeFor(clientId, session) {
  const user = clients.get(clientId);
  const answered = session.submissions.length;
  const totalTime = session.submissions.reduce((sum, item) => sum + item.elapsedMs, 0);
  const finished = answered >= session.challenge.questions.length;
  const result = finished ? {
    players: [{
      id: user.id,
      nickname: user.nickname,
      score: session.score,
      correct: session.correct,
      answered,
      accuracy: answered ? Math.round((session.correct / answered) * 100) : 0,
      averageMs: answered ? Math.round(totalTime / answered) : 0
    }],
    winnerId: user.id
  } : null;

  return {
    id: session.id,
    status: finished ? "finished" : "playing",
    startedAt: session.startedAt,
    completedAt: finished ? session.finishedAt : null,
    questions: publicQuestions(session.challenge, finished),
    me: {
      ...publicUser(user, { hideLiveResults: !finished }),
      score: finished ? session.score : null,
      correct: finished ? session.correct : null,
      totalAnswered: answered,
      progress: Math.round((answered / session.challenge.questions.length) * 100),
      currentIndex: session.currentIndex,
      submissions: session.submissions.map((submission) => publicSubmission(submission, finished, false))
    },
    opponent: null,
    result
  };
}

function broadcastMatch(match) {
  for (const playerId of match.players) {
    sendToClient(playerId, {
      type: "match",
      match: snapshotMatchFor(playerId, match)
    });
  }
  broadcastLobby();
}

function removeFromQueue(clientId) {
  const index = waitingQueue.indexOf(clientId);
  if (index >= 0) waitingQueue.splice(index, 1);
}

function createMatch(playerA, playerB) {
  const match = {
    id: `match-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    players: [playerA.id, playerB.id],
    status: "selecting_difficulty",
    difficultyChoices: {},
    startedAt: Date.now(),
    completedAt: null,
    playerState: {},
    result: null
  };
  matches.set(match.id, match);
  for (const player of [playerA, playerB]) {
    player.status = "selecting_difficulty";
    player.matchId = match.id;
  }
  
  for (const playerId of match.players) {
    const opponentId = match.players.find(id => id !== playerId);
    sendToClient(playerId, {
      type: "match_found",
      matchId: match.id,
      opponent: publicUser(clients.get(opponentId))
    });
  }
  broadcastLobby();
}

function tryMatch(user) {
  removeFromQueue(user.id);
  const opponentId = waitingQueue.find((id) => {
    const candidate = clients.get(id);
    return candidate && candidate.id !== user.id && candidate.status === "queue";
  });
  if (!opponentId) {
    user.status = "queue";
    waitingQueue.push(user.id);
    broadcastLobby();
    return null;
  }
  removeFromQueue(opponentId);
  const opponent = clients.get(opponentId);
  createMatch(opponent, user);
  return opponent.matchId;
}

async function finishMatchIfReady(match) {
  const questionCount = match.challenge.questions.length;
  const finished = match.players.every((id) => match.playerState[id].submissions.length >= questionCount);
  if (!finished) return;

  match.status = "finished";
  match.completedAt = Date.now();
  const [a, b] = match.players.map((id) => clients.get(id));
  const playerResults = [a, b].map((player) => {
    const state = match.playerState[player.id];
    const answered = state.submissions.length;
    const totalTime = state.submissions.reduce((sum, item) => sum + item.elapsedMs, 0);
    return {
      id: player.id,
      nickname: player.nickname,
      score: player.score,
      correct: player.correct,
      answered,
      accuracy: answered ? Math.round((player.correct / answered) * 100) : 0,
      averageMs: answered ? Math.round(totalTime / answered) : 0
    };
  });
  const isDraw = playerResults[0].score === playerResults[1].score &&
                 playerResults[0].accuracy === playerResults[1].accuracy &&
                 playerResults[0].averageMs === playerResults[1].averageMs;

  const winner = [...playerResults].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.accuracy !== left.accuracy) return right.accuracy - left.accuracy;
    return left.averageMs - right.averageMs;
  })[0];

  match.result = { players: playerResults, winnerId: isDraw ? null : winner.id };

  if (a && b) {
    try {
      const eloUpdate = await db.updateDuelResult(a.nickname, b.nickname, isDraw, winner.nickname);
      if (eloUpdate) {
        match.result.eloUpdate = eloUpdate;
      }
    } catch (err) {
      console.error("[Match ELO Update Error]", err);
    }
  }

  for (const playerId of match.players) {
    const player = clients.get(playerId);
    if (player) {
      player.status = "online";
      player.lastMatchId = match.id;
      player.matchId = null;
    }
  }
}

async function finishPractice(user, session) {
  if (session.currentIndex < session.challenge.questions.length) return;
  if (session.finishedAt) return; // 이미 완료된 세션 중복 처리 방지
  session.finishedAt = Date.now();
  user.status = "online";
  user.progress = 100;
  user.score = session.score;
  user.correct = session.correct;
  user.totalAnswered = session.submissions.length;

  const totalTime = session.submissions.reduce((sum, item) => sum + item.elapsedMs, 0);
  const accuracy = session.submissions.length ? Math.round((session.correct / session.submissions.length) * 100) : 0;
  const mode = session.challenge.mode || "easy";

  console.log(`[Solo Record] ${user.nickname} | mode=${mode} | score=${session.score} | accuracy=${accuracy}% | time=${totalTime}ms`);

  try {
    const newBest = await db.saveSoloRecord({
      nickname: user.nickname,
      difficulty: mode,
      accuracy,
      elapsedMs: totalTime,
      score: session.score,
      correct: session.correct,
      total: session.submissions.length
    });
    console.log(`[Solo Record] 저장 결과: newBest=${newBest}`);
    session.newRecord = newBest;
  } catch (err) {
    console.error("[Solo Record Save Error]", err);
  }
}

function handleStatic(req, res, url) {
  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, requestedPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(data);
  });
}

async function handleApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/events") {
    const clientId = url.searchParams.get("clientId");
    if (!clientId) return sendJson(res, 400, { error: "clientId is required" });
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    streams.set(clientId, res);
    writeEvent(res, { type: "hello", now: Date.now() });
    writeEvent(res, { type: "chat", messages: chatMessages.slice(-40) });
    broadcastLobby();
    req.on("close", () => {
      streams.delete(clientId);
    });
    return;
  }

  // GET API Endpoints for Leaderboard & Stats
  if (req.method === "GET") {
    if (url.pathname === "/api/leaderboard/solo") {
      const difficulty = url.searchParams.get("difficulty") || "random";
      const list = await db.getSoloLeaderboard(difficulty);
      return sendJson(res, 200, { difficulty, list });
    }
    if (url.pathname === "/api/leaderboard/duel") {
      const list = await db.getDuelLeaderboard();
      return sendJson(res, 200, { list });
    }
    if (url.pathname === "/api/user/stats") {
      const nickname = url.searchParams.get("nickname") || "";
      const stats = await db.getUserDuelStats(nickname);
      return sendJson(res, 200, { stats });
    }
    return handleStatic(req, res, url);
  }

  if (req.method !== "POST") {
    return handleStatic(req, res, url);
  }

  try {
    const body = await readBody(req);

    if (url.pathname === "/api/join") {
      const id = String(body.clientId || "").slice(0, 80);
      const nickname = String(body.nickname || "").trim().slice(0, 16);
      if (!id || !nickname) return sendJson(res, 400, { error: "닉네임을 입력해 주세요." });

      // 닉네임 중복 처리
      for (const [existingId, existingUser] of clients.entries()) {
        if (existingId !== id && existingUser.nickname === nickname) {
          if (streams.has(existingId)) {
            // 현재 접속 중인 다른 사용자 → 닉네임 사용 불가
            return sendJson(res, 409, { error: `"${nickname}"은(는) 이미 사용 중인 닉네임입니다.` });
          } else {
            // 연결이 끊긴 세션 (브라우저 재접속) → 기존 세션 제거 후 허용
            removeFromQueue(existingId);
            practiceSessions.delete(existingId);
            clients.delete(existingId);
          }
        }
      }

      const user = clients.get(id) || { id };
      Object.assign(user, {
        nickname,
        status: user.status || "online",
        lastSeen: Date.now(),
        score: user.score || 0,
        correct: user.correct || 0,
        totalAnswered: user.totalAnswered || 0,
        progress: user.progress || 0
      });
      clients.set(id, user);
      broadcastLobby();
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (url.pathname === "/api/match") {
      const user = getClient(body.clientId);
      if (!user) return sendJson(res, 401, { error: "먼저 닉네임을 등록해 주세요." });
      if (user.status === "playing" || user.status === "selecting_difficulty") return sendJson(res, 409, { error: "이미 경기 중입니다." });
      practiceSessions.delete(user.id);
      const matchId = tryMatch(user);
      return sendJson(res, 200, { status: user.status, matchId });
    }

    if (url.pathname === "/api/match/difficulty") {
      const user = getClient(body.clientId);
      if (!user || !user.matchId) return sendJson(res, 409, { error: "진행 중인 경기가 없습니다." });
      const match = matches.get(user.matchId);
      if (!match || match.status !== "selecting_difficulty") return sendJson(res, 409, { error: "난이도 선택 단계가 아닙니다." });
      
      const mode = body.mode || "easy";
      const cidrMin = Number.isInteger(body.cidrMin) ? body.cidrMin : undefined;
      const cidrMax = Number.isInteger(body.cidrMax) ? body.cidrMax : undefined;
      match.difficultyChoices[user.id] = mode;
      match.cidrRanges = match.cidrRanges || {};
      match.cidrRanges[user.id] = { cidrMin, cidrMax };
      
      const playerChoices = match.players.map(id => match.difficultyChoices[id]).filter(Boolean);
      
      if (playerChoices.length === 2) {
        const choiceA = match.difficultyChoices[match.players[0]];
        const choiceB = match.difficultyChoices[match.players[1]];
        
        let finalMode = choiceA;
        if (choiceA !== choiceB) {
          finalMode = Math.random() < 0.5 ? choiceA : choiceB;
        }
        
        const winnerPlayerId = finalMode === choiceA ? match.players[0] : match.players[1];
        const winnerRange = (match.cidrRanges || {})[winnerPlayerId] || {};
        const challenge = createChallenge(finalMode, winnerRange);
        match.challenge = challenge;
        match.status = "playing";
        match.finalMode = finalMode;
        match.startedAt = Date.now();
        match.playerState = {
          [match.players[0]]: { currentIndex: 0, questionStartedAt: Date.now(), submissions: [], finishedAt: null },
          [match.players[1]]: { currentIndex: 0, questionStartedAt: Date.now(), submissions: [], finishedAt: null }
        };
        
        for (const playerId of match.players) {
          const player = clients.get(playerId);
          player.status = "playing";
          player.progress = 0;
          player.score = 0;
          player.correct = 0;
          player.totalAnswered = 0;
        }
        
        for (const playerId of match.players) {
          sendToClient(playerId, {
            type: "match_start",
            matchId: match.id,
            finalMode,
            choiceA,
            choiceB
          });
        }
        
        setTimeout(() => {
           broadcastMatch(match);
        }, 3000); // 3 seconds delay for roulette animation
        
      } else {
        return sendJson(res, 200, { waiting: true });
      }
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/practice") {
      const user = getClient(body.clientId);
      if (!user) return sendJson(res, 401, { error: "먼저 닉네임을 등록해 주세요." });
      if (user.status === "playing" || user.status === "selecting_difficulty") return sendJson(res, 409, { error: "경기 중에는 연습을 시작할 수 없습니다." });
      removeFromQueue(user.id);
      const mode = body.mode || "easy";
      const cidrMin = Number.isInteger(body.cidrMin) ? body.cidrMin : undefined;
      const cidrMax = Number.isInteger(body.cidrMax) ? body.cidrMax : undefined;
      const challenge = createChallenge(mode, { cidrMin, cidrMax });
      const session = {
        id: challenge.id,
        challenge,
        startedAt: Date.now(),
        finishedAt: null,
        currentIndex: 0,
        questionStartedAt: Date.now(),
        submissions: [],
        score: 0,
        correct: 0
      };
      practiceSessions.set(user.id, session);
      user.status = "practice";
      user.progress = 0;
      user.score = 0;
      user.correct = 0;
      user.totalAnswered = 0;
      broadcastLobby();
      return sendJson(res, 200, { match: snapshotPracticeFor(user.id, session) });
    }

    if (url.pathname === "/api/cancel") {
      const user = getClient(body.clientId);
      if (!user) return sendJson(res, 401, { error: "Unknown user" });
      removeFromQueue(user.id);
      practiceSessions.delete(user.id);

      const targetMatchId = user.matchId || user.lastMatchId;
      if (targetMatchId && matches.has(targetMatchId)) {
        const match = matches.get(targetMatchId);
        const opponentId = match.players.find(id => id !== user.id);
        if (opponentId) {
          sendToClient(opponentId, {
            type: "opponent_left",
            nickname: user.nickname
          });
        }
        if (match.rematchRequest) {
          match.rematchRequest = null;
        }
      }

      user.status = "online";
      if (user.matchId) {
        user.lastMatchId = user.matchId;
        user.matchId = null;
      }
      broadcastLobby();
      return sendJson(res, 200, { user: publicUser(user) });
    }

    if (url.pathname === "/api/match/rematch") {
      const user = getClient(body.clientId);
      if (!user) return sendJson(res, 401, { error: "먼저 닉네임을 등록해 주세요." });
      const action = body.action || "request";
      const targetMatchId = user.matchId || user.lastMatchId;
      if (!targetMatchId || !matches.has(targetMatchId)) {
        return sendJson(res, 409, { error: "최근 완료된 경기가 없습니다." });
      }
      const match = matches.get(targetMatchId);
      const opponentId = match.players.find(id => id !== user.id);
      const opponent = clients.get(opponentId);

      if (!opponent) {
        return sendJson(res, 400, { error: "상대방이 오프라인 상태입니다." });
      }

      if (action === "request") {
        match.rematchRequest = {
          requesterId: user.id,
          targetId: opponent.id,
          requestedAt: Date.now()
        };
        sendToClient(opponent.id, {
          type: "rematch_request",
          matchId: match.id,
          fromNickname: user.nickname
        });
        return sendJson(res, 200, { ok: true, message: "재대결을 요청했습니다." });
      }

      if (action === "accept") {
        if (!match.rematchRequest || match.rematchRequest.targetId !== user.id) {
          return sendJson(res, 400, { error: "유효한 재대결 요청이 없습니다." });
        }
        const requester = clients.get(match.rematchRequest.requesterId);
        match.rematchRequest = null;
        if (!requester || requester.status === "playing" || requester.status === "practice") {
          return sendJson(res, 400, { error: "상대방이 수락 가능한 상태가 아닙니다." });
        }
        createMatch(user, requester);
        return sendJson(res, 200, { ok: true, message: "재대결이 시작됩니다." });
      }

      if (action === "decline") {
        if (match.rematchRequest) {
          const requesterId = match.rematchRequest.requesterId;
          match.rematchRequest = null;
          sendToClient(requesterId, {
            type: "rematch_declined",
            fromNickname: user.nickname
          });
        }
        return sendJson(res, 200, { ok: true });
      }

      return sendJson(res, 400, { error: "잘못된 요청입니다." });
    }

    if (url.pathname === "/api/chat") {
      const user = getClient(body.clientId);
      if (!user) return sendJson(res, 401, { error: "먼저 로비에 입장해 주세요." });
      const text = String(body.text || "").replace(/\s+/g, " ").trim().slice(0, 120);
      if (!text) return sendJson(res, 400, { error: "메시지를 입력해 주세요." });
      chatMessages.push({
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        nickname: user.nickname,
        text,
        createdAt: Date.now()
      });
      while (chatMessages.length > 80) chatMessages.shift();
      broadcastChat();
      return sendJson(res, 200, { ok: true });
    }

    if (url.pathname === "/api/practice/answer") {
      const user = getClient(body.clientId);
      const session = user ? practiceSessions.get(user.id) : null;
      if (!user || !session) return sendJson(res, 409, { error: "진행 중인 연습이 없습니다." });
      const question = session.challenge.questions[session.currentIndex];
      if (!question) return sendJson(res, 409, { error: "모든 문제를 제출했습니다." });
      const elapsedMs = Math.max(0, Math.min(10 * 60 * 1000, Number(body.elapsedMs) || Date.now() - session.questionStartedAt));
      const answer = String(body.answer || "").trim().slice(0, 120);
      const correct = checkAnswer(question, answer);
      const score = scoreQuestion(question, correct, elapsedMs);
      session.submissions.push({
        questionId: question.id,
        index: session.currentIndex,
        answer,
        correct,
        score,
        elapsedMs,
        submittedAt: Date.now()
      });
      session.currentIndex += 1;
      session.questionStartedAt = Date.now();
      session.score += score;
      session.correct += correct ? 1 : 0;
      user.progress = Math.round((session.currentIndex / session.challenge.questions.length) * 100);
      await finishPractice(user, session);
      broadcastLobby();
      return sendJson(res, 200, { accepted: true, match: snapshotPracticeFor(user.id, session) });
    }

    if (url.pathname === "/api/practice/resubmit") {
      const user = getClient(body.clientId);
      const session = user ? practiceSessions.get(user.id) : null;
      if (!user || !session) return sendJson(res, 409, { error: "진행 중인 연습이 없습니다." });
      const targetIndex = Number(body.targetIndex);
      if (!Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex >= session.challenge.questions.length) {
        return sendJson(res, 400, { error: "잘못된 문제 번호입니다." });
      }
      const existingSub = session.submissions.find(s => s.index === targetIndex);
      if (!existingSub) return sendJson(res, 409, { error: "해당 문제를 아직 제출하지 않았습니다." });
      const question = session.challenge.questions[targetIndex];
      const elapsedMs = Math.max(0, Math.min(10 * 60 * 1000, Number(body.elapsedMs) || 0));
      const answer = String(body.answer || "").trim().slice(0, 120);
      const correct = checkAnswer(question, answer);
      const score = scoreQuestion(question, correct, elapsedMs);
      // 점수/정답 수 차이 반영
      session.score = session.score - existingSub.score + score;
      session.correct = session.correct - (existingSub.correct ? 1 : 0) + (correct ? 1 : 0);
      // 기존 제출 교체
      Object.assign(existingSub, { answer, correct, score, elapsedMs, submittedAt: Date.now() });
      broadcastLobby();
      return sendJson(res, 200, { accepted: true, match: snapshotPracticeFor(user.id, session) });
    }


    if (url.pathname === "/api/answer") {
      const user = getClient(body.clientId);
      if (!user || !user.matchId) return sendJson(res, 409, { error: "진행 중인 경기가 없습니다." });
      const match = matches.get(user.matchId);
      if (!match || match.status !== "playing") return sendJson(res, 409, { error: "경기가 종료되었습니다." });
      const state = match.playerState[user.id];
      const question = match.challenge.questions[state.currentIndex];
      if (!question) return sendJson(res, 409, { error: "모든 문제를 제출했습니다." });
      const elapsedMs = Math.max(0, Math.min(10 * 60 * 1000, Date.now() - state.questionStartedAt));
      const answer = String(body.answer || "").trim().slice(0, 120);
      const correct = checkAnswer(question, answer);
      const score = scoreQuestion(question, correct, elapsedMs);
      state.submissions.push({
        questionId: question.id,
        index: state.currentIndex,
        answer,
        correct,
        score,
        elapsedMs,
        submittedAt: Date.now()
      });
      state.currentIndex += 1;
      state.questionStartedAt = Date.now();
      user.score += score;
      user.correct += correct ? 1 : 0;
      user.totalAnswered += 1;
      user.progress = Math.round((state.currentIndex / match.challenge.questions.length) * 100);
      if (state.currentIndex >= match.challenge.questions.length) {
        state.finishedAt = Date.now();
      }
      await finishMatchIfReady(match);
      broadcastMatch(match);
      return sendJson(res, 200, { accepted: true });
    }

    sendJson(res, 404, { error: "Unknown API route" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

setInterval(() => {
  const cutoff = Date.now() - 1000 * 60 * 20;
  for (const [id, user] of clients.entries()) {
    if (user.lastSeen < cutoff && !streams.has(id)) {
      removeFromQueue(id);
      practiceSessions.delete(id);
      clients.delete(id);
    }
  }
  broadcastLobby();
}, 30_000).unref();

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/") || url.pathname === "/events") {
    handleApi(req, res, url);
  } else {
    handleStatic(req, res, url);
  }
});

server.listen(PORT, () => {
  console.log(`Subnet Duel listening on http://localhost:${PORT}`);
});
