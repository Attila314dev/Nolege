// server.js — JSON-alapú, DB NÉLKÜL
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

process.on("unhandledRejection", (e) => console.error("unhandledRejection", e));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --------------------
// Questions from JSON
// --------------------
function loadQuestionsFromJson() {
  const p = path.join(__dirname, "questions.json");
  const raw = fs.readFileSync(p, "utf8");
  const data = JSON.parse(raw);

  const list = Array.isArray(data) ? data : Array.isArray(data?.questions) ? data.questions : null;
  if (!list) throw new Error("questions.json must be an array or { questions: [...] }");

  const normalized = list.map(normalizeQuestion).filter(Boolean);

  if (normalized.length === 0) {
    console.warn("Loaded 0 valid questions from questions.json");
  } else {
    console.log("Loaded questions:", normalized.length);
  }

  return normalized;
}

/**
 * Converts your JSON format to the internal format needed by the game
 * Input:  { category, question, correct, wrong: [...] }
 * Output: { category, question, options: [A,B,C,D], answerIndex: 0-3 }
 */
function normalizeQuestion(q, idx) {
  if (!q || typeof q !== "object") {
    console.warn(`Question #${idx}: invalid question object`);
    return null;
  }

  // Extract and validate basic fields
  const category = String(q.category ?? "").trim();
  const question = String(q.question ?? "").trim();
  const correct = q.correct ? String(q.correct).trim() : null;
  const wrong = Array.isArray(q.wrong) ? q.wrong : [];

  // Validation
  if (!category || !question) {
    console.warn(`Question #${idx}: missing category or question text`);
    return null;
  }
  if (!correct) {
    console.warn(`Question #${idx}: missing correct answer`);
    return null;
  }
  if (wrong.length < 3) {
    console.warn(`Question #${idx}: need at least 3 wrong answers, got ${wrong.length}`);
    return null;
  }

  // Create options array: 1 correct + 3 random wrong answers
  const selectedWrong = wrong
    .sort(() => Math.random() - 0.5)  // Shuffle
    .slice(0, 3)                       // Take first 3
    .map(x => String(x).trim());

  // Combine and shuffle all 4 options
  const allOptions = [correct, ...selectedWrong];
  shuffle(allOptions);

  // Find which position the correct answer ended up in
  const answerIndex = allOptions.indexOf(correct);

  if (answerIndex === -1) {
    console.warn(`Question #${idx}: correct answer not found in shuffled options`);
    return null;
  }

  return {
    category,
    question,
    options: allOptions,      // Array of 4 strings
    answerIndex               // 0, 1, 2, or 3
  };
}

const ALL_QUESTIONS = loadQuestionsFromJson();

