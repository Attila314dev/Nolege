import { $, api, esc, getSession, saveSession, savedNick, settingsFrom, settingsHTML, suggestTopicCount, toast } from './common.js';
import { renderAIStatus } from './ai-status.js';

let meta = { topics: [], ai: { configured: false } };
const invitedRoom = location.pathname.match(/^\/join\/([a-z0-9]+)$/i)?.[1]?.toLowerCase();
const invite = new URLSearchParams(location.search).get('invite') || '';
$('#hostNick').value = savedNick(); $('#guestNick').value = savedNick();
$('#createSettings').innerHTML = settingsHTML();
suggestTopicCount($('#createForm'));

async function refreshStatus() {
  if (document.hidden) return;
  try { meta = await api('/api/meta'); renderAIStatus($('#homeAIStatus'), meta.ai, meta.pool); }
  catch { $('#homeAIStatus').textContent = 'Az állapotot most nem tudjuk frissíteni.'; }
}

async function initialize() {
  try {
    meta = await api('/api/meta');
    $('#createSettings').innerHTML = settingsHTML({}, meta.topics);
    $('#bankCount').textContent = `${meta.bankCount} mentett kérdés`;
    renderAIStatus($('#homeAIStatus'), meta.ai, meta.pool);
    $('#aiNote').textContent = meta.ai.configured
      ? 'Az általános kvíz az előkészített készletből indul. Egyedi témához külön AI-kérdéssor készül.'
      : 'Általános, tematikus és Harry Potter-kvíz is játszható a mentett bankból. Az AI-kulcs később kapcsolja be az egyéni kérdésgenerálást.';
  } catch (error) { toast(error.message, true); }
  if (invitedRoom) {
    $('#hero').hidden = true; $('#createPanel').hidden = true; $('#roomsSection').hidden = true;
    document.body.classList.add('invite-mode');
    $('#roomCode').value = invitedRoom; $('#roomCodeLabel').hidden = true;
    $('#joinTitle').textContent = 'Csatlakozz a kvízhez';
    $('#joinSubtitle').textContent = 'Csak egy becenév, és bent is vagy.';
    await inspectRoom(invitedRoom);
  } else loadRooms();
}

async function inspectRoom(id) {
  $('#joinMessage').textContent = '';
  if (id.length !== 6) return null;
  try {
    const room = await api(`/api/rooms/${encodeURIComponent(id)}?invite=${encodeURIComponent(invite)}`);
    $('#joinPasswordLabel').hidden = !room.requiresPassword;
    $('#joinPassword').required = room.requiresPassword;
    $('#spectatorLink').href = `/room.html?room=${encodeURIComponent(id)}&spectator=1`;
    $('#spectatorLink').hidden = false;
    const existing = getSession(id);
    if (existing) {
      $('#joinMessage').innerHTML = `<a class="text-link" href="/room.html?room=${esc(id)}">Visszalépek ${esc(existing.nick)} néven →</a>`;
    }
    if (room.running) {
      $('#joinButton').disabled = true;
      $('#joinMessage').textContent = 'A játék már fut. Nézőként most is csatlakozhatsz; a következő forduló előtt beszállhatsz.';
    } else $('#joinButton').disabled = false;
    if (invitedRoom) {
      $('#inviteBanner').hidden = false;
      $('#inviteBanner').innerHTML = `<span class="eyebrow">MEGHÍVTAK EGY KVÍZRE</span><h1>${esc(room.hostNick)} szobája</h1><p>${esc(room.settings.topic || 'Általános kvíz')} · ${room.settings.count} kérdés · <span class="mono">${esc(room.id.toUpperCase())}</span></p>`;
    }
    return room;
  } catch (error) { $('#joinMessage').textContent = error.message; $('#joinButton').disabled = true; return null; }
}
$('#roomCode').addEventListener('input', () => { $('#roomCode').value = $('#roomCode').value.replace(/[^a-z0-9]/gi, ''); $('#joinButton').disabled = false; });
$('#roomCode').addEventListener('change', () => inspectRoom($('#roomCode').value.trim().toLowerCase()));

$('#createForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#createButton'); button.disabled = true; $('#createMessage').textContent = 'Készül a szobád…';
  try {
    const data = new FormData(event.currentTarget); const nick = String(data.get('nick')).trim();
    const session = await api('/api/createRoom', { method: 'POST', body: { nick, password: data.get('password'), settings: settingsFrom(event.currentTarget) } });
    saveSession(session.roomId, session, nick);
    location.href = `/room.html?room=${session.roomId}`;
  } catch (error) { $('#createMessage').textContent = error.message; button.disabled = false; }
});
$('#joinForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = $('#joinButton'); button.disabled = true;
  const data = new FormData(event.currentTarget); const id = String(data.get('roomId')).trim().toLowerCase(); const nick = String(data.get('nick')).trim();
  try {
    const room = await inspectRoom(id); if (!room || room.running) return;
    if (room.requiresPassword && !$('#joinPassword').value) { $('#joinMessage').textContent = 'Ehhez a szobához jelszó kell.'; $('#joinPassword').focus(); return; }
    const session = await api('/api/join', { method: 'POST', body: { roomId: id, nick, password: $('#joinPassword').value, invite } });
    saveSession(id, session, nick); location.href = `/room.html?room=${id}`;
  } catch (error) { $('#joinMessage').textContent = error.message; }
  finally { button.disabled = false; }
});

async function loadRooms() {
  if (invitedRoom || document.hidden) return;
  try {
    const rooms = await api('/api/rooms');
    $('#roomList').innerHTML = rooms.length ? rooms.map(room => `<article class="room-card"><div class="room-card-top"><span class="room-code mono">${esc(room.id.toUpperCase())}</span><span class="tag ${room.running ? 'tag-accent' : ''}">${room.running ? 'Játék folyamatban' : 'Csatlakozhatsz'}</span></div><h3>${esc(room.hostNick)} szobája</h3><p>${esc(room.topic)} · ${room.count} kérdés · ${room.players} online${room.password ? ' · Jelszavas' : ''}</p>${room.running ? `<a class="button secondary wide" href="/room.html?room=${esc(room.id)}&spectator=1">Megnézem →</a>` : `<button type="button" class="button secondary wide" data-join="${esc(room.id)}">Csatlakozom →</button>`}</article>`).join('') : '<div class="empty-state"><span>✦</span><h3>Tiétek az első kör.</h3><p>Nyiss egy szobát, és hívd meg a társaságot.</p></div>';
  } catch { $('#roomList').innerHTML = '<div class="empty-state">A szobalista most nem érhető el. A meghívólinkkel továbbra is próbálkozhatsz.</div>'; }
}
$('#roomList').addEventListener('click', async event => {
  const button = event.target.closest('[data-join]'); if (!button) return;
  $('#roomCode').value = button.dataset.join; await inspectRoom(button.dataset.join);
  $('#joinPanel').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('#guestNick').focus();
});
$('#refreshRooms').addEventListener('click', loadRooms);
setInterval(loadRooms, 8000);
setInterval(refreshStatus, 15_000);
initialize();
