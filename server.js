// server.js
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public"))); // statikus fájlok biztosan

// Gyökér -> index.html
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Kérdések beolvasása abszolút úttal (Render-safe)
const questionsPath = path.join(__dirname, "questions.json");
const questions = JSON.parse(fs.readFileSync(questionsPath, "utf8"));

/** In-memory state (prototípus) **/
const rooms = new Map();
/*
room = {
  id, password,
  admin: { nick },
  players: Map<nick, {nick, score, ws?}>,
  game: {
    running:boolean,
    questionIndex:number,
    currentQ: { ... },
    questionStart:number, // epoch ms
    answers: Array<{nick, option, tsServer}>,
    questions: Array<...>
  }
}
*/

function newRoom(password, adminNick) {
  const id = generateRoomCode();
  const room = {
    id,
    password,
    admin: { nick: adminNick },
    players: new Map(),
    game: {
      running: false,
      questionIndex: -1,
      currentQ: null,
      questionStart: 0,
      answers: [],
      questions: []
    }
  };
  rooms.set(id, room);
  return room;
}

function generateRoomCode() {
  // 6 karakter (a-z0-9)
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function pickTwentyQuestions() {
  // előre válogatott 20 kérdés (4x5); később randomizálható
  return questions.slice(0, 20);
}

function broadcast(room, type, payload) {
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) {
      p.ws.send(JSON.stringify({ type, ...payload }));
    }
  }
}

function roomSnapshot(room) {
  return {
    id: room.id,
    players: Array.from(room.players.values()).map(p => ({ nick: p.nick, score: p.score })),
    admin: room.admin?.nick || null,
    game: {
      running: room.game.running,
      questionIndex: room.game.questionIndex
    }
  };
}

// --- mini log helper ---
function log(...args) { console.log(new Date().toISOString(), "-", ...args); }

/** REST: create / join **/
app.post("/api/createRoom", (req, res) => {
  log("POST /api/createRoom", req.body);
  const { password, adminNick } = req.body || {};
  if (!password || !adminNick) return res.status(400).json({ error: "password és adminNick kötelező" });

  const room = newRoom(password, adminNick);
  // Admin is player too
  room.players.set(adminNick, { nick: adminNick, score: 0, ws: null });
  res.json({ roomId: room.id });
});

app.post("/api/join", (req, res) => {
  log("POST /api/join", req.body);
  const { roomId, password, nick } = req.body || {};
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Nincs ilyen szoba" });
  if (room.password !== password) return res.status(403).json({ error: "Rossz jelszó" });

  if (!nick || nick.length < 3 || nick.length > 12) {
    return res.status(400).json({ error: "A nick 3-12 karakter legyen." });
  }
  if (room.players.has(nick)) {
    return res.status(409).json({ error: "Ez a nick már foglalt a szobában." });
  }
  room.players.set(nick, { nick, score: 0, ws: null });
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // az első üzenet legyen join
  ws.once("message", (msg) => {
    let init;
    try { init = JSON.parse(msg.toString()); } catch { ws.close(); return; }
    if (init.type !== "join") { ws.close(); return; }

    const { roomId, password, nick, isAdmin } = init;
    const room = rooms.get(roomId);
    if (!room || room.password !== password) {
      ws.send(JSON.stringify({ type: "error", error: "Bad room/password" }));
      ws.close();
      return;
    }

    // Admin validálás
    if (isAdmin) {
      if (room.admin?.nick !== nick) {
        ws.send(JSON.stringify({ type: "error", error: "Nem vagy a szoba adminja" }));
        ws.close();
        return;
      }
    } else {
      if (!room.players.has(nick)) {
        ws.send(JSON.stringify({ type: "error", error: "Nick nincs regisztrálva a szobában (join előtt csatlakozz REST-en)" }));
        ws.close();
        return;
      }
    }

    // regisztráljuk a ws-t
    const player = room.players.get(nick) || { nick, score: 0, ws: null };
    player.ws = ws;
    room.players.set(nick, player);

    // lobby update mindenkinek
    broadcast(room, "lobbyUpdate", { room: roomSnapshot(room) });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "startGame") {
        if (nick !== room.admin?.nick) return;
        startGame(room);
      }

      if (msg.type === "submitAnswer") {
        if (!room.game.running) return;
        if (!room.game.currentQ) return;

        // csak egyszer rögzítsük körönként
        const already = room.game.answers.find(a => a.nick === nick);
        if (already) return;

        room.game.answers.push({
          nick,
          option: msg.option,      // 'A' | 'B' | 'C' | 'D'
          tsServer: Date.now()     // szerver oldali idő – anti-cheat
        });
      }

      if (msg.type === "nextQuestion") {
        if (nick !== room.admin?.nick) return;
        if (room.game.running) goNextQuestion(room);
      }
    });

    ws.on("close", () => {
      // ws bezárult, a játékos marad (vissza tud jönni)
      player.ws = null;
      broadcast(room, "lobbyUpdate", { room: roomSnapshot(room) });
    });

    // visszaigazolás + lobby snapshot
    ws.send(JSON.stringify({ type: "joined", room: roomSnapshot(room), you: { nick, isAdmin: !!isAdmin } }));
  });
});

