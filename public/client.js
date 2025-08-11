// public/client.js
let ws;
let roomId, password, nick, isAdmin = false, spectator = false;

const roomListBody = document.getElementById("roomListBody");
const createRoomForm = document.getElementById("createRoomForm");
const adminNickInput = document.getElementById("adminNick");
const roomPasswordInput = document.getElementById("roomPassword");

const lobbySection = document.getElementById("lobbySection");
const gameSection = document.getElementById("gameSection");
const scoreSection = document.getElementById("scoreSection");

const roomIdLabel = document.getElementById("roomIdLabel");
const adminNameLabel = document.getElementById("adminName");
const playerList = document.getElementById("playerList");
const lobbyButtons = document.getElementById("lobbyButtons");

const qIndex = document.getElementById("qIndex");
const qTotal = document.getElementById("qTotal");
const qCategory = document.getElementById("qCategory");
const qText = document.getElementById("qText");
const optionsDiv = document.getElementById("options");
const timerDiv = document.getElementById("timer");

const scoreList = document.getElementById("scoreList");
const rematchArea = document.getElementById("rematchArea");

async function fetchRooms() {
  const res = await fetch("/api/rooms");
  const rooms = await res.json();
  roomListBody.innerHTML = "";
  rooms.forEach(r => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.id}</td>
      <td>${r.admin}</td>
      <td>${r.players}</td>
      <td>${r.running ? "Játékban" : "Várakozik"}</td>
      <td>
        <button onclick="joinRoomPrompt('${r.id}', ${r.running})">Csatlakozás</button>
        <button onclick="spectateRoom('${r.id}')">Spectator</button>
      </td>
    `;
    roomListBody.appendChild(tr);
  });
}
setInterval(fetchRooms, 3000);
fetchRooms();

createRoomForm.addEventListener("submit", async e => {
  e.preventDefault();
  nick = adminNickInput.value.trim();
  password = roomPasswordInput.value.trim();
  if (!nick || !password) return alert("Adj meg minden mezőt!");
  const res = await fetch("/api/createRoom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password, adminNick: nick })
  });
  const data = await res.json();
  if (data.error) return alert(data.error);
  roomId = data.roomId;
  isAdmin = true;
  connectWS();
});

function joinRoomPrompt(id, running) {
  if (running) return alert("A játék már elindult, csak spectator módban lehet csatlakozni.");
  const name = prompt("Add meg a nickneved:");
  if (!name) return;
  const pass = prompt("Add meg a szoba jelszavát:");
  if (!pass) return;
  nick = name;
  password = pass;
  roomId = id;
  fetch("/api/join", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ roomId, password, nick })
  }).then(r => r.json()).then(d => {
    if (d.error) return alert(d.error);
    connectWS();
  });
}

function spectateRoom(id) {
  spectator = true;
  nick = null;
  password = prompt("Add meg a szoba jelszavát (spectatorhoz is kell):");
  if (!password) return;
  roomId = id;
  connectWS();
}

function connectWS() {
  ws = new WebSocket(location.origin.replace(/^http/, "ws"));
  ws.onopen = () => {
    ws.send(JSON.stringify({
      type: "join",
      roomId, password, nick, isAdmin, spectator
    }));
  };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    if (msg.type === "error") return alert(msg.error);
    if (msg.type === "joined") showLobby(msg.room);
    if (msg.type === "lobbyUpdate") showLobby(msg.room);
    if (msg.type === "question") showQuestion(msg);
    if (msg.type === "roundResult") showRoundResult(msg);
    if (msg.type === "gameOver") showGameOver(msg);
  };
}

function showLobby(room) {
  lobbySection.style.display = "block";
  gameSection.style.display = "none";
  scoreSection.style.display = "none";
  roomIdLabel.textContent = room.id;
  adminNameLabel.textContent = room.admin;
  playerList.innerHTML = "";
  room.players.forEach(p => {
    const li = document.createElement("li");
    li.textContent = `${p.nick} (${p.score})`;
    playerList.appendChild(li);
  });
  lobbyButtons.innerHTML = "";
  if (isAdmin) {
    const startBtn = document.createElement("button");
    startBtn.textContent = "Játék indítása";
    startBtn.onclick = () => ws.send(JSON.stringify({ type: "startGame" }));
    lobbyButtons.appendChild(startBtn);
  }
}

function showQuestion(msg) {
  lobbySection.style.display = "none";
  gameSection.style.display = "block";
  scoreSection.style.display = "none";
  qIndex.textContent = msg.index;
  qTotal.textContent = msg.total;
  qCategory.textContent = msg.category;
  qText.textContent = msg.question;
  optionsDiv.innerHTML = "";
  ["A", "B", "C", "D"].forEach((letter, idx) => {
    const btn = document.createElement("button");
    btn.textContent = `${letter}: ${msg.options[idx]}`;
    btn.onclick = () => {
      ws.send(JSON.stringify({ type: "submitAnswer", option: letter }));
    };
    optionsDiv.appendChild(btn);
  });
  startTimer(msg.timeLimitSec);
}

function startTimer(sec) {
  let remain = sec;
  timerDiv.textContent = remain;
  const intv = setInterval(() => {
    remain--;
    timerDiv.textContent = remain;
    if (remain <= 0) clearInterval(intv);
  }, 1000);
}

function showRoundResult(msg) {
  const correctBtn = Array.from(optionsDiv.children).find(b => b.textContent.startsWith(msg.correct));
  if (correctBtn) flashBorder(correctBtn, "green");
}

function flashBorder(elem, color) {
  let state = false;
  const intv = setInterval(() => {
    elem.style.border = state ? `3px solid ${color}` : "3px solid transparent";
    state = !state;
  }, 200);
  setTimeout(() => {
    clearInterval(intv);
    elem.style.border = "";
  }, 1000);
}

function showGameOver(msg) {
  lobbySection.style.display = "none";
  gameSection.style.display = "none";
  scoreSection.style.display = "block";
  scoreList.innerHTML = "";
  msg.scoreboard.forEach(s => {
    const li = document.createElement("li");
    li.textContent = `${s.nick}: ${s.score}`;
    scoreList.appendChild(li);
  });
  rematchArea.innerHTML = "";
  if (isAdmin) {
    const rematchBtn = document.createElement("button");
    rematchBtn.textContent = "Újraindítás (Rematch)";
    rematchBtn.onclick = () => ws.send(JSON.stringify({ type: "rematchVote" }));
    rematchArea.appendChild(rematchBtn);
  } else {
    const acceptBtn = document.createElement("button");
    acceptBtn.textContent = "Elfogadom a Rematch-et";
    acceptBtn.onclick = () => ws.send(JSON.stringify({ type: "rematchVote" }));
    rematchArea.appendChild(acceptBtn);
  }
}
