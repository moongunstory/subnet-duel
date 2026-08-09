// 탭마다 고유한 clientId를 사용하여 같은 브라우저에서 여러 프로필로 테스트 가능
// sessionStorage는 탭 간 공유되지 않으므로 각 탭이 독립적인 세션을 가짐
const state = {
  clientId: sessionStorage.getItem("subnetDuelClientId") || crypto.randomUUID(),
  nickname: sessionStorage.getItem("subnetDuelNickname") || localStorage.getItem("subnetDuelNickname") || "",
  eventSource: null,
  currentMatch: null,
  currentMode: "duel",
  questionStartedAt: 0,
  lastQuestionId: null,
  timerId: null,
  editingIndex: null,
  soundEnabled: localStorage.getItem("subnetDuelSound") !== "off",
  audioContext: null
};

sessionStorage.setItem("subnetDuelClientId", state.clientId);

const $ = (selector) => document.querySelector(selector);

const els = {
  entryPanel: $("#entryPanel"),
  lobbyPanel: $("#lobbyPanel"),
  gamePanel: $("#gamePanel"),
  resultPanel: $("#resultPanel"),
  joinForm: $("#joinForm"),
  nickname: $("#nickname"),
  helloName: $("#helloName"),
  statusPill: $("#statusPill"),
  matchButton: $("#matchButton"),
  practiceButton: $("#practiceButton"),
  onlineCount: $("#onlineCount"),
  userList: $("#userList"),
  soundToggle: $("#soundToggle"),
  chatMessages: $("#chatMessages"),
  chatForm: $("#chatForm"),
  chatInput: $("#chatInput"),
  matchMode: $("#matchMode"),
  matchTitle: $("#matchTitle"),
  myName: $("#myName"),
  myScore: $("#myScore"),
  myProgress: $("#myProgress"),
  myBoard: $("#myBoard"),
  opponentName: $("#opponentName"),
  opponentScore: $("#opponentScore"),
  opponentProgress: $("#opponentProgress"),
  opponentBoard: $("#opponentBoard"),
  questionNumber: $("#questionNumber"),
  questionPoints: $("#questionPoints"),
  questionStem: $("#questionStem"),
  questionPrompt: $("#questionPrompt"),
  questionHint: $("#questionHint"),
  questionTimer: $("#questionTimer"),
  answerForm: $("#answerForm"),
  answerInput: $("#answerInput"),
  rangeAnswerGroup: $("#rangeAnswerGroup"),
  rangeStartInput: $("#rangeStartInput"),
  rangeEndInput: $("#rangeEndInput"),
  maskReference: $("#maskReference"),
  maskValue: $("#maskValue"),
  totalHostsReference: $("#totalHostsReference"),
  totalHostsValue: $("#totalHostsValue"),
  rangeReference: $("#rangeReference"),
  rangeRefValue: $("#rangeRefValue"),
  copyIpBtn: $("#copyIpBtn"),
  feedback: $("#feedback"),
  resultTitle: $("#resultTitle"),
  resultStats: $("#resultStats"),
  resultReview: $("#resultReview"),
  againButton: $("#againButton"),
  rematchButton: $("#rematchButton"),
  rematchStatusText: $("#rematchStatusText"),
  rematchModal: $("#rematchModal"),
  rematchPromptText: $("#rematchPromptText"),
  acceptRematchBtn: $("#acceptRematchBtn"),
  declineRematchBtn: $("#declineRematchBtn"),
  navTabModes: $("#navTabModes"),
  navTabRanking: $("#navTabRanking"),
  lobbyModesContent: $("#lobbyModesContent"),
  lobbyRankingContent: $("#lobbyRankingContent"),
  tabDuel: $("#tabDuel"),
  tabSolo: $("#tabSolo"),
  soloFilterPanel: $("#soloFilterPanel"),
  lbThead: $("#lbThead"),
  lbTbody: $("#lbTbody"),
  lbLoading: $("#lbLoading"),
  lbEmpty: $("#lbEmpty")
};

els.nickname.value = state.nickname;
els.soundToggle.checked = state.soundEnabled;

function show(panel) {
  for (const element of [els.entryPanel, els.lobbyPanel, els.gamePanel, els.resultPanel]) {
    element.classList.add("hidden");
  }
  panel.classList.remove("hidden");
}

async function api(path, body) {
  const response = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "요청에 실패했습니다.");
  return payload;
}

