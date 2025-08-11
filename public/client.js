const qs = new URLSearchParams(location.search);
const roomId = qs.get('room');
const password = qs.get('pw') || "";
const nick = qs.get('nick') || "";
const isAdmin = qs.get('admin') === '1';
const spectator = qs.get('spectator') === '1';

const playersEl = document.getElementById('players');
const roomInfoEl = document.getElementById('roomInfo');
const lobbyEl = document.getElementById('lobby');
const qView = document.getElementById('questionView');
const qIndexEl = document.getElementById('qIndex');
const qCatEl = document.getElementById('qCat');
const qTextEl = document.getElementById('qText');
const optsEl = document.getElementById('opts');
const timerEl = document.getElementById('timer');
const resultView = document.getElementById('resultView');
const correctEl = document.getElementById('correct');
const winnerEl = document.getElementById('winner');
const gameOverView = document.getElementById('gameOverView');
const finalBoardEl = document.getElementById('finalBoard');
const adminPanel = document.getElementById('adminPanel');
const startBtn = document.getElementById('startBtn');

// Paramok ellenőrzése: spectatornál NEM kell nick
if (!roomId || !password || (!nick && !spectator)) {
  alert("Hiányzó paraméterek. Menj vissza a főoldalra.");
  location.href = "/";
}

roomInfoEl.textContent = `Szoba: ${roomId} • Belépve: ${spectator ? "spectator" : nick} ${isAdmin ? "(admin)" : ""}`;

let ws;
let answeredThisRound = false;
let countdownInterval = null;

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: "join", roomId, password, nick, isAdmin, spectator }));
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "error") {
      alert(msg.error || "Hiba");
      location.href = "/";
      return;
    }
    if (msg.type === "joined") {
      renderLobby(msg.room);
      if (msg.you?.isAdmin && !spectator) adminPanel.classList.remove('hide');
      if (spectator) adminPanel.classList.add('hide'); // spectator ne indítson játékot
    }
    if (msg.type === "lobbyUpdate") {
      renderLobby(msg.room);
    }
    if (msg.type === "question") {
      showQuestion(msg);
    }
    if (msg.type === "roundResult") {
      showRoundResult(msg);
    }
    if (msg.type === "gameOver") {
      showGameOver(msg);
    }
  };
  ws.onclose = () => {
    roomInfoEl.textContent += " • (kapcsolat bontva)";
  };
}
connectWS();

function renderLobby(room) {
  const list = (room.players || [])
    .sort((a, b) => b.score - a.score)
    .map(p => `<li><b>${escapeHtml(p.nick)}</b><span>${p.score}</span></li>`)
    .join("");
  playersEl.innerHTML = list || "<li>(még senki)</li>";

  if (!room.game?.running || room.game?.questionIndex < 0) {
    lobbyEl.classList.remove('hide');
    qView.classList.add('hide');
    resultView.classList.add('hide');
    gameOverView.classList.add('hide');
  }
}

function showQuestion(m) {
  answeredThisRound = false;

  lobbyEl.classList.add('hide');
  resultView.classList.add('hide');
  gameOverView.classList.add('hide');
  qView.classList.remove('hide');

  qIndexEl.textContent = `Kérdés ${m.index}/${m.total}`;
  qCatEl.textContent = m.category;
  qTextEl.textContent = m.question;
  optsEl.innerHTML = "";
  ["A","B","C","D"].forEach((key, i) => {
    const btn = document.createElement('button');
    btn.textContent = m.options[i];
    btn.className = "opt";
    if (!spectator) {
      btn.onclick = () => submitAnswer(key, btn);
    } else {
      btn.disabled = true; // spectator csak néz
    }
    optsEl.appendChild(btn);
  });

  startCountdown(m.timeLimitSec);
}

function startCountdown(sec) {
  clearInterval(countdownInterval);
  let left = sec;
  timerEl.textContent = left;
  countdownInterval = setInterval(() => {
    left -= 1;
    timerEl.textContent = Math.max(0, left);
    if (left <= 0) clearInterval(countdownInterval);
  }, 1000);
}

function submitAnswer(option, btn) {
  if (spectator) return; // biztonság kedvéért
  if (answeredThisRound) return;
  answeredThisRound = true;

  // vizu: disable minden opció, jelöld a választ
  Array.from(document.querySelectorAll('.opt')).forEach(el => el.disabled = true);
  btn.classList.add('chosen');

  ws.send(JSON.stringify({ type: "submitAnswer", option }));
}

function showRoundResult(m) {
  qView.classList.add('hide');
  resultView.classList.remove('hide');

  correctEl.textContent = m.correct;
  winnerEl.textContent = m.winner || "senki";
  const list = (m.scoreboard || [])
    .sort((a, b) => b.score - a.score)
    .map(p => `<li><b>${escapeHtml(p.nick)}</b><span>${p.score}</span></li>`)
    .join("");
  playersEl.innerHTML = list;
}

function showGameOver(m) {
  qView.classList.add('hide');
  resultView.classList.add('hide');
  gameOverView.classList.remove('hide');
  finalBoardEl.innerHTML = (m.scoreboard || [])
    .map(p => `<li><b>${escapeHtml(p.nick)}</b> – ${p.score} pont</li>`)
    .join("");
}

if (startBtn) {
  startBtn.onclick = () => {
    if (spectator) return; // spectator nem indít
    ws.send(JSON.stringify({ type: "startGame" }));
  };
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
