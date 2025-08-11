// public/client.js – kizárólag a SZOBA nézethez (room.html)

const qs = new URLSearchParams(location.search);
const roomId = qs.get('room');
const password = qs.get('pw') || "";
const nick = qs.get('nick') || "";
const isAdmin = qs.get('admin') === '1';
const spectator = qs.get('spectator') === '1';

// --- DOM elemek a room.html-ből ---
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

// --- alap ellenőrzés ---
if (!roomId || (!spectator && (!password || !nick))) {
  alert("Hiányzó paraméterek. Menj vissza a főoldalra.");
  location.href = "/";
}

// státusz
roomInfoEl && (roomInfoEl.textContent = `Szoba: ${roomId} • Belépve: ${spectator ? "spectator" : nick} ${isAdmin ? "(admin)" : ""}`);

let ws;
let answeredThisRound = false;
let chosenBtn = null;
let countdownInterval = null;

// --- WS kapcsolat ---
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
      if (msg.you?.isAdmin && !spectator) adminPanel?.classList.remove('hide');
      if (spectator) adminPanel?.classList.add('hide');
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
    if (roomInfoEl) roomInfoEl.textContent += " • (kapcsolat bontva)";
  };
}
connectWS();

// --- Lobby render ---
function renderLobby(room) {
  if (playersEl) {
    const list = (room.players || [])
      .sort((a, b) => b.score - a.score)
      .map(p => `<li><b>${escapeHtml(p.nick)}</b><span>${p.score}</span></li>`)
      .join("");
    playersEl.innerHTML = list || "<li>(még senki)</li>";
  }

  if (!room.game?.running || room.game?.questionIndex < 0) {
    lobbyEl?.classList.remove('hide');
    qView?.classList.add('hide');
    resultView?.classList.add('hide');
    gameOverView?.classList.add('hide');
  }
}

// --- Kérdés megjelenítés ---
function showQuestion(m) {
  answeredThisRound = false;
  chosenBtn = null;

  lobbyEl?.classList.add('hide');
  resultView?.classList.add('hide');
  gameOverView?.classList.add('hide');
  qView?.classList.remove('hide');

  if (qIndexEl) qIndexEl.textContent = `Kérdés ${m.index}/${m.total}`;
  if (qCatEl)   qCatEl.textContent   = m.category;
  if (qTextEl)  qTextEl.textContent  = m.question;

  if (optsEl) {
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
  }

  startCountdown(m.timeLimitSec);
}

// --- időzítő ---
function startCountdown(sec) {
  clearInterval(countdownInterval);
  let left = sec;
  if (timerEl) timerEl.textContent = left;
  countdownInterval = setInterval(() => {
    left -= 1;
    if (timerEl) timerEl.textContent = Math.max(0, left);
    if (left <= 0) clearInterval(countdownInterval);
  }, 1000);
}

// --- válasz küldése ---
function submitAnswer(option, btn) {
  if (spectator) return;
  if (answeredThisRound) return;
  answeredThisRound = true;
  chosenBtn = btn;

  // disable minden opció, jelöld a választ
  document.querySelectorAll('.opt').forEach(el => el.disabled = true);
  btn.classList.add('chosen');

  ws?.send(JSON.stringify({ type: "submitAnswer", option }));
}

// --- kör végeredmény + 1 mp villogás ---
function showRoundResult(m) {
  const correct = m.correct; // 'A' | 'B' | 'C' | 'D'
  const all = Array.from(document.querySelectorAll('.opt'));
  const correctBtn = all.find(b => b.dataset.letter === correct);
  if (correctBtn) correctBtn.classList.add('blink-correct');

  if (chosenBtn) {
    if (chosenBtn.dataset.letter === correct) {
      chosenBtn.classList.add('blink-good');
    } else {
      chosenBtn.classList.add('blink-bad');
    }
  }

  setTimeout(() => {
    qView?.classList.add('hide');
    resultView?.classList.remove('hide');

    if (correctEl) correctEl.textContent = m.correct;
    if (winnerEl)  winnerEl.textContent  = m.winner || "senki";
    if (playersEl) {
      const list = (m.scoreboard || [])
        .sort((a, b) => b.score - a.score)
        .map(p => `<li><b>${escapeHtml(p.nick)}</b><span>${p.score}</span></li>`)
        .join("");
      playersEl.innerHTML = list;
    }
  }, 1000);
}

// --- játék vége ---
function showGameOver(m) {
  qView?.classList.add('hide');
  resultView?.classList.add('hide');
  gameOverView?.classList.remove('hide');

  if (finalBoardEl) {
    finalBoardEl.innerHTML = (m.scoreboard || [])
      .map(p => `<li><b>${escapeHtml(p.nick)}</b> – ${p.score} pont</li>`)
      .join("");
  }

  // Rematch gomb az admin panelen (opcionális – szerver automatikusan is indulhat, ha mindenki igent adott)
  const rematchStartBtn = document.getElementById('rematchStartBtn');
  if (isAdmin && !spectator && rematchStartBtn) {
    rematchStartBtn.classList.remove('hide');
    rematchStartBtn.onclick = () => ws?.send(JSON.stringify({ type: "startGame" }));
  }

  // Játékos szavazó gombok (ha vannak a room.html-ben)
  const remYes = document.getElementById('rematchYes');
  const remNo  = document.getElementById('rematchNo');
  const remInfo= document.getElementById('rematchInfo');
  const remBox = document.getElementById('rematchButtons');

  if (!spectator && remYes && remNo) {
    remYes.onclick = () => {
      ws?.send(JSON.stringify({ type: "rematchVote", accept: true }));
      if (remInfo) remInfo.textContent = "Szavazat elküldve. Várakozás a többiekre…";
      remBox?.classList.add('hide');
    };
    remNo.onclick = () => {
      ws?.send(JSON.stringify({ type: "rematchVote", accept: false }));
      location.href = "/";
    };
  } else {
    remBox?.classList.add('hide');
    if (remInfo) remInfo.textContent = "Spectator módban nincs szavazás.";
  }
}

// --- admin start ---
startBtn && (startBtn.onclick = () => {
  if (spectator) return;
  ws?.send(JSON.stringify({ type: "startGame" }));
});

// --- util ---
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