function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource(`/events?clientId=${encodeURIComponent(state.clientId)}`);
  state.eventSource.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "lobby") renderLobby(payload);
    if (payload.type === "match") renderMatch(payload.match, "duel");
    if (payload.type === "chat") renderChat(payload.messages);
    if (payload.type === "rematch_request") {
      playSound("queue");
      els.rematchPromptText.textContent = `${escapeHtml(payload.fromNickname)} 님이 한판 더 하기를 요청했습니다!`;
      els.rematchModal.classList.remove("hidden");
    }
    if (payload.type === "rematch_declined") {
      els.rematchStatusText.textContent = `${escapeHtml(payload.fromNickname)} 님이 재대결을 거절했습니다.`;
      els.rematchButton.disabled = false;
    }
    if (payload.type === "opponent_left") {
      els.rematchStatusText.textContent = `${escapeHtml(payload.nickname)} 님이 로비로 나갔습니다.`;
      els.rematchButton.disabled = true;
      els.rematchModal.classList.add("hidden");
    }
    if (payload.type === "match_found") {
      els.rematchModal.classList.add("hidden");
      els.rematchStatusText.textContent = "";
      els.rematchButton.disabled = false;
      window.pendingMode = "match";
      const modal = document.querySelector("#difficultyModal");
      // 경쟁 모드: solo-only 버튼 숨기기
      modal.querySelectorAll(".solo-only").forEach(b => b.classList.add("hidden"));
      document.querySelector("#customRangePanel").classList.add("hidden");
      modal.classList.remove("hidden");
      document.querySelector("#rouletteContainer").classList.add("hidden");
      document.querySelectorAll(".difficulty-btn").forEach(b => b.disabled = false);
    }
    if (payload.type === "match_start") {
      document.querySelector("#rouletteContainer").classList.remove("hidden");
      if (payload.choiceA === payload.choiceB) {
        document.querySelector("#rouletteContainer").querySelector("p").textContent = "동일한 난이도 선택!";
        document.querySelector("#rouletteResult").textContent = payload.finalMode.toUpperCase();
      } else {
        document.querySelector("#rouletteContainer").querySelector("p").textContent = "난이도가 엇갈렸습니다. 랜덤 선택 중...";
        let ticks = 0;
        const interval = setInterval(() => {
          document.querySelector("#rouletteResult").textContent = Math.random() < 0.5 ? payload.choiceA.toUpperCase() : payload.choiceB.toUpperCase();
          ticks++;
          if (ticks > 20) {
            clearInterval(interval);
            document.querySelector("#rouletteResult").textContent = payload.finalMode.toUpperCase();
          }
        }, 80);
      }
      setTimeout(() => {
        document.querySelector("#difficultyModal").classList.add("hidden");
      }, 2900);
    }
    if (payload.type === "match_cancelled") {
      // 난이도 선택 타임아웃 등으로 매칭 강제 취소
      document.querySelector("#difficultyModal").classList.add("hidden");
      document.querySelector("#rouletteContainer").classList.add("hidden");
      document.querySelectorAll(".difficulty-btn").forEach(b => b.disabled = false);
      els.matchButton.dataset.queue = "false";
      els.matchButton.querySelector("span").textContent = "경쟁 매칭";
      els.matchButton.querySelector("strong").textContent = "난이도 선택 대결";
      els.statusPill.textContent = "온라인";
      window.pendingMode = null;
      alert(payload.reason || "매칭이 취소되었습니다.");
    }
  };
  // SSE 연결 끊김 시 3초 후 자동 재연결
  state.eventSource.onerror = () => {
    state.eventSource.close();
    setTimeout(() => {
      if (state.clientId && state.nickname) connectEvents();
    }, 3000);
  };
}


function renderLobby(payload) {
  els.onlineCount.textContent = payload.users.length;
  els.userList.innerHTML = payload.users.map((user) => `
    <div class="user-item">
      <strong>${escapeHtml(user.nickname)}</strong>
      <span>${statusLabel(user.status)}</span>
      <div class="user-meta">
        <span>${formatScore(user.score)}</span>
        <span>${formatAccuracy(user.accuracy)}</span>
        ${user.progress !== null ? `<span>${user.progress}% 진행</span>` : ""}
      </div>
    </div>
  `).join("");
}

function renderChat(messages = []) {
  els.chatMessages.innerHTML = messages.map((message) => `
    <div class="chat-message">
      <strong>${escapeHtml(message.nickname)}</strong>
      <span>${escapeHtml(message.text)}</span>
    </div>
  `).join("");
  els.chatMessages.scrollTop = els.chatMessages.scrollHeight;
}

function formatScore(value) {
  return Number.isFinite(value) ? `${value}점` : "채점 대기";
}

function formatAccuracy(value) {
  return Number.isFinite(value) ? `${value}%` : "--";
}

function statusLabel(status) {
  if (status === "queue") return "매칭 중";
  if (status === "playing") return "경기 중";
  if (status === "practice") return "연습 중";
  return "온라인";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}

function getCurrentQuestion(match = state.currentMatch) {
  if (!match) return null;
  return match.questions[match.me.currentIndex] || null;
}

