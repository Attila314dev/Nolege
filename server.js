// server.js (DB-s verzió)
import express from "express";
import { WebSocketServer } from "ws";
import http from "http";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import pg from "pg";

const { Pool } = pg;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// --- Postgres pool ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("render.com") ? { rejectUnauthorized: false } : false
});
// --- schema + egyszeri seed indításkor (Shell nélkül) ---
async function ensureSchema() {
  await pool.query(`
    create table if not exists questions (
      id serial primary key,
      category text not null,
      question text not null,
      correct text not null
    );
    create table if not exists wrong_answers (
      id serial primary key,
      question_id int not null references questions(id) on delete cascade,
      text text not null
    );
    create index if not exists idx_wrong_answers_qid on wrong_answers(question_id);
  `);
}

async function seedIfEmpty() {
  let needSeed = false;

  try {
    const { rows } = await pool.query("select count(*)::int as n from questions");
    needSeed = (rows[0]?.n ?? 0) === 0;
  } catch (e) {
    // Ha a tábla még nincs is meg, akkor is seedelni fogunk (schema után)
    needSeed = true;
  }

  if (!needSeed) {
    console.log("ℹ️ Seed kihagyva: már van adat a DB-ben.");
  } else {
    const jsonPath = path.join(__dirname, "questions.json");
    if (!fs.existsSync(jsonPath)) {
      console.warn("⚠️ questions.json nem található, seed kihagyva (DB üres marad).");
    } else {
      const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
      console.log(`📥 Importálás… (${data.length} kérdés)`);

      await pool.query("truncate wrong_answers restart identity cascade;");
      await pool.query("truncate questions restart identity cascade;");

      for (const q of data) {
        const wrong = Array.isArray(q.wrong) ? q.wrong : (q.wrongAnswers || []);
        const insQ = await pool.query(
          "insert into questions(category, question, correct) values ($1,$2,$3) returning id",
          [q.category, q.question, q.correct]
        );
        const qid = insQ.rows[0].id;
        if (wrong.length) {
          const values = wrong.flatMap(w => [qid, w]);
          const params = wrong.map((_, i) => `($${2*i+1}, $${2*i+2})`).join(",");
          await pool.query(`insert into wrong_answers(question_id, text) values ${params}`, values);
        }
      }
      console.log("✅ Seed kész.");
    }
  }
}

  // questions.json beolvasása a projekt gyökeréből
  const jsonPath = path.join(__dirname, "questions.json");
  if (!fs.existsSync(jsonPath)) {
    console.warn("⚠️ questions.json nem található, seed kihagyva.");
    return;
  }
  const data = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  console.log(`📥 Importálás… (${data.length} kérdés)`);

  // tiszta töltés – ha inkább hozzáfűznél, vedd ki a truncate-okat
  await pool.query("truncate wrong_answers restart identity cascade;");
  await pool.query("truncate questions restart identity cascade;");

  for (const q of data) {
    const wrong = Array.isArray(q.wrong) ? q.wrong : (q.wrongAnswers || []);
    const insQ = await pool.query(
      "insert into questions(category, question, correct) values ($1,$2,$3) returning id",
      [q.category, q.question, q.correct]
    );
    const qid = insQ.rows[0].id;
    if (wrong.length) {
      const values = wrong.flatMap(w => [qid, w]);
      const params = wrong.map((_, i) => `($${2*i+1}, $${2*i+2})`).join(",");
      await pool.query(`insert into wrong_answers(question_id, text) values ${params}`, values);
    }
  }
  console.log("✅ Seed kész.");
}

// --- In-memory rooms ---
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

// ---- DB kérdés lekérés: 15 random kérdés + 3 random wrong/kérdés ----
async function pickRandomQuestions(count) {
  // 1) 15 random kérdés
  const qRes = await pool.query(
    `select id, category, question, correct
     from questions
     order by random()
     limit $1`,
    [count]
  );
  const questions = qRes.rows;

  if (questions.length === 0) return [];

  // 2) 3 random wrong / kérdés (window + row_number)
  const ids = questions.map(q => q.id);
  const wrongRes = await pool.query(
    `with ranked as (
       select wa.*, row_number() over (partition by question_id order by random()) as rn
       from wrong_answers wa
       where question_id = any($1)
     )
     select question_id, text
     from ranked
     where rn <= 3`,
    [ids]
  );

  // Map wrongs
  const wrongMap = new Map();
  for (const row of wrongRes.rows) {
    const arr = wrongMap.get(row.question_id) || [];
    arr.push(row.text);
    wrongMap.set(row.question_id, arr);
  }

  // 3) ABCD keverés
  return questions.map(q => {
    const wrongs = wrongMap.get(q.id) || [];
    const options = shuffle([{ t: q.correct, ok: true }, ...wrongs.map(w => ({ t: w, ok: false }))]);
    return {
      category: q.category,
      question: q.question,
      options: options.map(o => o.t),
      answerIndex: options.findIndex(o => o.ok)
    };
  });
}