function startGame(room) {
  for (const p of room.players.values()) p.score = 0;

  room.game.running = true;
  room.game.questionIndex = -1;
  room.game.questions = pickTwentyQuestions();
  goNextQuestion(room);
}

function goNextQuestion(room) {
  room.game.questionIndex++;
  room.game.answers = [];

  if (room.game.questionIndex >= room.game.questions.length) {
    // vége
    room.game.running = false;
    broadcast(room, "gameOver", {
      scoreboard: Array.from(room.players.values())
        .map(p => ({ nick: p.nick, score: p.score }))
        .sort((a, b) => b.score - a.score)
    });
    return;
  }

  const q = room.game.questions[room.game.questionIndex];
  room.game.currentQ = q;
  room.game.questionStart = Date.now();

  broadcast(room, "question", {
    index: room.game.questionIndex + 1,
    total: room.game.questions.length,
    category: q.category,
    question: q.question,
    options: q.options,
    timeLimitSec: 10
  });

  // 10 mp után értékelés
  setTimeout(() => finishRound(room), 10_000);
}

function finishRound(room) {
  const q = room.game.currentQ;
  if (!q) return;

  const correct = q.answer; // 'A' | 'B' | 'C' | 'D'
  const correctOnes = room.game.answers.filter(a => a.option === correct);
  let winner = null;
  if (correctOnes.length > 0) {
    correctOnes.sort((a, b) => a.tsServer - b.tsServer);
    winner = correctOnes[0];
    const player = room.players.get(winner.nick);
    if (player) player.score += 1;
  }

  broadcast(room, "roundResult", {
    correct,
    winner: winner ? winner.nick : null,
    scoreboard: Array.from(room.players.values())
      .map(p => ({ nick: p.nick, score: p.score }))
      .sort((a, b) => b.score - a.score)
  });

  // 2 mp múlva automatikus következő
  setTimeout(() => goNextQuestion(room), 2000);
}

// Health endpoint Renderhez
app.get("/healthz", (_req, res) => res.send("ok"));

/** SPA fallback:
 * ha bármi más GET HTML-t kér és nincs külön route,
 * adjuk vissza az index.html-t (deep linkek ne 404-eljenek).
 * A statikus fájlokra ez nem hat, mert az express.static előrébb van.
 */
app.get("*", (req, res, next) => {
  if (req.method !== "GET") return next();
  const accept = req.headers.accept || "";
  if (accept.includes("text/html")) {
    return res.sendFile(path.join(__dirname, "public", "index.html"));
  }
  next();
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log("Server listening on", PORT);
});