function renderMatch(match, mode = "duel") {
  state.currentMatch = match;
  state.currentMode = mode;

  if (match.status === "finished") {
    state.editingIndex = null;
    renderResult(match, mode);
    return;
  }

  show(els.gamePanel);
  els.gamePanel.classList.toggle("practice-mode", mode === "practice");

  // 현재 표시할 문제: 편집 중이면 편집 대상 문제, 아니면 진행 중인 다음 문제
  const displayIndex = (state.editingIndex !== null) ? state.editingIndex : match.me.currentIndex;
  const question = match.questions[displayIndex] || null;
  const opponentQuestion = match.opponent ? match.questions[match.opponent.currentIndex] : null;
  els.matchMode.textContent = mode === "practice" ? "Solo Practice" : "Live Match";
  els.matchTitle.textContent = mode === "practice" ? `${match.me.nickname}의 솔로 연습` : `${match.me.nickname} vs ${match.opponent.nickname}`;
  els.myName.textContent = match.me.nickname;
  els.opponentName.textContent = match.opponent?.nickname || "트레이닝";
  els.myScore.textContent = formatScore(match.me.score);
  els.opponentScore.textContent = formatScore(match.opponent?.score);
  els.myProgress.style.width = `${match.me.progress}%`;
  els.opponentProgress.style.width = `${match.opponent?.progress || 0}%`;
  renderBoard(els.myBoard, match.questions, match.me.currentIndex, match.me.submissions, false, mode === "practice", displayIndex);
  renderBoard(els.opponentBoard, match.questions, match.opponent?.currentIndex || 0, match.opponent?.submissions || [], true, false, -1);
  renderMaskReference(match);

  if (question) {
    const isEditing = state.editingIndex !== null;
    if (!isEditing && (!state.questionStartedAt || state.lastQuestionId !== question.id)) {
      state.questionStartedAt = performance.now();
      state.lastQuestionId = question.id;
      els.feedback.textContent = "";
      clearAnswerInputs();
    }
    if (isEditing) {
      // 편집 모드: 기존 답 채우기
      const sub = match.me.submissions.find(s => s.index === displayIndex);
      els.feedback.textContent = "";
      if (sub) prefillAnswer(question, sub.answer);
    }
    els.questionNumber.textContent = isEditing
      ? `Q${question.index + 1} 수정 중`
      : `Q${question.index + 1} / ${match.questions.length}`;
    els.questionPoints.textContent = `${question.points}점`;
    els.questionStem.textContent = question.stem;
    els.questionPrompt.textContent = question.prompt;
    els.questionHint.textContent = question.hint;
    configureAnswerInputs(question);
  } else {
    state.editingIndex = null;
    els.questionNumber.textContent = "제출 완료";
    els.questionPoints.textContent = "";
    els.questionStem.textContent = mode === "practice" ? "연습 결과를 계산하고 있습니다." : "상대가 마무리하는 중입니다.";
    els.questionPrompt.textContent = opponentQuestion ? `상대는 ${opponentQuestion.title} 계산 중` : "결과 계산 중";
    els.questionHint.textContent = "";
    configureAnswerInputs(null, true);
  }

  startTimer();
}

function renderBoard(container, questions, currentIndex, submissions, blur, clickable = false, highlightIndex = -1) {
  const submittedByIndex = new Map(submissions.map((submission) => [submission.index, submission]));
  container.innerHTML = questions.map((question, index) => {
    const submission = submittedByIndex.get(index);
    const canReveal = typeof submission?.correct === "boolean";
    const isHighlighted = index === highlightIndex && clickable;
    const baseClass = submission ? (canReveal ? (submission.correct ? "correct" : "wrong") : "submitted") : (index === currentIndex ? "current" : "");
    const statusClass = isHighlighted ? `${baseClass} editing` : baseClass;
    const answer = submission && canReveal ? (blur ? "255.255.***.***" : escapeHtml(submission.answer || "-")) : "";
    const mark = submission ? (canReveal ? (submission.correct ? "OK" : "MISS") : "DONE") : (index === currentIndex ? "NOW" : "");
    const editAttr = (clickable && submission) ? `data-edit-index="${index}" style="cursor:pointer" title="클릭하여 수정"` : "";
    return `
      <div class="tile ${statusClass}" ${editAttr}>
        <span>Q${index + 1}</span>
        <strong>${escapeHtml(question.title)}</strong>
        <span class="tile-answer">${answer || mark}</span>
      </div>
    `;
  }).join("");

  // 클릭 가능한 타일 이벤트 등록
  if (clickable) {
    container.querySelectorAll("[data-edit-index]").forEach(tile => {
      tile.addEventListener("click", () => {
        const idx = Number(tile.dataset.editIndex);
        if (state.editingIndex === idx) {
          // 다시 클릭 하면 취소
          state.editingIndex = null;
        } else {
          state.editingIndex = idx;
        }
        renderMatch(state.currentMatch, state.currentMode);
      });
    });
  }
}

function renderMaskReference(match) {
  const maskSubmission = match.me.submissions.find((submission) => match.questions[submission.index]?.id === "mask");
  const totalHostsSubmission = match.me.submissions.find((submission) => match.questions[submission.index]?.id === "totalHosts");
  const rangeSubmission = match.me.submissions.find((submission) => match.questions[submission.index]?.id === "fullRange");

  // 마스크 참조: Q1 제출 후 끝까지 표시
  if (maskSubmission?.answer) {
    els.maskValue.textContent = maskSubmission.answer;
    els.maskReference.classList.remove("hidden");
  } else {
    els.maskReference.classList.add("hidden");
    els.maskValue.textContent = "-";
  }

  // 전체 주소 수 참조: Q2 제출 후 끝까지 표시
  if (totalHostsSubmission?.answer) {
    els.totalHostsValue.textContent = totalHostsSubmission.answer;
    els.totalHostsReference.classList.remove("hidden");
  } else {
    els.totalHostsReference.classList.add("hidden");
    els.totalHostsValue.textContent = "-";
  }

  // 전체 주소 범위 참조: Q4 제출 후 끝까지 표시
  if (rangeSubmission?.answer) {
    els.rangeRefValue.textContent = rangeSubmission.answer;
    els.rangeReference.classList.remove("hidden");
  } else {
    els.rangeReference.classList.add("hidden");
    els.rangeRefValue.textContent = "-";
  }
}

function configureAnswerInputs(question, disabled = false) {
  const isRange = question?.type === "range";
  els.answerInput.classList.toggle("hidden", isRange);
  els.answerInput.disabled = disabled || isRange;
  els.answerInput.required = !disabled && !isRange;
  els.rangeAnswerGroup.classList.toggle("hidden", !isRange);
  for (const input of [els.rangeStartInput, els.rangeEndInput]) {
    input.disabled = disabled || !isRange;
    input.required = !disabled && isRange;
  }
  if (disabled) return;
  if (isRange) {
    els.rangeStartInput.focus();
  } else {
    els.answerInput.focus();
  }
}

