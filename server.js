// server.js
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import { v4 as uuidv4 } from "uuid";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const questionsAll = JSON.parse(fs.readFileSync("./questions.json", "utf8"));
const rooms = new Map();

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
      expected: 0,
      rematchVotes: new Set()
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

function pickRandomQuestions(count) {
  const shuffled = [...questionsAll].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count).map(q => {
    const wrongs = [...q.wrongAnswers].sort(() => Math.random() - 0.5).slice(0, 3);
    const answers = [{ opt: q.correct, correct: true }, ...wrongs.map(w => ({ opt: w, correct: false }))];
    const shuffledAnswers = answers.sort(() => Math.random() - 0.5);
    return {
      category: q.category,
      question: q.question,
      options: shuffledAnswers.map(a => a.opt),
      answerIndex: shuffledAnswers.findIndex(a => a.correct) // 0-3
    };
  });
}

function broadcast(room, type, payload) {
  for (const p of room.players.values()) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify({ type, ...payload }));
  }
  for (const s of room.spectators) {
    if (s.readyState === 1) s.send(JSON.stringify({ type, ...payload }));
  }
}

function roomSnapshot(room) {
  return {
    id: room.id,
    players: Array.from(room.players.values()).map(p => ({
      nick: p.nick + (p.disconnected ? " (kilépett)" : ""),
      score: p.score
    })),
    admin: room.admin?.nick || null,
    game: {
      running: room.game.running,
      questionIndex: room.game.questionIndex
    }
  };
}

app.get("/api/rooms", (_req, res) => {
  const list = Array.from(rooms.values()).map(r => ({
    id: r.id,
    players: r.players.size,
    admin: r.admin.nick,
    running: r.game.running
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

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.once("message", (raw) => {
    let init; try { init = JSON.parse(raw.toString()); } catch { ws.close(); return; }
    if (init.type !== "join") { ws.close(); return; }

    const { roomId, password, nick, isAdmin, spectator } = init;
    const room = rooms.get(roomId);
    if (!room || room.password !== password) { ws.send(JSON.stringify({ type: "error", error: "Bad room/password" })); ws.close(); return; }

    if (spectator) {
      room.spectators.add(ws);
      ws.on("close", () => room.spectators.delete(ws));
      ws.send(JSON.stringify({ type: "joined", room: roomSnapshot(room), you: { spectator: true } }));
      return;
    }

    if (room.game.running) {
      ws.send(JSON.stringify({ type: "error", error: "Game already started, join as spectator" }));
      ws.close();
      return;
    }

    if (isAdmin) {
      if (room.admin?.nick !== nick) { ws.close(); return; }
    } else {
      if (!room.players.has(nick)) {
        room.players.set(nick, { nick, score: 0, ws: null, disconnected: false });
      }
    }

    const player = room.players.get(nick);
    player.ws = ws;
    player.disconnected = false;

    broadcast(room, "lobbyUpdate", { room: roomSnapshot(room) });

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "startGame" && nick === room.admin?.nick) {
        startGame(room);
      }
      if (msg.type === "submitAnswer") handleAnswer(room, nick, msg.option);
      if (msg.type === "nextQuestion" && nick === room.admin?.nick) goNextQuestion(room);
      if (msg.type === "rematchVote") {
        room.game.rematchVotes.add(nick);
        if (room.game.rematchVotes.size === room.players.size) startGame(room);
      }
    });

    ws.on("close", () => {
      player.ws = null;
      player.disconnected = true;
      broadcast(room, "lobbyUpdate", { room: roomSnapshot(room) });
    });

    ws.send(JSON.stringify({ type: "joined", room: roomSnapshot(room), you: { nick, isAdmin: !!isAdmin } }));
  });
});

function startGame(room) {
  for (const p of room.players.values()) { p.score = 0; p.disconnected = false; }
  room.game.running = true;
  room.game.questionIndex = -1;
  room.game.questions = pickRandomQuestions(15);
  goNextQuestion(room);
}

function goNextQuestion(room) {
  room.game.questionIndex++;
  room.game.answers = [];
  room.game.roundClosed = false;
  if (room.game.roundTimer) clearTimeout(room.game.roundTimer);

  if (room.game.questionIndex >= room.game.questions.length) {
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
  room.game.expected = Array.from(room.players.values()).filter(p => p.ws && p.ws.readyState === 1).length;

  broadcast(room, "question", {
    index: room.game.questionIndex + 1,
    total: room.game.questions.length,
    category: q.category,
    question: q.question,
    options: q.options,
    answerIndex: q.answerIndex,
    timeLimitSec: 10
  });

  room.game.roundTimer = setTimeout(() => finishRound(room), 10000);
}

function handleAnswer(room, nick, option) {
  if (!room.game.running || !room.game.currentQ || room.game.roundClosed) return;
  const already = room.game.answers.find(a => a.nick === nick);
  if (already) return;

  room.game.answers.push({ nick, option, tsServer: Date.now() });

  if (room.game.expected > 0 && room.game.answers.length >= room.game.expected) {
    finishRound(room);
  }
}

function finishRound(room) {
  if (room.game.roundClosed) return;
  room.game.roundClosed = true;
  if (room.game.roundTimer) clearTimeout(room.game.roundTimer);

  const q = room.game.currentQ;
  const correctIndex = q.answerIndex;
  const correctLetter = ["A","B","C","D"][correctIndex];

  const correctOnes = room.game.answers.filter(a => a.option === correctLetter);
  let winner = null;
  if (correctOnes.length > 0) {
    correctOnes.sort((a, b) => a.tsServer - b.tsServer);
    winner = correctOnes[0];
    const player = room.players.get(winner.nick);
    if (player) player.score += 1;
  }

  broadcast(room, "roundResult", {
    correct: correctLetter,
    winner: winner ? winner.nick : null,
    scoreboard: Array.from(room.players.values())
      .map(p => ({ nick: p.nick, score: p.score }))
      .sort((a, b) => b.score - a.score)
  });

  setTimeout(() => goNextQuestion(room), 2000);
}

app.get("/healthz", (_, res) => res.send("ok"));
const PORT = process.env.PORT || 10000;
server.listen(PORT, () => console.log("Server listening on", PORT));
