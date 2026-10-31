import { $, api, copy, esc, forgetSession, getSession, settingsFrom, settingsHTML, sourceName, suggestTopicCount, toast } from './common.js';
import { createFocusMode, matchInProgress } from './focus.js';
import { renderAIStatus } from './ai-status.js';
import { createGameAudio } from './audio.js';
import { createCelebration, isWinner, winners } from './celebration.js';

const query = new URLSearchParams(location.search);
const roomId = (query.get('room') || location.pathname.match(/^\/room\/([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
const spectator = query.get('spectator') === '1';
let session = getSession(roomId);
let room;
let meta = { topics: [], ai: { configured: false } };
let ws;
let retry = 0;
let reconnectTimer;
let timer;
let settingsKey = '';
let stageKey = '';
let lastInvite = '';
let qrObjectURL;
let previewQuestions = [];
let selectedQuestionIndex = 0;
let reviewLength = -1;
let lastGameId = '';
const chats = new Map();
const focusMode = createFocusMode({ notify: toast });
const sound = createGameAudio();
const celebration = createCelebration();

function showError(message, join = false) {
  $('#roomError').hidden = false;
  $('#roomError').innerHTML = `${esc(message)} ${join ? `<a href="/join/${esc(roomId)}">Újracsatlakozom →</a>` : '<a href="/">Vissza a főoldalra →</a>'}`;
}
function connection(text, connected = false) {
  for (const id of ['#connectionStatus', '#focusConnection']) { $(id).textContent = text; $(id).classList.toggle('connected', connected); }
}
function send(message) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  else toast('A kapcsolat helyreállítása folyamatban van. A pontjaid megmaradnak.', true);
}
function connect() {
  clearTimeout(reconnectTimer);
  connection(retry ? 'Újracsatlakozás…' : 'Kapcsolódás…');
  const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`);
  ws = socket;
  socket.onopen = () => socket.send(JSON.stringify({ type: 'join', roomId, token: session?.token, spectator }));
  socket.onmessage = event => {
    let message; try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === 'state') { retry = 0; connection('Élő kapcsolat', true); $('#roomError').hidden = true; render(message.room); }
    if (message.type === 'error') toast(message.error, true);
    if (message.type === 'roomClosed') { focusMode.setActive(false); sound.pause(); celebration.stop(); showError('A szobagazda bezárta a szobát, vagy a szoba lejárt.'); }
  };
  socket.onclose = event => {
    if (socket !== ws) return;
    clearInterval(timer);
    sound.pause(); celebration.stop();
    if (event.code === 4404) { focusMode.setActive(false); connection('A szoba bezárult'); showError('Ez a szoba már bezárult.'); return; }
    if (event.code === 4001) { focusMode.setActive(false); connection('Másik lapon aktív'); showError('Ezt a játékost egy másik böngészőlapon nyitottad meg. Frissítsd ezt az oldalt, ha itt szeretnél játszani.'); return; }
    if (event.code === 4401) { focusMode.setActive(false); connection('Új belépés szükséges'); forgetSession(roomId); showError('A belépésed már nem érvényes.', true); return; }
    connection('Kapcsolat helyreállítása…');
    reconnectTimer = setTimeout(connect, Math.min(10_000, 700 * 2 ** retry++) + Math.random() * 300);
  };
  socket.onerror = () => connection('Kapcsolat helyreállítása…');
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { if (ws?.readyState === WebSocket.OPEN) send({ type: 'sync' }); else if (!ws || ws.readyState === WebSocket.CLOSED) connect(); }
});

function render(next) {
  const newQuestion = next.phase === 'question' && (room?.phase !== 'question' || room?.question?.id !== next.question?.id);
  room = next;
  sound.setMatch({ phase: room.phase, gameId: room.gameId, questionId: room.question?.id || '', answered: room.you.answered });
  const playing = matchInProgress(room.phase);
  focusMode.setActive(playing);
  $('#focusTitle').textContent = room.settings.topic || 'Általános kvíz';
  const myRank = room.players.findIndex(player => player.id === room.you.id);
  $('#focusScore').textContent = room.you.spectator ? `${room.players.filter(p => p.connected).length} játékos · néző vagy` : `${room.players[myRank]?.score ?? 0} pont · ${myRank + 1}. hely`;
  if (lastGameId !== room.gameId) {
    lastGameId = room.gameId; chats.clear(); selectedQuestionIndex = 0; reviewLength = -1; stageKey = '';
    if ($('#chatDialog').open) $('#chatDialog').close();
  }
  $('#roomCode').textContent = room.id.toUpperCase();
  $('#roomTitle').textContent = room.settings.topic || 'Általános kvíz';
  $('#roomSubtitle').textContent = `${room.settings.count} kérdés · ${room.settings.timeLimitSec} mp válaszidő · ${room.you.spectator ? 'Nézőként csatlakoztál' : `${room.you.nick}${room.you.host ? ' · szobagazda' : ''}`}`;
  $('#roomEyebrow').textContent = room.phase === 'finished' ? 'EZ SZÉP KÖR VOLT.' : room.phase === 'lobby' ? 'ITT GYŰLIK A TÁRSASÁG' : 'MINDEN JÓ VÁLASZ SZÁMÍT';
  $('#playerCount').textContent = `${room.players.filter(p => p.connected).length} online`;
  $('#players').innerHTML = room.players.map((player, index) => `<li class="${player.id === room.you.id ? 'is-you' : ''}"><span class="rank">${index + 1}</span><span class="avatar">${esc([...player.nick][0]?.toLocaleUpperCase('hu') || '?')}</span><span class="player-name">${esc(player.nick)}${player.id === room.you.id ? ' <small>te</small>' : ''}<small>${player.host ? 'Szobagazda · ' : ''}${player.connected ? room.phase === 'lobby' ? (player.ready ? '✓ Készen áll' : 'Még készül') : 'Online' : 'Kapcsolódásra vár'}</small></span><strong>${player.score}<small>pont</small></strong></li>`).join('');
  const key = JSON.stringify({ phase: room.phase, q: room.question?.id, selected: room.you.selected, answered: room.you.answered,
    ready: room.you.ready, start: room.readyToStart, pack: room.pack, preparing: room.preparing, history: room.history.length,
    connected: room.players.map(p => [p.id, p.ready, p.connected]) });
  if (key !== stageKey) { stageKey = key; renderStage(); }
  startTimer();
  renderHost();
  renderAIStatus($('#roomAIStatus'), room.ai, room.pool);
  renderReview();
  if (celebration.show(room)) sound.win(room.gameId);
  if (newQuestion) { $('#gameStage').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
}

function renderStage() {
  const stage = $('#gameStage');
  stage.classList.toggle('spectator-stage', room.you.spectator);
  if (room.preparing) {
    const preparing = room.preparingSettings || room.settings;
    stage.innerHTML = `<div class="lobby-stage"><span class="spinner large-spinner"></span><span class="eyebrow">KÉSZÜL A KÉRDÉSSOR</span><h2>${preparing.count} kérdés készül.</h2><p>${esc(preparing.topic || 'Általános kvíz')}<br>Az egyedi AI-generálás akár másfél percig is eltarthat. Megvárjuk, amíg minden kérdés elkészül.</p></div>`;
    return;
  }
  if (room.phase === 'lobby') {
    const ready = room.players.filter(p => p.connected && p.ready).length;
    const count = room.players.filter(p => p.connected).length;
    stage.innerHTML = `<div class="lobby-stage"><div class="lobby-illustration"><span>?</span><i>✦</i><b>!</b></div><span class="eyebrow">${room.you.spectator ? 'NÉZŐTÉR' : 'MINDJÁRT KEZDÜNK'}</span><h2>${room.you.spectator ? 'Várjuk az első kérdést.' : room.you.host ? 'Mindenki itt van?' : 'Készen állsz egy jó kvízre?'}</h2><p>${room.you.spectator ? 'A kérdések és az eredmények itt is élőben jelennek meg.' : room.you.host ? 'Küldd körbe a meghívót. Amint mindenki készen áll, indulhat a játék.' : 'Jelezz a többieknek, ha kezdődhet. A szobagazda indítja a játékot.'}</p><div class="pack-tags"><span class="tag">${sourceName(room.pack?.source)}${room.pack?.source === 'pool' && room.pack.aiCount ? ` · ${room.pack.aiCount} AI-ból mentett` : ''}</span><span class="tag">${room.pack?.count || 0} kérdés</span><span class="tag tag-accent">${ready}/${count} készen áll</span></div>${room.pack?.warning ? `<div class="notice">${esc(room.pack.warning)}</div>` : ''}${!room.pack ? '<div class="notice">Ehhez a témához még elő kell készíteni a kérdéssort.</div>' : !room.pack.accepted ? `<div class="notice">Az AI kérdéssora elkészült. ${room.you.host ? 'Nézd át, majd fogadd el.' : 'Várunk a szobagazda jóváhagyására.'}</div>` : ''}${room.you.host ? `<div class="lobby-actions">${room.pack && !room.pack.accepted ? '<button class="button secondary" data-action="accept">Kérdéssor elfogadása ✓</button>' : ''}<button id="startGame" class="button primary large-button" data-action="start" ${room.readyToStart ? '' : 'disabled'}>Indulhat a kvíz →</button><span class="small muted">${room.readyToStart ? 'Mindenki készen áll.' : 'Várunk a kérdéssorra és a játékosok kész jelzésére.'}</span></div>` : !room.you.spectator ? `<button class="button ${room.you.ready ? 'secondary' : 'primary'} large-button" data-action="ready">${room.you.ready ? '✓ Készen állok · visszavonom' : 'Készen állok ✓'}</button>` : ''}</div>`;
    return;
  }
  if (room.phase === 'question') {
    const question = room.question;
    stage.innerHTML = `<div class="question-top"><span class="eyebrow">${String(question.index).padStart(2, '0')} / ${question.total} KÉRDÉS</span><span class="tag">${esc(question.category)}</span><span id="countdown" class="countdown">${Math.ceil(question.timeRemainingMs / 1000)}</span></div><div class="round-progress"><span style="width:${question.index / question.total * 100}%"></span></div><h2 class="question-text">${esc(question.text)}</h2><div class="answers">${question.options.map((option, index) => `<button type="button" class="answer ${room.you.selected === index ? 'selected' : ''}" data-answer="${index}" ${room.you.spectator || room.you.answered || question.timeRemainingMs <= 0 ? 'disabled' : ''}><span class="answer-letter">${'ABCD'[index]}</span><span>${esc(option)}</span>${room.you.selected === index ? '<span class="answer-check">✓</span>' : ''}</button>`).join('')}</div><div class="answer-hint">${room.you.spectator ? 'Nézőként követed a játékot.' : room.you.answered ? '✓ Válasz rögzítve. Várjuk a többieket…' : 'Válassz egyet. Minden jó válasz pontot ér.'}</div>`;
    return;
  }
  if (room.phase === 'result') {
    const result = room.result;
    const mine = result.details.find(d => d.id === room.you.id);
    stage.innerHTML = `<div class="question-top"><span class="eyebrow">${result.index}. KÉRDÉS · EREDMÉNY</span><span class="tag">${esc(result.category)}</span><span id="countdown" class="next-countdown"></span></div><div class="result-symbol ${mine && !mine.correct ? 'result-miss' : ''}">${room.you.spectator ? '✓' : mine?.correct ? '✓' : '↗'}</div><h2 class="result-title">${room.you.spectator ? 'Ez volt a helyes válasz.' : mine?.correct ? 'Szép válasz!' : mine?.option == null ? 'Ezt most kihagytad.' : 'Ezt most nem találtad el.'}</h2><div class="correct-answer"><span>${'ABCD'[result.correctIndex]}</span><strong>${esc(result.correct)}</strong>${mine?.correct ? `<b>+${mine.points}<small>pont</small></b>` : ''}</div><p class="explanation">${esc(result.explanation)}</p><div class="result-footer"><span>${result.fastest ? `Leggyorsabb: <b>${esc(result.fastest)}</b>` : 'Most nem érkezett helyes válasz.'}</span><span class="small muted">A Kvízmestert a meccs végén kérdezheted.</span></div><div class="round-details">${result.details.map(d => `<div class="${d.id === room.you.id ? 'is-you' : ''}"><span>${d.correct ? '✓' : d.option == null ? '–' : '×'} ${esc(d.nick)}</span><span>${d.timeMs == null ? 'nem válaszolt' : `${(d.timeMs / 1000).toFixed(2)} mp`}</span><strong>+${d.points}</strong></div>`).join('')}</div>`;
    return;
  }
  const leaders = winners(room.players), mine = isWinner(room);
  const title = mine ? leaders.length > 1 ? 'Közös győzelem! ✨' : 'Megnyerted a kört!' : leaders.length > 1 ? 'Holtverseny az élen!' : leaders.length ? `${esc(leaders[0].nick)} az élen!` : 'Megvolt a bemelegítés.';
  stage.innerHTML = `<div class="finish-stage ${mine ? 'is-winner' : ''}"><div class="${mine ? 'winner-emblem' : 'finish-confetti'}" aria-hidden="true">✦</div><span class="eyebrow">VÉGE A FORDULÓNAK</span><h2>${title}</h2><p class="${mine ? 'winner-caption' : ''}">${mine ? 'Egy kis csillogás jár érte. ' : ''}${room.history.length} kérdés, sok jó válasz. Jöhet még egy kör?</p><ol class="final-scoreboard">${room.players.map(p => `<li class="${p.id === room.you.id ? 'is-you' : ''}"><span>${room.players.filter(other => other.score > p.score).length + 1}.</span><b>${esc(p.nick)}</b><strong>${p.score}<small>pont</small></strong></li>`).join('')}</ol>${room.you.host ? '<button class="button primary large-button" data-action="new">Új forduló előkészítése →</button>' : room.you.spectator ? `<a class="button secondary" href="/join/${esc(room.id)}">A következő körben játszom →</a>` : '<p class="muted">A szobagazda előkészítheti a következő fordulót.</p>'}<a class="text-link" href="#reviewSection">Megnézem a kérdéseket és a magyarázatokat ↓</a></div>`;
}

function startTimer() {
  clearInterval(timer);
  const duration = room.phase === 'question' ? room.question.timeRemainingMs : room.phase === 'result' ? room.resultRemainingMs : 0;
  if (!['question', 'result'].includes(room.phase)) return;
  const end = performance.now() + duration;
  const update = () => {
    const left = Math.max(0, Math.ceil((end - performance.now()) / 1000));
    sound.tick(left);
    const element = $('#countdown'); if (element) { element.textContent = room.phase === 'result' ? `Következő: ${left} mp` : left; element.classList.toggle('urgent', left <= 3); }
    if (left === 0) { clearInterval(timer); document.querySelectorAll('[data-answer]').forEach(button => { button.disabled = true; }); }
  };
  timer = setInterval(update, 100); update();
}

function setupSound() {
  const isMuteButton = event => event.target.closest?.('#matchMute, #masterMute');
  document.addEventListener('pointerdown', event => { if (!isMuteButton(event)) void sound.unlock(); }, { capture: true });
  document.addEventListener('keydown', event => { if (!isMuteButton(event) && !event.repeat && ['Enter', ' '].includes(event.key)) void sound.unlock(); });
  const panel = $('#soundDialog');
  $('#soundSettings').addEventListener('click', () => { void sound.unlock(); if (!panel.open) panel.showModal(); });
  $('#closeSound').addEventListener('click', () => panel.close());
  function toggle() { const state = sound.state(); void sound.unlock(); sound.setPreferences({ muted: state.ready ? !state.muted : false }); }
  $('#matchMute').addEventListener('click', toggle); $('#masterMute').addEventListener('click', toggle);
  for (const id of ['musicEnabled', 'effectsEnabled']) $(`#${id}`).addEventListener('change', event => sound.setPreferences({ [id]: event.target.checked }));
  for (const id of ['musicVolume', 'effectsVolume']) $(`#${id}`).addEventListener('input', event => sound.setPreferences({ [id]: Number(event.target.value) }));
  sound.subscribe(state => {
    for (const id of ['musicEnabled', 'effectsEnabled']) $(`#${id}`).checked = state[id];
    for (const id of ['musicVolume', 'effectsVolume']) { $(`#${id}`).value = state[id]; $(`#${id}Level`).value = `${state[id]}%`; }
    $('#musicVolume').disabled = !state.musicEnabled; $('#effectsVolume').disabled = !state.effectsEnabled;
    $('#matchMute').disabled = !state.available;
    $('#matchMute').setAttribute('aria-pressed', String(state.muted));
    $('#matchMute').textContent = !state.available ? 'Hang nélkül' : state.muted ? 'Hang: ki' : state.ready ? 'Hang: be' : 'Hang indítása';
    $('#masterMute').textContent = state.muted ? 'Hangok bekapcsolása' : 'Összes hang némítása';
    $('#soundStatus').textContent = !state.available ? 'Ezen a böngészőn a hang nem érhető el. A játék továbbra is működik.' : state.muted ? 'A hangok most némítva vannak.' : state.ready ? 'A beállítások ezen az eszközön megmaradnak.' : 'A hang az első érintés után indulhat el.';
  });
  window.addEventListener('pagehide', () => { sound.pause(); celebration.stop(); clearInterval(timer); });
}

function renderHost() {
  $('#hostPanel').hidden = !room.you.host;
  $('#invitePanel').hidden = !room.you.host;
  if (!room.you.host) return;
  const playing = matchInProgress(room.phase);
  const key = JSON.stringify(room.settings);
  if (settingsKey !== key) { settingsKey = key; $('#roomSettings').innerHTML = settingsHTML(room.settings, meta.topics); }
  $('#settingsForm').querySelectorAll('input,select,button').forEach(el => { el.disabled = playing || room.preparing; });
  $('#useAI').disabled = playing || room.preparing || !room.ai.configured;
  if (!room.ai.configured) $('#useAI').checked = false;
  $('#aiStatus').textContent = 'Az általános kvíz a készletből indul. Egyedi témakörhöz az AI külön csomagot készít; kikapcsolva csak a mentett témákból választunk.';
  $('#prepareError').hidden = !room.prepareError;
  $('#prepareError').textContent = room.prepareError || '';
  $('#refillButton').disabled = playing || room.preparing || room.pool.refilling || room.pool.available >= room.pool.target || room.pool.nextRetryAt > Date.now();
  $('#prepareButton').textContent = room.preparing ? 'Készül a kérdéssor…' : room.phase === 'finished' ? 'Új forduló készítése' : 'Új kérdéssor készítése';
  $('#previewButton').disabled = playing || room.preparing || !room.pack;
  $('#exportButton').disabled = playing || room.preparing || !room.pack;
  $('#importPack').disabled = playing || room.preparing;
  if (lastInvite !== room.invitePath) {
    lastInvite = room.invitePath;
    $('#inviteURL').value = location.origin + room.invitePath;
    loadQR();
  }
}
async function loadQR() {
  try {
    const response = await fetch(`/api/rooms/${roomId}/invite.svg`, { headers: { authorization: `Bearer ${session.token}` }, cache: 'no-store' });
    if (!response.ok) throw new Error();
    if (qrObjectURL) URL.revokeObjectURL(qrObjectURL);
    qrObjectURL = URL.createObjectURL(await response.blob()); $('#inviteQR').src = qrObjectURL;
  } catch { $('#inviteQR').alt = 'A QR most nem tölthető be. Használd a meghívólinket.'; }
}

$('#gameStage').addEventListener('click', async event => {
  const answer = event.target.closest('[data-answer]');
  if (answer && !answer.disabled && room.phase === 'question' && !room.you.answered) {
    answer.parentElement.querySelectorAll('button').forEach(button => { button.disabled = true; });
    send({ type: 'answer', roundId: room.question.id, option: Number(answer.dataset.answer) }); return;
  }
  const action = event.target.closest('[data-action]')?.dataset.action;
  if (action === 'start') send({ type: 'start' });
  if (action === 'ready') send({ type: 'ready', ready: !room.you.ready });
  if (action === 'new') $('#settingsForm').requestSubmit();
  if (action === 'accept') { try { render(await api(`/api/rooms/${roomId}/accept`, { method: 'POST', token: session.token })); } catch (error) { toast(error.message, true); } }
  const chat = event.target.closest('[data-chat]'); if (chat) openChat(Number(chat.dataset.chat));
});
$('#copyInvite').addEventListener('click', async () => { try { await copy($('#inviteURL').value); toast('Meghívólink másolva. Küldheted a társaságnak.'); } catch (error) { toast(error.message, true); } });
$('#settingsForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#prepareButton').disabled = true;
  try {
    const prepared = await api(`/api/rooms/${roomId}/prepare`, { method: 'POST', token: session.token, body: { settings: settingsFrom(event.currentTarget), useAI: $('#useAI').checked } });
    render(prepared); toast(prepared.pack.source === 'ai' ? 'Az AI-kérdéssor elkészült. Nézd át és fogadd el.' : 'Új kérdéssor kész. Jöhet a kész jelzés!');
  } catch (error) { toast(error.message, true); if (room) renderHost(); }
});
suggestTopicCount($('#settingsForm'));
$('#refillButton').addEventListener('click', async () => {
  $('#refillButton').disabled = true;
  try { render(await api(`/api/rooms/${roomId}/refill`, { method: 'POST', token: session.token })); }
  catch (error) { toast(error.message, true); renderHost(); }
});

$('#previewButton').addEventListener('click', async () => {
  try {
    const pack = await api(`/api/rooms/${roomId}/pack`, { token: session.token });
    if (matchInProgress(room.phase)) return;
    previewQuestions = pack.questions;
    $('#previewQuestions').innerHTML = pack.questions.map((q, i) => `<details class="preview-card" data-preview-card="${i}" ${i === 0 ? 'open' : ''}><summary><span>${i + 1}.</span> ${esc(q.question)}</summary><label>Témakör<input name="category" value="${esc(q.category)}" maxlength="80" required></label><label>Kérdés<textarea name="question" maxlength="360" required rows="2">${esc(q.question)}</textarea></label><label>Helyes válasz<input name="correct" value="${esc(q.correct)}" maxlength="140" required></label>${q.wrong.slice(0, 3).map((answer, j) => `<label>${j + 1}. hibás válasz<input name="wrong${j}" value="${esc(answer)}" maxlength="140" required></label>`).join('')}<label>Magyarázat<textarea name="explanation" maxlength="700" required rows="3">${esc(q.explanation)}</textarea></label></details>`).join('');
    $('#previewMessage').textContent = ''; $('#previewDialog').showModal();
  } catch (error) { toast(error.message, true); }
});
$('#closePreview').addEventListener('click', () => $('#previewDialog').close());
$('#previewForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#savePreview').disabled = true;
  try {
    const questions = [...document.querySelectorAll('[data-preview-card]')].map((card, index) => ({ ...previewQuestions[index],
      category: card.querySelector('[name=category]').value, question: card.querySelector('[name=question]').value,
      correct: card.querySelector('[name=correct]').value, wrong: [0, 1, 2].map(n => card.querySelector(`[name=wrong${n}]`).value), explanation: card.querySelector('[name=explanation]').value }));
    render(await api(`/api/rooms/${roomId}/pack`, { method: 'PUT', token: session.token, body: { questions } }));
    $('#previewDialog').close(); toast('A kérdéssort elmentetted és elfogadtad.');
  } catch (error) { $('#previewMessage').textContent = error.message; }
  finally { $('#savePreview').disabled = false; }
});
$('#exportButton').addEventListener('click', async () => {
  try {
    const pack = await api(`/api/rooms/${roomId}/pack`, { token: session.token });
    const url = URL.createObjectURL(new Blob([JSON.stringify(pack, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'nolege-kerdescsomag.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Kérdéssor letöltve. Később a Betöltés gombbal visszahozhatod.');
  } catch (error) { toast(error.message, true); }
});
$('#importPack').addEventListener('change', async event => {
  const file = event.target.files?.[0]; if (!file) return;
  try {
    if (file.size > 90_000) throw new Error('A kérdéscsomag legfeljebb 90 kB lehet.');
    let pack; try { pack = JSON.parse(await file.text()); } catch { throw new Error('Ez nem érvényes JSON-kérdéscsomag.'); }
    render(await api(`/api/rooms/${roomId}/pack`, { method: 'PUT', token: session.token, body: { questions: Array.isArray(pack) ? pack : pack.questions, settings: pack.settings } }));
    toast('Kérdéscsomag betöltve és ellenőrizve.');
  } catch (error) { toast(error.message, true); }
  finally { event.target.value = ''; }
});
$('#closeRoom').addEventListener('click', async () => {
  if (!confirm('Bezárod a szobát? A játékosok kilépnek, a pontok elvesznek.')) return;
  try { await api(`/api/rooms/${roomId}`, { method: 'DELETE', token: session.token }); forgetSession(roomId); location.href = '/'; } catch (error) { toast(error.message, true); }
});

function renderReview() {
  $('#reviewSection').hidden = room.phase !== 'finished' || room.history.length === 0;
  if (matchInProgress(room.phase)) return;
  if (reviewLength === room.history.length) return;
  reviewLength = room.history.length;
  $('#reviewList').innerHTML = room.history.map(q => `<article class="review-card"><span class="review-number">${q.index}</span><div><span class="tag">${esc(q.category)}</span><h3>${esc(q.question)}</h3><p class="review-correct">✓ ${esc(q.correct)}</p><p class="muted">${esc(q.explanation)}</p>${!room.you.spectator ? `<button class="text-button" data-chat="${q.index}">Kérdezek erről a kvízmestertől ↗</button>` : ''}</div></article>`).join('');
  if (room.history.length && !room.history.some(q => q.index === selectedQuestionIndex)) selectedQuestionIndex = room.history.at(-1).index;
  $('#chatQuestion').innerHTML = room.history.map(q => `<option value="${q.index}" ${q.index === selectedQuestionIndex ? 'selected' : ''}>${q.index}. ${esc(q.question)}</option>`).join('');
}
$('#reviewList').addEventListener('click', event => { const button = event.target.closest('[data-chat]'); if (button) openChat(Number(button.dataset.chat)); });
function openChat(index) {
  if (room.phase !== 'finished') { toast('A Kvízmester a meccs végén lesz elérhető.'); return; }
  selectedQuestionIndex = index; $('#chatQuestion').value = index;
  renderChat(); if (!$('#chatDialog').open) $('#chatDialog').showModal(); $('#chatInput').focus();
}
function renderChat() {
  const question = room.history.find(q => q.index === selectedQuestionIndex); if (!question) return;
  $('#chatMode').textContent = room.ai.configured ? 'AI-kulcs beállítva. A beszélgetés nem módosítja a pontokat.' : 'Beépített segéd: mentett magyarázatok és játékszabályok. A szabad AI-beszélgetés még nincs csatlakoztatva.';
  const messages = chats.get(selectedQuestionIndex) || [];
  $('#chatMessages').innerHTML = `<div class="chat-message assistant"><span class="chat-source">A kérdés magyarázata</span><strong>${esc(question.correct)}</strong><p>${esc(question.explanation)}</p></div>` + messages.map(message => `<div class="chat-message ${message.role}">${message.role === 'assistant' ? `<span class="chat-source">${message.source === 'ai' ? 'AI-kvízmester' : 'Beépített segéd'}</span>` : ''}<p>${esc(message.content)}</p></div>`).join('');
  $('#chatMessages').scrollTop = $('#chatMessages').scrollHeight;
}
$('#chatQuestion').addEventListener('change', event => { selectedQuestionIndex = Number(event.target.value); renderChat(); });
$('#closeChat').addEventListener('click', () => $('#chatDialog').close());
$('#chatForm').addEventListener('submit', async event => {
  event.preventDefault(); if (room.phase !== 'finished') return;
  const message = $('#chatInput').value.trim(); if (!message) return;
  const index = selectedQuestionIndex; const messages = chats.get(index) || [];
  const gameId = room.gameId;
  const history = messages.slice(-4).map(({ role, content }) => ({ role, content }));
  messages.push({ role: 'user', content: message }); chats.set(index, messages); $('#chatInput').value = ''; renderChat();
  $('#chatSend').disabled = true; $('#chatInput').disabled = true; $('#chatSend').textContent = 'Gondolkodik…';
  try {
    const result = await api(`/api/rooms/${roomId}/chat`, { method: 'POST', token: session.token, body: { index, message, history } });
    if (room.gameId !== gameId || matchInProgress(room.phase)) return;
    messages.push({ role: 'assistant', content: result.answer, source: result.source });
    if (result.warning) toast(result.warning);
  } catch (error) { if (room.gameId === gameId && !matchInProgress(room.phase)) messages.push({ role: 'assistant', content: error.message, source: 'bank' }); }
  finally { $('#chatSend').disabled = false; $('#chatInput').disabled = false; $('#chatSend').textContent = 'Kérdezek ↗'; if (room.phase === 'finished') renderChat(); }
});

async function initialize() {
  if (!/^[a-z0-9]{6}$/.test(roomId)) { showError('Hiányzik vagy érvénytelen a szobakód.'); return; }
  if (!spectator && !session?.token) { location.replace(`/join/${roomId}`); return; }
  try {
    meta = await api('/api/meta');
    if (!spectator) render(await api(`/api/rooms/${roomId}/session`, { token: session.token }));
    connect();
    if (room?.you.host && !room.pack && !room.preparing && !room.prepareError && room.ai.configured) $('#settingsForm').requestSubmit();
  } catch (error) { connection('Nem sikerült kapcsolódni'); if (error.status === 401) forgetSession(roomId); showError(error.message, error.status === 401); }
}
setupSound();
initialize();