function clearAnswerInputs() {
  els.answerInput.value = "";
  els.rangeStartInput.value = "";
  els.rangeEndInput.value = "";
}

function prefillAnswer(question, answer) {
  if (!answer) return;
  if (question?.type === "range") {
    const parts = answer.split("~").map(s => s.trim());
    els.rangeStartInput.value = parts[0] || "";
    els.rangeEndInput.value = parts[1] || "";
  } else {
    els.answerInput.value = answer;
  }
}

function collectAnswer(question) {
  if (question?.type === "range") {
    const start = els.rangeStartInput.value.trim();
    const end = els.rangeEndInput.value.trim();
    return start && end ? `${start} ~ ${end}` : "";
  }
  return els.answerInput.value.trim();
}

function sanitizeIpInput(event) {
  const parts = event.target.value
    .replace(/[^\d.]/g, "")
    .split(".")
    .slice(0, 4)
    .map((part) => part.slice(0, 3));
  event.target.value = parts.join(".");
}

function startTimer() {
  if (state.timerId) return;
  state.timerId = setInterval(() => {
    if (!state.questionStartedAt) return;
    const seconds = (performance.now() - state.questionStartedAt) / 1000;
    els.questionTimer.textContent = `${seconds.toFixed(1).padStart(4, "0")}s`;
  }, 100);
}

function stopTimer() {
  if (state.timerId) clearInterval(state.timerId);
  state.timerId = null;
}

function renderResult(match, mode = state.currentMode) {
  stopTimer();
  show(els.resultPanel);
  els.gamePanel.classList.remove("practice-mode");
  const winner = match.result?.players.find((player) => player.id === match.result.winnerId);
  if (mode === "practice") {
    const isNewRecord = match.newRecord === true;
    els.resultTitle.textContent = isNewRecord ? "🏆 신기록 달성!" : "연습 완료";
    if (isNewRecord) {
      els.resultTitle.style.color = "#f5c518";
      els.resultTitle.style.animation = "pulse 0.6s ease-in-out 3";
      setTimeout(() => { els.resultTitle.style.color = ""; els.resultTitle.style.animation = ""; }, 2000);
    }
    els.rematchButton.classList.add("hidden");
    els.rematchStatusText.textContent = "";
  } else {
    els.resultTitle.textContent = winner?.id === state.clientId ? "승리" : `${winner?.nickname || "상대"} 승리`;
    els.resultTitle.style.color = "";
    els.rematchButton.classList.remove("hidden");
    els.rematchButton.disabled = false;
    els.rematchStatusText.textContent = "";
  }
  els.resultStats.innerHTML = (match.result?.players || []).map((player) => `
    <div class="result-card ${player.id === match.result?.winnerId ? "winner" : ""}">
      <h3>${escapeHtml(player.nickname)}</h3>
      <p>${player.score}점</p>
      <p>정답 ${player.correct}/${player.answered} · 정답률 ${player.accuracy}%</p>
      <p>평균 ${formatMs(player.averageMs)}</p>
    </div>
  `).join("");
  renderResultReview(match);
  playSound(mode === "practice" ? "complete" : "finish");

}

function renderResultReview(match) {
  const submittedByIndex = new Map(match.me.submissions.map((submission) => [submission.index, submission]));
  const opponentSubmittedByIndex = match.opponent ? new Map(match.opponent.submissions.map((submission) => [submission.index, submission])) : null;
  const isDuel = Boolean(match.opponent);

  els.resultReview.innerHTML = `
    <h3>풀이 상세 비교</h3>
    <div class="review-list">
      ${match.questions.map((question, index) => {
        const mySub = submittedByIndex.get(index);
        const myCorrect = Boolean(mySub?.correct);
        const oppSub = opponentSubmittedByIndex ? opponentSubmittedByIndex.get(index) : null;
        const oppCorrect = Boolean(oppSub?.correct);

        if (isDuel) {
          return `
            <div class="review-item ${myCorrect ? "correct" : "wrong"}">
              <div class="review-head">
                <strong>Q${index + 1}. ${escapeHtml(question.title)}</strong>
                <div class="review-badges">
                  <span class="${myCorrect ? "tag-ok" : "tag-miss"}">${escapeHtml(match.me.nickname)}: ${myCorrect ? "O" : "X"} (${mySub?.score || 0}점)</span>
                  <span class="${oppCorrect ? "tag-ok" : "tag-miss"}">${escapeHtml(match.opponent.nickname)}: ${oppCorrect ? "O" : "X"} (${oppSub?.score || 0}점)</span>
                </div>
              </div>
              <p>${escapeHtml(question.prompt)}</p>
              <div class="review-answers-grid">
                <div class="ans-col mine ${myCorrect ? "col-ok" : "col-miss"}">
                  <span class="ans-label">내 답 (${escapeHtml(match.me.nickname)})</span>
                  <strong class="ans-val">${escapeHtml(mySub?.answer || "-")}</strong>
                </div>
                <div class="ans-col opponent ${oppCorrect ? "col-ok" : "col-miss"}">
                  <span class="ans-label">상대 답 (${escapeHtml(match.opponent.nickname)})</span>
                  <strong class="ans-val">${escapeHtml(oppSub?.answer || "-")}</strong>
                </div>
                <div class="ans-col target">
                  <span class="ans-label">정답</span>
                  <strong class="ans-val">${escapeHtml(question.answer || "공개 대기")}</strong>
                </div>
              </div>
            </div>
          `;
        } else {
          return `
            <div class="review-item ${myCorrect ? "correct" : "wrong"}">
              <div class="review-head">
                <strong>Q${index + 1}. ${escapeHtml(question.title)}</strong>
                <span class="${myCorrect ? "tag-ok" : "tag-miss"}">${myCorrect ? "정답" : "오답"} (${mySub?.score || 0}점)</span>
              </div>
              <p>${escapeHtml(question.prompt)}</p>
              <div class="review-answers-grid solo">
                <div class="ans-col mine ${myCorrect ? "col-ok" : "col-miss"}">
                  <span class="ans-label">내 답</span>
                  <strong class="ans-val">${escapeHtml(mySub?.answer || "-")}</strong>
                </div>
                <div class="ans-col target">
                  <span class="ans-label">정답</span>
                  <strong class="ans-val">${escapeHtml(question.answer || "공개 대기")}</strong>
                </div>
              </div>
            </div>
          `;
        }
      }).join("")}
    </div>
  `;
}

