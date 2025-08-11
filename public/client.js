// public/client.js – szoba nézet (room.html)

const qs = new URLSearchParams(location.search);
const roomId = qs.get('room');
const password = qs.get('pw') || "";
const nick = qs.get('nick') || "";
const isAdmin = qs.get('admin') === '1';
const spectator = qs.get('spectator') === '1';

// DOM
const playersEl    = document.getElementById('players');
const roomInfoEl   = document.getElementById('roomInfo');
const lobbyEl      = document.getElementById('lobby');
const qView        = document.getElementById('questionView');
const qIndexEl     = document.getElementById('qIndex');
const qCatEl       = document.getElementById('qCat');
const qTextEl      = document.getElementById('qText');
const optsEl       = document.getElementById('opts');
const timerEl      = document.getElementById('timer');
const resultView   = document.getElementById('resultView');
const correctEl    = document.getElementById('correct');
const winnerEl     = document.getElementById('winner');
const gameOverView = document.getElementById('gameOverView');
const finalBoardEl = document.getElementById('finalBoard');
const adminPanel   = document.getElementById('adminPanel');
const startBtn     = document.getElementById('startBtn');
const rematchStartBtn = document.getElementById('rematchStartBtn');
const rematchButtons  = document.getElementById('rematchButtons');
const rematchYes      = document.getElementById('rematchYes');
const rematchNo       = document.getElementById('rematchNo');
const rematchInfo     = document.getElementById('rematchInfo');

if (!roomId || (!spectator && (!password || !nick))) {
  alert("Hiányzó paraméterek. Menj vissza a főoldalra.");
  location.href = "/";
}

roomInfoEl && (roomInfoEl.textContent = `Szoba: ${roomId} • Belépve: ${spectator ? "spectator" : nick} ${isAdmin ? "(admin)" : ""}`);

let ws;
let answeredThisRound = false;
let chosenBtn = null;
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
      alert(msg.error || "Hiba"); location.href = "/"; return;
    }
    if (msg.type === "joined") {
      renderLobby(msg.room);
      toggleAdminButtons(msg.room);
    }
    if (msg.type === "lobbyUpdate") {
      renderLobby(msg.room);
      toggleAdminButtons(msg.room);
    }
    if (msg.type === "question") {
      showQuestion(msg);
      toggleAdminButtons({ game:{ running:true }});
    }
    if (msg.type === "roundResult") {
      showRoundResult(msg);
    }
    if (msg.type === "gameOver") {
      showGameOver(msg);
      toggleAdminButtons({ game:{ running:false }});
    }
    if (msg.type === "rematchOffer") {
      // admin kért visszavágót → jelenjen meg az Igen/Nem UI
      showRematchPrompt();
    }
  };
  ws.onclose = () => {
    roomInfoEl && (roomInfoEl.textContent += " • (kapcsolat bontva)");
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

function toggleAdminButtons(roomLike) {
  if (!adminPanel) return;
  const running = !!roomLike?.game?.running;
  if (startBtn) {
    startBtn.disabled = running; // forduló közben inaktív
    startBtn.title = running ? "Játék már fut" : "";
  }
  if (rematchStartBtn) {
    // csak meccs végén legyen értelme mutatni
    rematchStartBtn.classList.toggle('hide', running);
    rematchStartBtn.onclick = () => ws?.send(JSON.stringify({ type: "requestRematch" }));
  }
}

function showQuestion(m) {
  answeredThisRound = false;
  chosenBtn = null;

  lobbyEl.classList.add('hide');
  resultView.classList.add('hide');
  gameOverView.classList.add('hide');
  qView.classList.remove('hide');

  qIndexEl.textContent = `Kérdés ${m.index}/${m.total}`;
  qCatEl.textContent   = m.category;
  qTextEl.textContent  = m.question;

  optsEl.innerHTML = "";
  ["A","B","C","D"].forEach((key, i) => {
    const btn = document.createElement('button');
    btn.textContent = m.options[i];
    btn.className = "opt";
    btn.dataset.letter = key;
    if (!spectator) {
      btn.onclick = () => submitAnswer(key, btn);
    } else {
      btn.disabled = true;
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
  if (spectator || answeredThisRound) return;
  answeredThisRound = true;
  chosenBtn = btn;

  document.querySelectorAll('.opt').forEach(el => el.disabled = true);
  btn.classList.add('chosen');

  ws?.send(JSON.stringify({ type: "submitAnswer", option }));
}

function showRoundResult(m) {
  const correct = m.correct; // 'A'/'B'/'C'/'D'
  const all = Array.from(document.querySelectorAll('.opt'));
  const correctBtn = all.find(b => b.dataset.letter === correct);
  if (correctBtn) correctBtn.classList.add('blink-correct'); // 4 villanás / 1s

  if (chosenBtn) {
    if (chosenBtn.dataset.letter === correct) {
      chosenBtn.classList.add('blink-good');
    } else {
      chosenBtn.classList.add('blink-bad'); // piros villogás
    }
  }

  setTimeout(() => {
    qView.classList.add('hide');
    resultView.classList.remove('hide');

    correctEl.textContent = m.correct;
    winnerEl.textContent  = m.winner || "senki";
    const list = (m.scoreboard || [])
      .sort((a, b) => b.score - a.score)
      .map(p => `<li><b>${escapeHtml(p.nick)}</b><span>${p.score}</span></li>`)
      .join("");
    playersEl.innerHTML = list;
  }, 1000);
}

function showGameOver(m) {
  qView.classList.add('hide');
  resultView.classList.add('hide');
  gameOverView.classList.remove('hide');

  finalBoardEl.innerHTML = (m.scoreboard || [])
    .map(p => `<li><b>${escapeHtml(p.nick)}</b> – ${p.score} pont</li>`)
    .join("");

  // meccs végén alapból csak üzenet — admin "Visszavágót kérek" gombra küld "rematchOffer"-t
  if (rematchButtons) rematchButtons.classList.add('hide');
  if (rematchInfo) rematchInfo.textContent = "Az admin kérhet visszavágót.";
}

function showRematchPrompt() {
  if (spectator) {
    rematchButtons?.classList.add('hide');
    rematchInfo && (rematchInfo.textContent = "Spectator módban nincs szavazás.");
    return;
  }
  if (rematchButtons) rematchButtons.classList.remove('hide');
  if (rematchInfo) rematchInfo.textContent = "Visszavágó? Válassz!";

  if (rematchYes) rematchYes.onclick = () => {
    ws?.send(JSON.stringify({ type: "rematchVote", accept: true }));
    rematchButtons?.classList.add('hide');
    if (rematchInfo) rematchInfo.textContent = "Szavazat elküldve. Várakozás a többiekre…";
  };
  if (rematchNo) rematchNo.onclick = () => {
    ws?.send(JSON.stringify({ type: "rematchVote", accept: false }));
    location.href = "/";
  };
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// admin start
startBtn && (startBtn.onclick = () => {
  if (spectator || startBtn.disabled) return;
  ws?.send(JSON.stringify({ type: "startGame" }));
});
