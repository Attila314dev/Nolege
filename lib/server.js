import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomInt, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { createAI, offlineAnswer } from './ai.js';
import { createQuestionPool } from './question-pool.js';
import { QuizError, bankPack, bankPool, exportQuestions, fold, loadBank, parseSettings, toRoundQuestion, validatePack } from './questions.js';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const token = () => randomBytes(24).toString('base64url');
const nickname = value => {
  if (typeof value !== 'string') throw new QuizError('Add meg a beceneved.');
  const nick = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (nick.length < 2 || nick.length > 20 || /[\x00-\x1f\x7f]/.test(nick)) throw new QuizError('A becenév 2–20 karakter legyen.');
  return nick;
};

export function createQuizServer({ bank = loadBank(), ai = createAI(), poolStore, poolOptions = {}, now = Date.now, timings = {} } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(express.json({ limit: '96kb' }));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, maxPayload: 16 * 1024, verifyClient: info => {
    if (!info.origin) return true;
    try { return new URL(info.origin).host === info.req.headers.host; } catch { return false; }
  } });
  const rooms = new Map();
  const pool = createQuestionPool({ bank, ai, store: poolStore, now, ...poolOptions });
  app.use('/api', (_req, _res, next) => { void pool.ready.then(() => next(), next); });
  const limits = new Map();
  const resultMs = timings.resultMs ?? 5_000;
  const roomIdleMs = timings.roomIdleMs ?? 2 * 60 * 60 * 1000;

  function limit(key, max, windowMs) {
    const entry = limits.get(key);
    if (!entry || now() - entry.start >= windowMs) { limits.set(key, { start: now(), count: 1 }); return; }
    if (entry.count >= max) throw new QuizError('Túl sok kérés. Egy kis szünet után próbáld újra.', 429, 'rate_limit');
    entry.count++;
  }
  function roomFor(id) {
    const room = rooms.get(String(id ?? '').toLowerCase());
    if (!room) throw new QuizError('Ez a szoba már nem elérhető. Kérj új meghívót vagy nyiss másikat.', 404, 'room_missing');
    return room;
  }
  function member(room, value) {
    const player = [...room.players.values()].find(p => p.token === value);
    if (!player) throw new QuizError('Jelentkezz be újra ebbe a szobába.', 401, 'session_invalid');
    return player;
  }
  function auth(req, hostOnly = false) {
    const room = roomFor(req.params.id);
    const player = member(room, req.get('authorization')?.replace(/^Bearer /i, ''));
    if (hostOnly && player.id !== room.hostId) throw new QuizError('Ezt csak a szobagazda teheti meg.', 403, 'host_only');
    room.lastActivity = now();
    return { room, player };
  }
  const isPlaying = room => ['question', 'result'].includes(room.game.phase);
  const online = player => player.ws?.readyState === WebSocket.OPEN;
  const scoreboard = room => [...room.players.values()].map(p => ({ id: p.id, nick: p.nick, score: p.score, connected: online(p) })).sort((a, b) => b.score - a.score || a.nick.localeCompare(b.nick, 'hu'));
  function questionView(room) {
    const g = room.game;
    if (!g.current) return null;
    return { id: g.roundId, index: g.index + 1, total: g.questions.length, category: g.current.category,
      text: g.current.question, options: g.current.options, timeLimitSec: room.settings.timeLimitSec,
      timeRemainingMs: g.phase === 'question' ? Math.max(0, g.deadline - now()) : 0 };
  }
  function snapshot(room, player = null) {
    const host = room.players.get(room.hostId);
    const connected = [...room.players.values()].filter(online);
    return {
      id: room.id, hostId: room.hostId, hostNick: host.nick, settings: room.settings,
      players: scoreboard(room).map(p => ({ ...p, ready: room.players.get(p.id).ready, host: p.id === room.hostId })),
      gameId: room.game.id, phase: room.game.phase, preparing: room.preparing,
      preparingSettings: room.preparingSettings || null, prepareError: room.prepareError || null,
      pack: room.pack ? { count: room.pack.questions.length, source: room.pack.source, warning: room.pack.warning, accepted: room.pack.accepted, aiCount: room.pack.aiCount || 0, provider: room.pack.provider || null } : null,
      readyToStart: !room.preparing && !isPlaying(room) && !!room.pack?.accepted && connected.length > 0 && connected.every(p => p.ready),
      question: questionView(room), result: room.game.phase === 'result' || room.game.phase === 'finished' ? room.game.lastResult : null,
      resultRemainingMs: room.game.phase === 'result' ? Math.max(0, room.game.resultDeadline - now()) : 0,
      history: room.game.history,
      ai: ai.status(),
      pool: pool.status(),
      you: { id: player?.id ?? null, nick: player?.nick ?? null, host: player?.id === room.hostId, spectator: !player,
        ready: player?.ready ?? false, answered: player ? room.game.answers.has(player.id) : false,
        selected: player ? room.game.answers.get(player.id)?.option ?? null : null },
      ...(player?.id === room.hostId ? { invitePath: `/join/${room.id}?invite=${room.inviteToken}` } : {})
    };
  }
  function send(ws, type, data = {}) { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type, ...data })); }
  function broadcast(room) {
    for (const p of room.players.values()) if (online(p)) send(p.ws, 'state', { room: snapshot(room, p) });
    for (const ws of room.spectators) send(ws, 'state', { room: snapshot(room) });
  }
  function statusChanged() { for (const room of rooms.values()) broadcast(room); }
  const unsubscribeAI = ai.subscribe?.(statusChanged);
  const unsubscribePool = pool.subscribe(statusChanged);
  function newPlayer(room, nick, host = false) {
    if (room.players.size >= 40) throw new QuizError('Ebben a szobában már 40 játékos van.', 409);
    if ([...room.players.values()].some(p => fold(p.nick) === fold(nick))) throw new QuizError('Ez a becenév már foglalt. Válassz másikat.', 409, 'nick_taken');
    const player = { id: randomUUID(), token: token(), nick, ready: host, score: 0, ws: null };
    room.players.set(player.id, player);
    return player;
  }
  function clearGameTimers(room) {
    clearTimeout(room.game.roundTimer);
    clearTimeout(room.game.nextTimer);
    room.game.roundTimer = null; room.game.nextTimer = null;
  }
  function emptyGame() {
    return { id: randomUUID(), phase: 'lobby', index: -1, questions: [], current: null, roundId: null, answers: new Map(), participants: new Set(), history: [], lastResult: null, roundTimer: null, nextTimer: null, deadline: 0, resultDeadline: 0 };
  }
  function closeRoom(room) {
    clearGameTimers(room);
    rooms.delete(room.id);
    for (const p of room.players.values()) if (online(p)) { send(p.ws, 'roomClosed'); p.ws.close(4404, 'Room closed'); }
    for (const ws of room.spectators) { send(ws, 'roomClosed'); ws.close(4404, 'Room closed'); }
  }
  function nextQuestion(room) {
    clearGameTimers(room);
    const g = room.game;
    g.index++;
    g.answers = new Map();
    if (g.index >= g.questions.length) {
      g.phase = 'finished';
      g.current = null;
      for (const p of room.players.values()) p.ready = p.id === room.hostId;
      broadcast(room);
      return;
    }
    g.phase = 'question';
    g.current = g.questions[g.index];
    g.roundId = randomUUID();
    g.started = now();
    g.durationMs = timings.questionMs ?? room.settings.timeLimitSec * 1000;
    g.deadline = now() + g.durationMs;
    g.participants = new Set([...room.players.values()].filter(online).map(p => p.id));
    g.roundTimer = setTimeout(() => finishRound(room), g.durationMs);
    broadcast(room);
  }
  function startGame(room, player) {
    if (player.id !== room.hostId) throw new QuizError('Csak a szobagazda indíthat.', 403);
    if (isPlaying(room) || room.game.phase === 'finished') throw new QuizError('Előbb készíts elő egy új fordulót.', 409);
    if (!snapshot(room, player).readyToStart) throw new QuizError('A kérdéssor és minden csatlakozott játékos legyen készen.', 409);
    clearGameTimers(room);
    room.game = emptyGame();
    room.game.questions = room.pack.questions.map(toRoundQuestion);
    for (const p of room.players.values()) p.score = 0;
    nextQuestion(room);
  }
  function finishIfAllAnswered(room) {
    if (room.game.phase !== 'question') return;
    const expected = [...room.game.participants].filter(id => online(room.players.get(id)));
    if (expected.length && expected.every(id => room.game.answers.has(id))) finishRound(room);
  }
  function finishRound(room) {
    const g = room.game;
    if (g.phase !== 'question' || !rooms.has(room.id)) return;
    clearGameTimers(room);
    g.phase = 'result';
    const q = g.current;
    const details = [...room.players.values()].map(p => {
      const answer = g.answers.get(p.id);
      const correct = !!answer && answer.option === q.answerIndex;
      const points = correct ? 100 + Math.round(100 * Math.max(0, 1 - answer.timeMs / g.durationMs)) : 0;
      p.score += points;
      return { id: p.id, nick: p.nick, option: answer?.option ?? null, timeMs: answer?.timeMs ?? null, correct, points };
    });
    const fastest = details.filter(d => d.correct).sort((a, b) => a.timeMs - b.timeMs)[0];
    const result = { index: g.index + 1, questionId: g.roundId, category: q.category, question: q.question, options: q.options,
      correctIndex: q.answerIndex, correct: q.correct, explanation: q.explanation,
      fastest: fastest?.nick ?? null, details, scoreboard: scoreboard(room) };
    g.history.push(result);
    g.lastResult = result;
    g.resultDeadline = now() + resultMs;
    g.nextTimer = setTimeout(() => nextQuestion(room), resultMs);
    broadcast(room);
  }
  function answer(room, player, msg) {
    const g = room.game;
    if (g.phase !== 'question' || msg.roundId !== g.roundId || !g.participants.has(player.id) || g.answers.has(player.id)) return;
    if (!Number.isInteger(msg.option) || msg.option < 0 || msg.option > 3) return;
    if (now() >= g.deadline) { finishRound(room); return; }
    g.answers.set(player.id, { option: msg.option, timeMs: Math.max(0, now() - g.started) });
    room.lastActivity = now();
    send(player.ws, 'state', { room: snapshot(room, player) });
    finishIfAllAnswered(room);
  }

  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  app.get('/healthz', (_req, res) => res.type('text').send('ok'));
  app.get('/api/meta', (_req, res) => {
    const topics = [...new Set(bank.map(q => q.category)), 'Harry Potter'];
    res.json({ version: '2.1.0', ai: ai.status(), pool: pool.status(), bankCount: bank.length, topics: topics.map(topic => ({ name: topic, count: bankPool(bank, parseSettings({ topic, count: 1 })).length })) });
  });
  app.get('/api/rooms', (_req, res) => res.json([...rooms.values()].map(r => ({ id: r.id, hostNick: r.players.get(r.hostId).nick,
    players: [...r.players.values()].filter(online).length, running: isPlaying(r), topic: r.settings.topic || 'Általános', count: r.settings.count, password: !!r.passwordHash }))));
  app.get('/api/rooms/:id', wrap((req, res) => {
    const room = roomFor(req.params.id);
    res.json({ id: room.id, hostNick: room.players.get(room.hostId).nick, running: isPlaying(room), settings: room.settings,
      requiresPassword: !!room.passwordHash && req.query.invite !== room.inviteToken,
      invited: req.query.invite === room.inviteToken });
  }));
  app.post('/api/createRoom', wrap((req, res) => {
    limit(`create:${req.ip}`, 12, 60 * 60 * 1000);
    if (rooms.size >= 150) throw new QuizError('Most sok szoba fut. Próbáld később.', 503);
    const nick = nickname(req.body?.nick ?? req.body?.adminNick);
    const password = req.body?.password ?? '';
    if (typeof password !== 'string' || password.length > 100) throw new QuizError('A jelszó legfeljebb 100 karakter lehet.');
    const settings = parseSettings(req.body?.settings);
    let pack = null;
    if (!settings.topic) {
      try { pack = pool.take(settings); }
      catch (error) { if (!ai.status().configured || error.code !== 'bank_insufficient') throw error; }
    }
    else {
      try { pack = { questions: bankPack(bank, settings), source: 'bank', warning: '', accepted: true }; }
      catch { /* Custom themes are generated explicitly in the lobby. */ }
    }
    let id;
    do { id = Array.from({ length: 6 }, () => 'abcdefghjkmnpqrstuvwxyz23456789'[randomInt(31)]).join(''); } while (rooms.has(id));
    const salt = randomBytes(16).toString('hex');
    const room = { id, inviteToken: token(), salt, passwordHash: password ? scryptSync(password, salt, 32) : null,
      players: new Map(), hostId: null, spectators: new Set(), settings, preparing: false,
      pack,
      game: emptyGame(), lastActivity: now(), generation: 0 };
    const player = newPlayer(room, nick, true);
    room.hostId = player.id;
    rooms.set(id, room);
    res.status(201).json({ roomId: id, playerToken: player.token, playerId: player.id });
  }));
  app.post('/api/join', wrap((req, res) => {
    limit(`join:${req.ip}`, 40, 60_000);
    const room = roomFor(req.body?.roomId);
    if (isPlaying(room)) throw new QuizError('A játék már fut. Addig nézőként tudsz belépni.', 409, 'game_running');
    if (room.passwordHash && req.body?.invite !== room.inviteToken) {
      if (typeof req.body?.password !== 'string' || req.body.password.length > 100 || !timingSafeEqual(scryptSync(req.body.password, room.salt, 32), room.passwordHash)) throw new QuizError('A szoba jelszava nem jó.', 403, 'bad_password');
    }
    const player = newPlayer(room, nickname(req.body?.nick));
    room.lastActivity = now();
    broadcast(room);
    res.status(201).json({ roomId: room.id, playerToken: player.token, playerId: player.id });
  }));
  app.get('/api/rooms/:id/session', wrap((req, res) => { const { room, player } = auth(req); res.json(snapshot(room, player)); }));
  app.get('/api/rooms/:id/invite.svg', wrap(async (req, res) => {
    const { room } = auth(req, true);
    const url = `${req.protocol}://${req.get('host')}/join/${room.id}?invite=${room.inviteToken}`;
    const svg = await QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 3, width: 240 });
    res.type('image/svg+xml').send(svg);
  }));
  app.get('/api/rooms/:id/pack', wrap((req, res) => {
    const { room } = auth(req, true);
    if (isPlaying(room)) throw new QuizError('A teljes kérdéssor játék előtt vagy után nézhető meg.', 409);
    res.json({ version: 1, settings: room.settings, questions: room.pack ? exportQuestions(room.pack.questions) : [] });
  }));
  app.post('/api/rooms/:id/prepare', wrap(async (req, res) => {
    const { room, player } = auth(req, true);
    if (isPlaying(room) || room.preparing) throw new QuizError('Várd meg a folyamatban lévő játékot vagy generálást.', 409);
    limit(`prepare:${room.id}`, 6, 60_000);
    const settings = parseSettings(req.body?.settings ?? room.settings);
    const generation = ++room.generation;
    room.preparing = true;
    room.preparingSettings = settings;
    room.prepareError = null;
    broadcast(room);
    try {
      let pack;
      let needsAI = false;
      if (!settings.topic) {
        try { pack = pool.take(settings); }
        catch (error) {
          if (error.code !== 'bank_insufficient' || !ai.status().configured || req.body?.useAI === false) throw error;
          needsAI = true;
        }
      }
      else if (req.body?.useAI === false || !ai.status().configured) pack = { questions: bankPack(bank, settings), source: 'bank', warning: '', accepted: true };
      else needsAI = true;
      if (needsAI) {
        try {
          const generated = await ai.generate(settings);
          pack = { questions: generated.questions, source: 'ai', provider: generated.provider, warning: '', accepted: false };
        } catch (error) {
          throw new QuizError(`${error.message} ${settings.topic ? 'Az egyedi témakör' : 'A kért nehézségű csomag'} nem készült el. Az előző kérdéssor megmaradt; újrapróbálhatod vagy választhatsz általános kvízt.`, 502, error.code || 'generation_failed');
        }
      }
      if (!rooms.has(room.id) || room.generation !== generation) throw new QuizError('A szoba közben bezárult.', 409);
      clearGameTimers(room);
      room.settings = settings;
      room.pack = pack;
      room.game = emptyGame();
      for (const p of room.players.values()) { p.ready = p.id === room.hostId; p.score = 0; }
      room.preparing = false;
      room.preparingSettings = null;
      broadcast(room);
      res.json(snapshot(room, player));
    } catch (error) {
      if (rooms.has(room.id)) room.prepareError = error instanceof QuizError ? error.message : 'A kérdéssor nem készült el. Próbáld újra.';
      throw error;
    } finally {
      if (room.preparing) { room.preparing = false; room.preparingSettings = null; if (rooms.has(room.id)) broadcast(room); }
    }
  }));
  app.post('/api/rooms/:id/refill', wrap((req, res) => {
    const { room, player } = auth(req, true);
    if (isPlaying(room)) throw new QuizError('Az utántöltést a meccs után kérheted.', 409, 'game_running');
    limit(`refill:${room.id}`, 1, 60_000);
    if (!ai.status().configured) throw new QuizError('Az AI-kulcs nincs beállítva.', 422, 'not_configured');
    void pool.refill();
    res.status(202).json(snapshot(room, player));
  }));
  app.put('/api/rooms/:id/pack', wrap((req, res) => {
    const { room, player } = auth(req, true);
    if (isPlaying(room) || room.preparing) throw new QuizError('Futó játékban nem módosítható a kérdéssor.', 409);
    const questions = validatePack(req.body?.questions);
    room.settings = parseSettings({ ...room.settings, ...req.body?.settings, count: questions.length });
    room.pack = { questions, source: 'edited', warning: '', accepted: true };
    room.prepareError = null;
    room.game = emptyGame();
    for (const p of room.players.values()) { p.ready = p.id === room.hostId; p.score = 0; }
    broadcast(room);
    res.json(snapshot(room, player));
  }));
  app.post('/api/rooms/:id/accept', wrap((req, res) => {
    const { room, player } = auth(req, true);
    if (isPlaying(room) || room.preparing || !room.pack) throw new QuizError('Most nem fogadható el a kérdéssor.', 409);
    room.pack.accepted = true;
    broadcast(room);
    res.json(snapshot(room, player));
  }));
  app.post('/api/rooms/:id/chat', wrap(async (req, res) => {
    const { room, player } = auth(req);
    if (isPlaying(room)) throw new QuizError('A Kvízmester a meccs végén lesz elérhető. Most a játékra figyelj!', 409, 'game_running');
    limit(`chat:${room.id}:${player.id}`, 6, 60_000);
    const index = Number(req.body?.index);
    const question = room.game.history.find(q => q.index === index);
    if (!question) throw new QuizError('A kérdéshez a meccs lezárása után kérhetsz magyarázatot.', 403, 'question_not_released');
    const message = typeof req.body?.message === 'string' ? req.body.message.trim() : '';
    if (!message || message.length > 1000) throw new QuizError('A kérdésed 1–1000 karakter legyen.');
    const history = Array.isArray(req.body?.history) ? req.body.history.filter(t => t && typeof t.content === 'string').slice(-4) : [];
    if (ai.status().configured) {
      try { return res.json(await ai.chat(question, message, history)); }
      catch { return res.json({ answer: offlineAnswer(question, message), source: 'bank', warning: 'Az AI most nem válaszolt; a mentett magyarázatot mutatjuk.' }); }
    }
    res.json({ answer: offlineAnswer(question, message), source: 'bank' });
  }));
  app.delete('/api/rooms/:id', wrap((req, res) => { const { room } = auth(req, true); closeRoom(room); res.json({ ok: true }); }));

  app.get(['/join/:id', '/room/:id'], (_req, res) => res.sendFile(path.join(publicDir, _req.path.startsWith('/join/') ? 'index.html' : 'room.html')));
  app.use(express.static(publicDir, { etag: false, maxAge: 0 }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Nincs ilyen végpont.', code: 'not_found' }));
  app.use((error, _req, res, _next) => {
    if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Hibás JSON-kérés.', code: 'invalid_json' });
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'Túl nagy kérés.', code: 'too_large' });
    const expected = error instanceof QuizError;
    if (!expected) console.error('request_failed', error.name);
    res.status(expected ? error.status : 500).json({ error: expected ? error.message : 'Váratlan szerverhiba. Próbáld újra.', code: expected ? error.code : 'server_error' });
  });

  wss.on('connection', ws => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    const initTimer = setTimeout(() => ws.close(4401, 'Join required'), 12_000);
    let context = null;
    ws.on('error', () => {});
    ws.on('message', raw => {
      try {
        const msg = JSON.parse(raw.toString());
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) throw new QuizError('Érvénytelen üzenet.');
        if (!context) {
          if (msg.type !== 'join') throw new QuizError('Előbb csatlakozz a szobához.', 401);
          const room = roomFor(msg.roomId);
          clearTimeout(initTimer);
          if (msg.spectator === true) {
            if (room.spectators.size >= 100) throw new QuizError('Megtelt a nézőtér.', 409);
            room.spectators.add(ws); context = { room, player: null };
          } else {
            const player = member(room, msg.token);
            const previous = player.ws;
            player.ws = ws;
            if (room.game.phase === 'question') room.game.participants.add(player.id);
            context = { room, player };
            if (previous && previous !== ws) previous.close(4001, 'Session replaced');
          }
          room.lastActivity = now();
          send(ws, 'state', { room: snapshot(room, context.player) });
          broadcast(room);
          return;
        }
        const { room, player } = context;
        if (!rooms.has(room.id)) { ws.close(4404, 'Room missing'); return; }
        if (msg.type === 'sync') { send(ws, 'state', { room: snapshot(room, player) }); return; }
        if (!player) return;
        limit(`ws:${player.id}`, 100, 10_000);
        room.lastActivity = now();
        if (msg.type === 'ready' && !isPlaying(room)) { player.ready = msg.ready === true; broadcast(room); }
        if (msg.type === 'start') startGame(room, player);
        if (msg.type === 'answer') answer(room, player, msg);
      } catch (error) {
        send(ws, 'error', { error: error instanceof QuizError ? error.message : 'Érvénytelen üzenet.', code: error.code || 'invalid_message' });
        if (!context) { clearTimeout(initTimer); ws.close(4401, 'Invalid join'); }
      }
    });
    ws.on('close', () => {
      clearTimeout(initTimer);
      if (!context) return;
      const { room, player } = context;
      if (player && player.ws === ws) { player.ws = null; finishIfAllAnswered(room); }
      if (!player) room.spectators.delete(ws);
      if (rooms.has(room.id)) broadcast(room);
    });
  });
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false; ws.ping();
    }
  }, 30_000);
  heartbeat.unref();
  const cleanup = setInterval(() => {
    for (const room of rooms.values()) if (now() - room.lastActivity > roomIdleMs) closeRoom(room);
    for (const [key, value] of limits) if (now() - value.start > 60 * 60 * 1000) limits.delete(key);
  }, timings.cleanupMs ?? 60_000);
  cleanup.unref();

  async function close() {
    unsubscribeAI?.(); unsubscribePool();
    ai.close?.();
    clearInterval(heartbeat); clearInterval(cleanup);
    for (const room of [...rooms.values()]) closeRoom(room);
    for (const ws of wss.clients) ws.terminate();
    await new Promise(resolve => wss.close(resolve));
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await pool.close();
  }
  return { app, server, rooms, pool, ready: pool.ready, close };
}