function formatMs(ms) {
  return `${(ms / 1000).toFixed(1)}초`;
}

function unlockAudio() {
  if (!state.soundEnabled || state.audioContext) return;
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;
  state.audioContext = new AudioContext();
}

function beep(frequency, duration, type = "square", gainValue = 0.035, delay = 0) {
  if (!state.soundEnabled || !state.audioContext) return;
  const start = state.audioContext.currentTime + delay;
  const oscillator = state.audioContext.createOscillator();
  const gain = state.audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(state.audioContext.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

function playSound(name) {
  if (!state.soundEnabled) return;
  unlockAudio();
  if (name === "button") beep(320, 0.06, "triangle", 0.025);
  if (name === "queue") {
    beep(220, 0.08, "square");
    beep(330, 0.1, "square", 0.03, 0.08);
  }
  if (name === "start") {
    beep(392, 0.08, "sawtooth");
    beep(523, 0.08, "sawtooth", 0.035, 0.08);
    beep(784, 0.14, "sawtooth", 0.04, 0.16);
  }
  if (name === "correct") {
    beep(660, 0.07, "triangle");
    beep(990, 0.09, "triangle", 0.04, 0.07);
  }
  if (name === "wrong") beep(140, 0.16, "sawtooth", 0.035);
  if (name === "finish" || name === "complete") {
    beep(523, 0.08, "triangle");
    beep(659, 0.08, "triangle", 0.035, 0.08);
    beep(784, 0.16, "triangle", 0.04, 0.16);
  }
}

async function join() {
  const nickname = els.nickname.value.trim();
  if (!nickname) return;
  try {
    await api("/api/join", { clientId: state.clientId, nickname });
  } catch (error) {
    alert(error.message || "입장에 실패했습니다.");
    return;
  }
  state.nickname = nickname;
  localStorage.setItem("subnetDuelNickname", nickname);
  sessionStorage.setItem("subnetDuelNickname", nickname);
  els.helloName.textContent = `${nickname}, 출격 준비 완료`;
  els.chatInput.disabled = false;
  els.chatForm.querySelector("button").disabled = false;
  connectEvents();
  show(els.lobbyPanel);
}

els.joinForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  unlockAudio();
  playSound("button");
  await join();
});

els.matchButton.addEventListener("click", async () => {
  unlockAudio();
  if (els.matchButton.dataset.queue === "true") {
    await api("/api/cancel", { clientId: state.clientId });
    els.matchButton.dataset.queue = "false";
    els.matchButton.querySelector("span").textContent = "경쟁 매칭";
    els.matchButton.querySelector("strong").textContent = "난이도 선택 대결";
    els.statusPill.textContent = "온라인";
    playSound("button");
    return;
  }
  await api("/api/match", { clientId: state.clientId });
  els.matchButton.dataset.queue = "true";
  els.matchButton.querySelector("span").textContent = "매칭 취소";
  els.matchButton.querySelector("strong").textContent = "상대를 찾는 중";
  els.statusPill.textContent = "상대 탐색 중";
  playSound("queue");
});

els.practiceButton.addEventListener("click", () => {
  unlockAudio();
  window.pendingMode = "practice";
  const modal = document.querySelector("#difficultyModal");
  // 솔로 모드: solo-only 버튼 표시, 커스텀 패널 숨기기
  modal.querySelectorAll(".solo-only").forEach(b => b.classList.remove("hidden"));
  document.querySelector("#customRangePanel").classList.add("hidden");
  document.querySelector("#rouletteContainer").classList.add("hidden");
  modal.classList.remove("hidden");
});

