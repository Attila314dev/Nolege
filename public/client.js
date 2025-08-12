// room nézet kliens

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
const roundInfoBox = document.getElementById('roundInfo'); // dinamikusan létrehozva, ha nincs

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
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", roomId, password, nick, isAdmin, spectator }));
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === "error") { alert(msg.error || "Hiba"); location.href = "/"; return; }
    if (msg.type === "joined" || msg.type === "lobbyUpdate") { renderLobby(msg.room); toggleAdminButtons(msg.room); }
    if (msg.type === "question") { showQuestion(msg); toggleAdminButtons({ game:{ running:true }}); }
    if (msg.type === "roundResult") { showRoundResult(msg); }
    if (msg.type === "gameOver") { showGameOver(msg); toggleAdminButtons({ game:{ running:false }}); }
  };
  ws.onclose = () => { roomInfoEl && (roomInfoEl.textContent += " • (kapcsolat bontva)"); };
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

  // csak admin lássa
  if (!isAdmin || spectator) {
    adminPanel.classList.add('hide');
    return;
  } else {
    adminPanel.classList.remove('hide');
  }

  // blur + tiltás futás közben
  adminPanel.classList.toggle('disabled-blur', running);
  if (startBtn) {
    startBtn.disabled = running;
    startBtn.title = running ? "A játék fut – új játék indítása csak a végén" : "";
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

  // minden opció letilt
  document.querySelectorAll('.opt').forEach(el => el.disabled = true);
  // narancssárga keret a saját tippre
  btn.classList.add('chosen-orange');

  ws?.send(JSON.stringify({ type: "submitAnswer", option }));
}

function showRoundResult(m) {
  const correct = m.correct; // 'A'/'B'/'C'/'D'
  const all = Array.from(document.querySelectorAll('.opt'));
  const correctBtn = all.find(b => b.dataset.letter === correct);

  // helyes gomb 1s/4 villanás zölddel
  if (correctBtn) correctBtn.classList.add('blink-correct');

  // saját tipp: zöld/piros villogás, majd stabil keret
  if (chosenBtn) {
    if (chosenBtn.dataset.letter === correct) {
      chosenBtn.classList.add('blink-good');
      setTimeout(() => { chosenBtn.classList.remove('chosen-orange','blink-good'); chosenBtn.classList.add('result-good'); }, 1000);
    } else {
      chosenBtn.classList.add('blink-bad');
      setTimeout(() => { chosenBtn.classList.remove('chosen-orange','blink-bad'); chosenBtn.classList.add('result-bad'); }, 1000);
    }
  }

  // 1s villogás után 2s infópanel
  setTimeout(() => {
    qView.classList.add('hide');
    resultView.classList.remove('hide');

    correctEl.textContent = m.correct;
    winnerEl.textContent  = m.winner || "senki";

    // scoreboard
    const list = (m.scoreboard || [])
      .sort((a, b) => b.score - a.score)
      .map(p => `<li><b>${escapeHtml(p.nick)}</b><span>${p.score}</span></li>`)
      .join("");
    playersEl.innerHTML = list;

    // részletes körinfo (idő + pont)
    let info = document.getElementById('roundInfo');
    if (!info) {
      info = document.createElement('div');
      info.id = 'roundInfo';
      info.className = 'round-info';
      resultView.appendChild(info);
    }
    const rows = (m.details || []).map(d => {
      const t = (d.timeMs==null) ? "—" : (d.timeMs/1000).toFixed(3)+"s";
      const mark = d.isCorrect ? "✔" : (d.timeMs==null ? "—" : "✖");
      return `<div class="rowline"><span class="nm">${escapeHtml(d.nick)}</span><span>${t}</span><span>${mark}</span><span>+${d.points}</span></div>`;
    }).join("");
    info.innerHTML = `
      <div class="rowline head"><span class="nm">Játékos</span><span>Idő</span><span>Helyes</span><span>Pont</span></div>
      ${rows}
      <div class="small mono">Következő kérdés mindjárt érkezik…</div>
    `;
  }, 1000);
}

function showGameOver(m) {
  qView.classList.add('hide');
  resultView.classList.add('hide');
  gameOverView.classList.remove('hide');

  finalBoardEl.innerHTML = (m.scoreboard || [])
    .map(p => `<li><b>${escapeHtml(p.nick)}</b> – ${p.score} pont</li>`)
    .join("");
}

startBtn && (startBtn.onclick = () => {
  if (spectator || startBtn.disabled) return;
  ws?.send(JSON.stringify({ type: "startGame" }));
});

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