function pickRandomQuestions(count) {
  if (ALL_QUESTIONS.length === 0) return [];

  // shuffle copy
  const arr = ALL_QUESTIONS.slice();
  shuffle(arr);

  // if not enough, just return as many as we have
  return arr.slice(0, Math.min(count, arr.length));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --------------------
// In-memory rooms
// --------------------
const rooms = new Map();
/*
room = {
  id, password,
  admin: { nick },
  players: Map<nick, {nick, score, ws?, disconnected:boolean}>,
  spectators: Set<WebSocket>,
  game: {
    running:boolean,
    questionIndex:number,
    currentQ:{ category, question, options[4], answerIndex },
    questionStart:number,
    answers: Array<{nick, option('A'|'B'|'C'|'D'), tsServer:number}>,
    questions: Array< currentQ >,
    roundClosed:boolean,
    roundTimer:any,
    expected:number
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
    spectators: new Set(),
    game: {
      running: false,
      questionIndex: -1,
      currentQ: null,
      questionStart: 0,
      answers: [],
      questions: [],
      roundClosed: false,
      roundTimer: null,
      expected: 0
    }
  };
  rooms.set(id, room);
  return room;
}

function generateRoomCode() {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 6; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

function broadcast(room, type, payload) {
  const msg = JSON.stringify({ type, ...payload });

  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(msg);
  }
  for (const s of room.spectators) {
    if (s.readyState === 1) s.send(msg);
  }
}

function roomSnapshot(room) {
  return {
    id: room.id,
    admin: room.admin?.nick || null,
    players: Array.from(room.players.values()).map((p) => ({
      nick: p.nick + (p.disconnected ? " (kilépett)" : ""),
      score: p.score
    })),
    game: {
      running: room.game.running,
      questionIndex: room.game.questionIndex
    }
  };
}

// --------------------
// REST
// --------------------
app.get("/api/rooms", (_req, res) => {
  const list = Array.from(rooms.values()).map((r) => ({
    id: r.id,
    admin: r.admin?.nick || null,
    players: r.players.size,
    running: r.game.running,
    questionIndex: r.game.questionIndex
  }));
  res.json(list);
});

app.post("/api/createRoom", (req, res) => {
  const { password, adminNick } = req.body || {};
  if (!password || !adminNick) return res.status(400).json({ error: "password és adminNick kötelező" });

  const room = newRoom(password, adminNick);
  room.players.set(adminNick, { nick: adminNick, score: 0, ws: null, disconnected: false });
  res.json({ roomId: room.id });
});

app.post("/api/join", (req, res) => {
  const { roomId, password, nick } = req.body || {};
  const room = rooms.get(roomId);
  if (!room) return res.status(404).json({ error: "Nincs ilyen szoba" });
  if (room.game.running) return res.status(409).json({ error: "A játék már fut. Belépés csak spectator-ként." });
  if (room.password !== password) return res.status(403).json({ error: "Rossz jelszó" });
  if (!nick || nick.length < 3 || nick.length > 12) return res.status(400).json({ error: "A nick 3-12 karakter legyen." });
  if (room.players.has(nick)) return res.status(409).json({ error: "Ez a nick már foglalt a szobában." });

  room.players.set(nick, { nick, score: 0, ws: null, disconnected: false });
  res.json({ ok: true });
});

// --------------------
// WS
// --------------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.once("message", (raw) => {
    let init;
    try {
      init = JSON.parse(raw.toString());
    } catch {
      ws.close();
      return;
    }
    if (init.type !== "join") {
      ws.close();
      return;
    }

    const { roomId, password, nick, isAdmin, spectator } = init;
    const room = rooms.get(roomId);
    if (!room) {
      ws.send(JSON.stringify({ type: "error", error: "No such room" }));
      ws.close();
      return;
    }

    // spectator: jelszó nem kell
    if (spectator) {
      room.spectators.add(ws);
      ws.on("close", () => room.spectators.delete(ws));
      ws.send(JSON.stringify({ type: "joined", room: roomSnapshot(room), you: { spectator: true } }));
      return;
    }

    // futó játékba nem léphet be játékos
    if (room.game.running) {
      ws.send(JSON.stringify({ type: "error", error: "Game already started, join as spectator" }));
      ws.close();
      return;
    }

    // játékos/admin: jelszó kell
    if (room.password !== password) {
      ws.send(JSON.stringify({ type: "error", error: "Bad room/password" }));
      ws.close();
      return;
    }

    if (isAdmin) {
      if (room.admin?.nick !== nick) {
        ws.send(JSON.stringify({ type: "error", error: "Not admin" }));
        ws.close();
        return;
      }
    } else {
      if (!room.players.has(nick)) {
        room.players.set(nick, { nick, score: 0, ws: null, disconnected: false });
      }
    }

    const player = room.players.get(nick);
    player.ws = ws;
    player.disconnected = false;

    broadcast(room, "lobbyUpdate", { room: roomSnapshot(room) });

    ws.on("message", (raw2) => {
      let msg;
      try {
        msg = JSON.parse(raw2.toString());
      } catch {
        return;
      }

      if (msg.type === "startGame" && nick === room.admin?.nick) startGame(room);
      if (msg.type === "submitAnswer") handleAnswer(room, nick, msg.option);
      if (msg.type === "nextQuestion" && nick === room.admin?.nick) goNextQuestion(room);
    });

    ws.on("close", () => {
      if (player) {
        player.ws = null;
        player.disconnected = true;
      }
      broadcast(room, "lobbyUpdate", { room: roomSnapshot(room) });
    });

    ws.send(JSON.stringify({ type: "joined", room: roomSnapshot(room), you: { nick, isAdmin: !!isAdmin } }));
  });
});

function startGame(room) {
  if (ALL_QUESTIONS.length === 0) {
    room.game.running = false;
    broadcast(room, "gameOver", { scoreboard: [] });
    return;
  }

  for (const p of room.players.values()) {
    p.score = 0;
    p.disconnected = false;
  }

  room.game.running = true;
  room.game.questionIndex = -1;
  room.game.questions = pickRandomQuestions(15);
  goNextQuestion(room);
}

function goNextQuestion(room) {
  room.game.questionIndex++;
  room.game.answers = [];
  room.game.roundClosed = false;
  if (room.game.roundTimer) {
    clearTimeout(room.game.roundTimer);
    room.game.roundTimer = null;
  }

  if (room.game.questionIndex >= room.game.questions.length) {
    room.game.running = false;
    broadcast(room, "gameOver", {
      scoreboard: Array.from(room.players.values())
        .map((p) => ({ nick: p.nick, score: p.score }))
        .sort((a, b) => b.score - a.score)
    });
    return;
  }

  const q = room.game.questions[room.game.questionIndex];
  room.game.currentQ = q;
  room.game.questionStart = Date.now();

  room.game.expected = Array.from(room.players.values()).filter((p) => p.ws && p.ws.readyState === 1).length;

  broadcast(room, "question", {
    index: room.game.questionIndex + 1,
    total: room.game.questions.length,
    category: q.category,
    question: q.question,
    options: q.options,
    timeLimitSec: 10
  });

  room.game.roundTimer = setTimeout(() => finishRound(room), 10_000);
}

function handleAnswer(room, nick, option) {
  if (!room.game.running || !room.game.currentQ || room.game.roundClosed) return;
  if (room.game.answers.find((a) => a.nick === nick)) return;

  room.game.answers.push({ nick, option, tsServer: Date.now() });

  if (room.game.expected > 0 && room.game.answers.length >= room.game.expected) {
    finishRound(room);
  }
}

function finishRound(room) {
  if (room.game.roundClosed) return;
  room.game.roundClosed = true;
  if (room.game.roundTimer) {
    clearTimeout(room.game.roundTimer);
    room.game.roundTimer = null;
  }

  const q = room.game.currentQ;
  const correctLetter = ["A", "B", "C", "D"][q.answerIndex];

  const correctOnes = room.game.answers.filter((a) => a.option === correctLetter);
  let winner = null;
  if (correctOnes.length > 0) {
    correctOnes.sort((a, b) => a.tsServer - b.tsServer);
    winner = correctOnes[0];
    const player = room.players.get(winner.nick);
    if (player) player.score += 1;
  }

  const details = Array.from(room.players.keys()).map((nk) => {
    const ans = room.game.answers.find((a) => a.nick === nk);
    const timeMs = ans ? ans.tsServer - room.game.questionStart : null;
    const isCorrect = !!ans && ans.option === correctLetter;
    const points = winner && winner.nick === nk ? 1 : 0;
    return { nick: nk, timeMs, isCorrect, option: ans?.option ?? null, points };
  });

  broadcast(room, "roundResult", {
    correct: correctLetter,
    winner: winner ? winner.nick : null,
    details,
    scoreboard: Array.from(room.players.values())
      .map((p) => ({ nick: p.nick, score: p.score }))
      .sort((a, b) => b.score - a.score)
  });

  // 1s villogás + 2s infó
  setTimeout(() => goNextQuestion(room), 3000);
}

app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log("Server listening on", PORT);
});