document.querySelectorAll(".difficulty-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const mode = btn.dataset.mode;
    playSound("button");

    // 커스텀 범위 버튼: 패널 열기만 하고 시작하지 않음
    if (mode === "custom") {
      document.querySelector("#customRangePanel").classList.remove("hidden");
      updateCustomPreview();
      return;
    }
    
    if (window.pendingMode === "practice") {
      document.querySelector("#difficultyModal").classList.add("hidden");
      document.querySelector("#customRangePanel").classList.add("hidden");
      try {
        const payload = await api("/api/practice", {
          clientId: state.clientId,
          mode: mode
        });
        els.matchButton.dataset.queue = "false";
        els.statusPill.textContent = "연습 중";
        playSound("start");
        renderMatch(payload.match, "practice");
        window.pendingMode = null;
      } catch (error) {
        document.querySelector("#difficultyModal").classList.remove("hidden");
        alert(`연습 시작 실패: ${error.message}`);
      }
    } else if (window.pendingMode === "match") {
      document.querySelector("#rouletteContainer").classList.remove("hidden");
      document.querySelector("#rouletteContainer").querySelector("p").textContent = "상대방 선택 대기 중...";
      document.querySelector("#rouletteResult").textContent = "";
      document.querySelectorAll(".difficulty-btn").forEach(b => b.disabled = true);
      
      try {
        await api("/api/match/difficulty", {
          clientId: state.clientId,
          mode: mode
        });
      } catch (error) {
        document.querySelector("#rouletteContainer").classList.add("hidden");
        document.querySelectorAll(".difficulty-btn").forEach(b => b.disabled = false);
        alert(`난이도 선택 실패: ${error.message}`);
      }
    }
  });
});

els.answerForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const isEditing = state.editingIndex !== null;
  const displayIndex = isEditing ? state.editingIndex : (state.currentMatch?.me.currentIndex ?? -1);
  const question = state.currentMatch?.questions[displayIndex] || null;
  const answer = collectAnswer(question);
  if (!answer || !state.currentMatch) return;
  configureAnswerInputs(question, true);
  const elapsedMs = Math.round(performance.now() - state.questionStartedAt);

  try {
    let result;
    if (isEditing && state.currentMode === "practice") {
      // 재제출: 기존 답 교체
      result = await api("/api/practice/resubmit", {
        clientId: state.clientId,
        targetIndex: state.editingIndex,
        answer,
        elapsedMs
      });
      state.editingIndex = null;
    } else {
      const path = state.currentMode === "practice" ? "/api/practice/answer" : "/api/answer";
      result = await api(path, {
        clientId: state.clientId,
        answer,
        elapsedMs
      });
    }

    // Tetris-like visual effects
    const me = result.match ? result.match.me : state.currentMatch.me;
    const lastSub = me.submissions[me.submissions.length - 1];

    const tileIndex = lastSub?.index ?? displayIndex;
    const tileElements = document.querySelectorAll("#myBoard .tile");
    if (tileElements[tileIndex]) {
       const tile = tileElements[tileIndex];
       if (lastSub?.correct) {
         tile.classList.add("flash-correct");
       } else {
         tile.classList.add("shake-wrong");
       }
    }

    if (lastSub?.correct) {
       const rect = els.answerForm.getBoundingClientRect();
       const effectsLayer = document.querySelector("#effectsLayer");
       const textEl = document.createElement("div");
       textEl.className = "floating-text";
       textEl.textContent = `+${lastSub.score}`;
       textEl.style.left = `${rect.left + rect.width / 2}px`;
       textEl.style.top = `${rect.top - 20}px`;
       effectsLayer.appendChild(textEl);
       setTimeout(() => textEl.remove(), 1000);
    }

    els.feedback.textContent = isEditing ? "수정 완료." : "제출 완료. 결과는 종료 후 공개됩니다.";
    playSound("button");
    state.questionStartedAt = 0;
    if (state.currentMode === "practice" && result.match) {
      renderMatch(result.match, "practice");
    }
  } catch (error) {
    els.feedback.textContent = error.message;
    configureAnswerInputs(question);
  }
});


els.chatForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = els.chatInput.value.trim();
  if (!text) return;
  els.chatInput.value = "";
  playSound("button");
  try {
    await api("/api/chat", {
      clientId: state.clientId,
      text
    });
  } catch (error) {
    renderChat([{ nickname: "SYSTEM", text: error.message }]);
  }
});

els.soundToggle.addEventListener("change", () => {
  state.soundEnabled = els.soundToggle.checked;
  localStorage.setItem("subnetDuelSound", state.soundEnabled ? "on" : "off");
  if (state.soundEnabled) playSound("button");
});

els.againButton.addEventListener("click", async () => {
  state.currentMatch = null;
  state.currentMode = "duel";
  state.questionStartedAt = 0;
  state.lastQuestionId = null;
  els.matchButton.dataset.queue = "false";
  els.matchButton.querySelector("span").textContent = "경쟁 매칭";
  els.matchButton.querySelector("strong").textContent = "랜덤 CIDR로 바로 대결";
  els.statusPill.textContent = "온라인";
  els.rematchModal.classList.add("hidden");
  els.rematchStatusText.textContent = "";
  clearAnswerInputs();
  await api("/api/cancel", { clientId: state.clientId }).catch(() => {});
  show(els.lobbyPanel);
});

els.rematchButton.addEventListener("click", async () => {
  playSound("button");
  els.rematchButton.disabled = true;
  els.rematchStatusText.textContent = "상대에게 재대결을 요청했습니다. 대기 중...";
  try {
    await api("/api/match/rematch", { clientId: state.clientId, action: "request" });
  } catch (error) {
    els.rematchStatusText.textContent = error.message;
    els.rematchButton.disabled = false;
  }
});

els.acceptRematchBtn.addEventListener("click", async () => {
  playSound("button");
  els.rematchModal.classList.add("hidden");
  try {
    await api("/api/match/rematch", { clientId: state.clientId, action: "accept" });
  } catch (error) {
    alert(`재대결 수락 실패: ${error.message}`);
  }
});