function shuffle(arr) {
  for (let i=arr.length-1; i>0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
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
    admin: room.admin?.nick || null,
    players: Array.from(room.players.values()).map(p => ({
      nick: p.nick + (p.disconnected ? " (kilépett)" : ""),
      score: p.score
    })),
    game: {
      running: room.game.running,
      questionIndex: room.game.questionIndex
    }
  };
}

// --- REST ---
app.get("/api/rooms", (_req, res) => {
  const list = Array.from(rooms.values()).map(r => ({
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

// --- WS ---
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.once("message", (raw) => {
    let init; try { init = JSON.parse(raw.toString()); } catch { ws.close(); return; }
    if (init.type !== "join") { ws.close(); return; }

    const { roomId, password, nick, isAdmin, spectator } = init;
    const room = rooms.get(roomId);
    if (!room) { ws.send(JSON.stringify({ type:"error", error:"No such room" })); ws.close(); return; }

    // spectator: jelszó nem kell
    if (spectator) {
      room.spectators.add(ws);
      ws.on("close", () => room.spectators.delete(ws));
      ws.send(JSON.stringify({ type: "joined", room: roomSnapshot(room), you: { spectator: true } }));
      return;
    }

    // futó játékba nem léphet be játékos
    if (room.game.running) { ws.send(JSON.stringify({ type: "error", error: "Game already started, join as spectator" })); ws.close(); return; }

    // játékos/admin: jelszó kell
    if (room.password !== password) { ws.send(JSON.stringify({ type: "error", error: "Bad room/password" })); ws.close(); return; }

    if (isAdmin) {
      if (room.admin?.nick !== nick) { ws.send(JSON.stringify({ type:"error", error:"Not admin" })); ws.close(); return; }
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
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "startGame" && nick === room.admin?.nick) startGame(room);
      if (msg.type === "submitAnswer") handleAnswer(room, nick, msg.option);
      if (msg.type === "nextQuestion" && nick === room.admin?.nick) goNextQuestion(room);
    });

    ws.on("close", () => {
      if (player) { player.ws = null; player.disconnected = true; }
      broadcast(room, "lobbyUpdate", { room: roomSnapshot(room) });
    });

    ws.send(JSON.stringify({ type: "joined", room: roomSnapshot(room), you: { nick, isAdmin: !!isAdmin } }));
  });
});

async function startGame(room) {
  for (const p of room.players.values()) { p.score = 0; p.disconnected = false; }
  room.game.running = true;
  room.game.questionIndex = -1;
  room.game.questions = await pickRandomQuestions(15);
  goNextQuestion(room);
}

function goNextQuestion(room) {
  room.game.questionIndex++;
  room.game.answers = [];
  room.game.roundClosed = false;
  if (room.game.roundTimer) { clearTimeout(room.game.roundTimer); room.game.roundTimer = null; }

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

  room.game.expected = Array.from(room.players.values())
    .filter(p => p.ws && p.ws.readyState === 1).length;

  // helyes index NEM megy ki
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
  if (room.game.answers.find(a => a.nick === nick)) return;

  room.game.answers.push({ nick, option, tsServer: Date.now() });

  if (room.game.expected > 0 && room.game.answers.length >= room.game.expected) {
    finishRound(room);
  }
}

function finishRound(room) {
  if (room.game.roundClosed) return;
  room.game.roundClosed = true;
  if (room.game.roundTimer) { clearTimeout(room.game.roundTimer); room.game.roundTimer = null; }

  const q = room.game.currentQ;
  const correctLetter = ["A","B","C","D"][q.answerIndex];

  const correctOnes = room.game.answers.filter(a => a.option === correctLetter);
  let winner = null;
  if (correctOnes.length > 0) {
    correctOnes.sort((a, b) => a.tsServer - b.tsServer);
    winner = correctOnes[0];
    const player = room.players.get(winner.nick);
    if (player) player.score += 1;
  }

  // részletek mindenkinek (idő + pont)
  const details = Array.from(room.players.keys()).map(nk => {
    const ans = room.game.answers.find(a => a.nick === nk);
    const timeMs = ans ? (ans.tsServer - room.game.questionStart) : null;
    const isCorrect = !!ans && ans.option === correctLetter;
    const points = winner && winner.nick === nk ? 1 : 0;
    return { nick: nk, timeMs, isCorrect, option: ans?.option ?? null, points };
  });

  broadcast(room, "roundResult", {
    correct: correctLetter,
    winner: winner ? winner.nick : null,
    details,
    scoreboard: Array.from(room.players.values())
      .map(p => ({ nick: p.nick, score: p.score }))
      .sort((a, b) => b.score - a.score)
  });

  // 1s villogás + 2s infó
  setTimeout(() => goNextQuestion(room), 3000);
}

app.get("/healthz", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 10000;

(async () => {
  try {
    await ensureSchema();
    await seedIfEmpty();
    server.listen(PORT, () => console.log("Server listening on", PORT));
  } catch (e) {
    console.error("Startup error:", e);
    process.exit(1);
  }
})();

