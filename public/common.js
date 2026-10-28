export const $ = selector => document.querySelector(selector);
export const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export async function api(path, { method = 'GET', body, token } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 110_000);
  try {
    const response = await fetch(path, { method, cache: 'no-store', signal: controller.signal,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'A kérés nem sikerült.'); error.code = result.code; error.status = response.status; throw error; }
    return result;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('A kérés túl sokáig tartott. Próbáld újra.');
    if (error instanceof TypeError) throw new Error('Nem érhető el a szerver. Ellenőrizd a kapcsolatot.');
    throw error;
  } finally { clearTimeout(timeout); }
}
function readStorage(key, tabFirst = false) {
  for (const storage of tabFirst ? ['sessionStorage', 'localStorage'] : ['localStorage', 'sessionStorage']) { try { const value = window[storage].getItem(key); if (value) return value; } catch {} }
  return null;
}
function writeStorage(key, value) {
  for (const storage of ['localStorage', 'sessionStorage']) { try { window[storage].setItem(key, value); return; } catch {} }
  throw new Error('A belépéshez engedélyezni kell a böngésző helyi tárolását.');
}
export const savedNick = () => readStorage('nolege:nick') || '';
export function saveSession(id, session, nick) {
  const key = `nolege:session:${id}`;
  const value = JSON.stringify({ token: session.playerToken, playerId: session.playerId, nick });
  try { window.sessionStorage.setItem(key, value); } catch {}
  writeStorage(key, value);
  writeStorage('nolege:nick', nick);
}
export function getSession(id) { try { return JSON.parse(readStorage(`nolege:session:${id}`, true)); } catch { return null; } }
export function forgetSession(id) { for (const storage of ['localStorage', 'sessionStorage']) { try { window[storage].removeItem(`nolege:session:${id}`); } catch {} } }
export function settingsFrom(form) {
  const data = new FormData(form);
  return { topic: String(data.get('topic') || '').trim(), count: Number(data.get('count')), timeLimitSec: Number(data.get('timeLimitSec')), difficulty: String(data.get('difficulty') || 'mixed') };
}
export function settingsHTML(settings = {}, topics = []) {
  return `<label>Témakör <span class="optional">opcionális</span><input name="topic" list="topicSuggestions" maxlength="120" placeholder="Általános kvíz" value="${esc(settings.topic || '')}" autocomplete="off"></label>
    <datalist id="topicSuggestions">${topics.map(t => `<option value="${esc(t.name)}">${t.count} mentett kérdés</option>`).join('')}</datalist>
    <div class="form-row"><label>Kérdések száma<input name="count" type="number" min="1" max="30" required value="${settings.count || 15}"></label><label>Válaszidő<select name="timeLimitSec">${[10, 15, 20, 30].map(n => `<option value="${n}" ${n === (settings.timeLimitSec || 10) ? 'selected' : ''}>${n} másodperc</option>`).join('')}</select></label></div>
    <label>Nehézség<select name="difficulty">${[['mixed', 'Vegyes'], ['easy', 'Könnyű'], ['medium', 'Közepes'], ['hard', 'Nehéz']].map(([v, label]) => `<option value="${v}" ${v === (settings.difficulty || 'mixed') ? 'selected' : ''}>${label}</option>`).join('')}</select></label>`;
}
export function suggestTopicCount(form) {
  form.addEventListener('input', event => {
    const count = form.querySelector('[name=count]');
    if (event.target === count) count.dataset.chosen = 'true';
    if (event.target.name === 'topic' && !count.dataset.chosen) count.value = event.target.value.trim() ? 20 : 15;
  });
}
let toastTimer;
export function toast(message, error = false) {
  const el = $('#toast'); if (!el) return;
  el.textContent = message; el.classList.toggle('error', error); el.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, 6000);
}
export async function copy(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const input = document.createElement('textarea'); input.value = text; document.body.append(input); input.select();
  const success = document.execCommand('copy'); input.remove(); if (!success) throw new Error('A másolás nem sikerült. Jelöld ki a linket kézzel.');
}
export const sourceName = source => ({ ai: 'Most generált AI-kérdések', pool: 'Mentett készletből', edited: 'Saját kérdéssor', bank: 'Tartalék kérdésbank' }[source] || 'Kérdéssor');