els.declineRematchBtn.addEventListener("click", async () => {
  playSound("button");
  els.rematchModal.classList.add("hidden");
  try {
    await api("/api/match/rematch", { clientId: state.clientId, action: "decline" });
  } catch (error) {
    // silence
  }
});

for (const input of [els.rangeStartInput, els.rangeEndInput]) {
  input.addEventListener("input", sanitizeIpInput);
}

async function copyTextToClipboard(text) {
  if (!text) return false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      console.warn("[Clipboard API failed, using fallback]", e);
    }
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.top = "0";
    ta.style.left = "-9999px";
    ta.style.opacity = "0";
    ta.style.pointerEvents = "none";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    ta.setSelectionRange(0, 99999);
    const success = document.execCommand("copy");
    document.body.removeChild(ta);
    return success;
  } catch (err) {
    console.error("[Copy Error]", err);
    return false;
  }
}

let isCopying = false;
async function handleCopyIp() {
  if (isCopying) return;
  const btn = $("#copyIpBtn") || els.copyIpBtn;
  const questionStem = $("#questionStem") || els.questionStem;
  if (!questionStem) return;

  const text = questionStem.textContent.trim();
  if (!text) return;

  const match = text.match(/(\d{1,3}(?:\.\d{1,3}){3})/);
  const toCopy = match ? match[1] : text;

  isCopying = true;
  const success = await copyTextToClipboard(toCopy);
  if (success && btn) {
    const originalText = "📋 복사";
    btn.textContent = "✅ 복사됨";
    btn.classList.add("copied");
    setTimeout(() => {
      btn.textContent = originalText;
      btn.classList.remove("copied");
      isCopying = false;
    }, 1500);
  } else {
    isCopying = false;
  }
}

if (els.copyIpBtn) {
  els.copyIpBtn.addEventListener("click", handleCopyIp);
}

if (state.nickname) {
  join().catch(() => {
    localStorage.removeItem("subnetDuelNickname");
  });
}

// ── 커스텀 사이더 범위 패널 ──────────────────────────────────────

function updateCustomPreview() {
  const minInput = document.querySelector("#cidrMinInput");
  const maxInput = document.querySelector("#cidrMaxInput");
  const preview = document.querySelector("#customRangePreview");
  const min = parseInt(minInput.value, 10) || 1;
  let max = parseInt(maxInput.value, 10) || 30;
  if (max < min) {
    max = min;
    maxInput.value = min;
  }
  preview.textContent = min === max
    ? `사이더 /${min} 고정`
    : `사이더 /${min} ~ /${max}`;
}

document.querySelector("#cidrMinInput").addEventListener("input", updateCustomPreview);
document.querySelector("#cidrMaxInput").addEventListener("input", updateCustomPreview);

document.querySelector("#startCustomBtn").addEventListener("click", async () => {
  const min = Math.max(1, Math.min(30, parseInt(document.querySelector("#cidrMinInput").value, 10) || 1));
  let max = Math.max(1, Math.min(30, parseInt(document.querySelector("#cidrMaxInput").value, 10) || 30));
  if (max < min) max = min;
  playSound("button");
  document.querySelector("#difficultyModal").classList.add("hidden");
  document.querySelector("#customRangePanel").classList.add("hidden");
  try {
    const payload = await api("/api/practice", {
      clientId: state.clientId,
      mode: "custom",
      cidrMin: min,
      cidrMax: max
    });
    els.matchButton.dataset.queue = "false";
    els.statusPill.textContent = "연습 중";
    playSound("start");
    renderMatch(payload.match, "practice");
    window.pendingMode = null;
  } catch (error) {
    document.querySelector("#difficultyModal").classList.remove("hidden");
    document.querySelector("#customRangePanel").classList.remove("hidden");
    alert(`연습 시작 실패: ${error.message}`);
  }
});

// ── 랭킹 시스템 (Leaderboard) ──────────────────────────────────

let currentLbTab = "duel"; // "duel" | "solo"
let currentSoloDiff = "random"; // "random" | "easy" | "medium" | "hard"

function formatLeaderboardTime(elapsedMs) {
  if (!elapsedMs || elapsedMs <= 0) return "-";
  const seconds = (elapsedMs / 1000).toFixed(2);
  return `${seconds}초`;
}

async function renderLeaderboard() {
  const lbLoading = $("#lbLoading") || els.lbLoading;
  const lbEmpty = $("#lbEmpty") || els.lbEmpty;
  const lbTbody = $("#lbTbody") || els.lbTbody;
  const lbThead = $("#lbThead") || els.lbThead;
  const soloFilterPanel = $("#soloFilterPanel") || els.soloFilterPanel;

  if (lbLoading) lbLoading.classList.remove("hidden");
  if (lbEmpty) lbEmpty.classList.add("hidden");
  if (lbTbody) lbTbody.innerHTML = "";

  try {
    if (currentLbTab === "duel") {
      if (soloFilterPanel) soloFilterPanel.classList.add("hidden");
      if (lbThead) {
        lbThead.innerHTML = `
          <tr>
            <th class="rank-col">순위</th>
            <th>콜사인 (닉네임)</th>
            <th>ELO 레이팅</th>
            <th>전적 (승/무/패)</th>
            <th>승률</th>
          </tr>
        `;
      }

      const res = await fetch("/api/leaderboard/duel");
      const data = await res.json();
      const list = data.list || [];
      if (lbLoading) lbLoading.classList.add("hidden");

      if (list.length === 0) {
        if (lbEmpty) {
          lbEmpty.textContent = "아직 등록된 경쟁전 전적이 없습니다.";
          lbEmpty.classList.remove("hidden");
        }
        return;
      }

      list.forEach((item, index) => {
        const rank = index + 1;
        const topClass = rank <= 3 ? `top-${rank}` : "";
        const isMe = item.nickname === state.nickname;
        const tr = document.createElement("tr");

        tr.innerHTML = `
          <td class="rank-col"><span class="rank-badge ${topClass}">${rank}</span></td>
          <td class="${isMe ? "nickname-highlight" : ""}">${escapeHtml(item.nickname || "")} ${isMe ? " (나)" : ""}</td>
          <td class="elo-val">⚡ ${item.elo} LP</td>
          <td>${item.wins}승 ${item.draws > 0 ? item.draws + "무 " : ""}${item.losses}패</td>
          <td>${item.winRate}%</td>
        `;
        if (lbTbody) lbTbody.appendChild(tr);
      });

    } else {
      if (soloFilterPanel) soloFilterPanel.classList.remove("hidden");
      if (lbThead) {
        lbThead.innerHTML = `
          <tr>
            <th class="rank-col">순위</th>
            <th>콜사인 (닉네임)</th>
            <th>정확도</th>
            <th>클리어 시간</th>
            <th>획득 점수</th>
          </tr>
        `;
      }

      const res = await fetch(`/api/leaderboard/solo?difficulty=${currentSoloDiff}`);
      const data = await res.json();
      const list = data.list || [];
      if (lbLoading) lbLoading.classList.add("hidden");

      if (list.length === 0) {
        if (lbEmpty) {
          lbEmpty.textContent = "아직 등록된 타임어택 기록이 없습니다.";
          lbEmpty.classList.remove("hidden");
        }
        return;
      }

      list.forEach((item, index) => {
        const rank = index + 1;
        const topClass = rank <= 3 ? `top-${rank}` : "";
        const isMe = item.nickname === state.nickname;
        const tr = document.createElement("tr");

        tr.innerHTML = `
          <td class="rank-col"><span class="rank-badge ${topClass}">${rank}</span></td>
          <td class="${isMe ? "nickname-highlight" : ""}">${escapeHtml(item.nickname || "")} ${isMe ? " (나)" : ""}</td>
          <td class="accuracy-val">🎯 ${item.accuracy}%</td>
          <td class="time-val">⏱️ ${formatLeaderboardTime(item.elapsedMs)}</td>
          <td>${item.score}점</td>
        `;
        if (lbTbody) lbTbody.appendChild(tr);
      });
    }
  } catch (err) {
    console.error("[Leaderboard Fetch Error]", err);
    if (lbLoading) lbLoading.classList.add("hidden");
    if (lbEmpty) {
      lbEmpty.textContent = "랭킹 데이터를 불러오는 중 오류가 발생했습니다.";
      lbEmpty.classList.remove("hidden");
    }
  }
}

window.switchLobbyTab = function switchLobbyTab(tabName) {
  const navTabModes = $("#navTabModes");
  const navTabRanking = $("#navTabRanking");
  const lobbyModesContent = $("#lobbyModesContent");
  const lobbyRankingContent = $("#lobbyRankingContent");

  if (tabName === "modes") {
    if (navTabModes) navTabModes.classList.add("active");
    if (navTabRanking) navTabRanking.classList.remove("active");
    if (lobbyModesContent) lobbyModesContent.classList.remove("hidden");
    if (lobbyRankingContent) lobbyRankingContent.classList.add("hidden");
  } else if (tabName === "ranking") {
    if (navTabRanking) navTabRanking.classList.add("active");
    if (navTabModes) navTabModes.classList.remove("active");
    if (lobbyRankingContent) lobbyRankingContent.classList.remove("hidden");
    if (lobbyModesContent) lobbyModesContent.classList.add("hidden");
    renderLeaderboard();
  }
};

// Click Delegation for Top Main Navigation Tabs & Leaderboard Tabs
document.addEventListener("click", (e) => {
  const modesBtn = e.target.closest("#navTabModes");
  const rankingBtn = e.target.closest("#navTabRanking");
  const tabDuelBtn = e.target.closest("#tabDuel");
  const tabSoloBtn = e.target.closest("#tabSolo");
  const soloDiffBtn = e.target.closest(".solo-diff-btn");

  if (modesBtn) {
    playSound("button");
    window.switchLobbyTab("modes");
  } else if (rankingBtn) {
    playSound("button");
    window.switchLobbyTab("ranking");
  } else if (tabDuelBtn) {
    playSound("button");
    currentLbTab = "duel";
    const tabSolo = $("#tabSolo");
    tabDuelBtn.classList.add("active");
    if (tabSolo) tabSolo.classList.remove("active");
    renderLeaderboard();
  } else if (tabSoloBtn) {
    playSound("button");
    currentLbTab = "solo";
    const tabDuel = $("#tabDuel");
    tabSoloBtn.classList.add("active");
    if (tabDuel) tabDuel.classList.remove("active");
    renderLeaderboard();
  } else if (soloDiffBtn) {
    playSound("button");
    document.querySelectorAll(".solo-diff-btn").forEach((b) => b.classList.remove("active"));
    soloDiffBtn.classList.add("active");
    currentSoloDiff = soloDiffBtn.dataset.diff;
    renderLeaderboard();
  }
});
