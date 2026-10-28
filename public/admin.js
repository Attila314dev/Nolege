import { $, esc, toast } from './common.js';
import { aiStatusView } from './ai-status.js';

const sourceLabels = { manual: 'Kézi', chatgpt: 'ChatGPT', api: 'AI-API', legacy: 'Korábbi bank' };
const stateLabels = { draft: 'Piszkozat', review: 'Ellenőrzendő', approved: 'Jóváhagyott', archived: 'Archivált' };
const difficulties = { easy: 'Könnyű', medium: 'Közepes', hard: 'Nehéz', mixed: 'Vegyes' };
const actionLabels = { question_created: 'Új kérdés', question_updated: 'Kérdés szerkesztése', questions_imported: 'Kérdések importálása', bulk_approved: 'Kérdések jóváhagyása', bulk_review: 'Ellenőrzésre jelölés', bulk_archived: 'Archiválás', bulk_draft: 'Piszkozattá alakítás', settings_updated: 'API-beállítások módosítása', backup_restored: 'Mentés visszaállítása' };
let session, summary, page = 1, listTotal = 0, pageItems = [], activeTab = 'bank';
let editorOriginal = null, editorRevision = '', preview = null, previewRevision = '', confirmWork;
let busy = false, searchTimer, listRequest = 0;
const selection = new Set();
const date = value => value ? new Date(value).toLocaleString('hu-HU', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Még nincs adat';
const number = value => Number(value || 0).toLocaleString('hu-HU');

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/api/admin${path}`, { method, credentials: 'same-origin', cache: 'no-store',
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(session?.csrf && method !== 'GET' ? { 'x-csrf-token': session.csrf } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(110_000) });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) showLogin();
    const error = new Error(data.error || 'A művelet nem sikerült.'); error.code = data.code; throw error;
  }
  return data;
}
function showLogin() { session = null; $('#workspace').hidden = true; $('#loginSection').hidden = false; $('#logoutButton').hidden = true; }
function updateWriteControls() {
  document.querySelectorAll('[data-write]').forEach(el => { el.disabled = busy || !summary?.storage.writable; });
}
function filters() { return Object.fromEntries(new FormData($('#filtersForm'))); }
function query() { return new URLSearchParams(filters()).toString(); }
function applySummary(value) {
  summary = value;
  const { stats, storage } = value;
  $('#adminActor').textContent = `${session.actor} · ${session.role === 'owner' ? 'tulajdonos' : 'asszisztens'}`;
  $('#workspaceSubtitle').textContent = `${number(stats.active)} kérdés a bankban · induló cél ${number(stats.goal)}`;
  $('#saveState').textContent = storage.writable ? 'Tartós mentés kapcsolódik ✓' : 'Mentési jogosultságra vár';
  $('#reviewBadge').textContent = stats.statuses.review ? number(stats.statuses.review) : '';
  $('#adminStats').innerHTML = [
    ['ÖSSZES KÉRDÉS', stats.total, `${Math.round(stats.active / stats.goal * 100)}% az induló célból`, ''],
    ['JÁTÉKRA KÉSZ', stats.statuses.approved, 'Jóváhagyott kérdések', 'accent'],
    ['ELLENŐRZÉSRE VÁR', stats.statuses.review, 'Átnézés után kerülhetnek játékba', 'warning'],
    ['CHATGPT-FORRÁS', stats.sources.chatgpt, 'Külön az API-val készültektől', '']
  ].map(([label, count, detail, cls]) => `<article class="stat-card ${cls}"><span class="stat-label">${label}</span><strong>${number(count)}</strong><small>${detail}</small></article>`).join('');
  const notice = $('#storageNotice');
  notice.hidden = storage.writable && !storage.error;
  notice.innerHTML = storage.error ? esc(storage.error) : 'A bankot már böngészheted és exportálhatod. A tartós szerkesztéshez a Render Environment részében szükséges a <code>GITHUB_BANK_TOKEN</code>: fine-grained GitHub-token, csak az <b>Attila314dev/Nolege</b> repóhoz, <b>Contents: Read and write</b> jogosultsággal. A kulcsot közvetlenül Renderbe add meg.';
  const selected = $('#categoryFilter').value;
  $('#categoryFilter').innerHTML = '<option value="">Minden témakör</option>' + stats.categories.map(category => `<option>${esc(category)}</option>`).join('');
  $('#categoryFilter').value = selected;
  $('#editorCategories').innerHTML = stats.categories.map(category => `<option value="${esc(category)}"></option>`).join('');
  updateWriteControls();
}
async function refreshSummary() { applySummary(await api('/summary')); if (activeTab === 'api') renderAPI(summary); }
async function loadQuestions() {
  const request = ++listRequest;
  const value = await api(`/questions?${query()}&page=${page}`);
  if (request !== listRequest) return;
  applySummary(value); listTotal = value.total; pageItems = value.questions;
  $('#listCount').textContent = `${number(listTotal)} találat · ${pageItems.length ? (page - 1) * 25 + 1 : 0}–${Math.min(page * 25, listTotal)}`;
  $('#questionList').innerHTML = pageItems.length ? pageItems.map(q => `<article class="admin-question ${selection.has(q.id) ? 'selected' : ''}"><input type="checkbox" class="question-select" data-select="${esc(q.id)}" aria-label="Kérdés kijelölése: ${esc(q.question)}" ${selection.has(q.id) ? 'checked' : ''}><button type="button" class="question-open" data-edit="${esc(q.id)}"><div class="question-badges"><span class="tag source-${q.source}">${sourceLabels[q.source] || 'Korábbi bank'}</span><span class="tag">${esc(q.category)}</span><span class="tag">${difficulties[q.difficulty]}</span></div><h3>${esc(q.question)}</h3><p class="answer-preview">✓ ${esc(q.correct)}</p></button><span class="status-badge status-${q.status}">${stateLabels[q.status]}</span></article>`).join('') : '<div class="admin-empty">Ehhez a szűréshez nincs kérdés. Próbálj másik témát vagy állapotot.</div>';
  $('#previousPage').disabled = page <= 1; $('#nextPage').disabled = page * 25 >= listTotal;
  $('#pageLabel').textContent = `${page} / ${Math.max(1, Math.ceil(listTotal / 25))}. oldal`;
  updateSelection();
}
function updateSelection() {
  $('#selectPage').checked = pageItems.length > 0 && pageItems.every(q => selection.has(q.id));
  $('#selectPage').indeterminate = pageItems.some(q => selection.has(q.id)) && !$('#selectPage').checked;
  $('#clearSelection').hidden = selection.size === 0;
  $('#bulkBar').hidden = selection.size === 0;
  $('#selectionCount').textContent = `${number(selection.size)} kérdés kijelölve`;
  document.querySelectorAll('[data-select]').forEach(input => { input.checked = selection.has(input.dataset.select); input.closest('article').classList.toggle('selected', input.checked); });
}
async function entered() {
  $('#loginSection').hidden = true; $('#workspace').hidden = false; $('#logoutButton').hidden = false;
  await loadQuestions();
}
$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; $('#loginButton').disabled = true; $('#loginError').textContent = '';
  try { session = await api('/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); form.elements.password.value = ''; await entered(); }
  catch (error) { $('#loginError').textContent = error.message; }
  finally { $('#loginButton').disabled = false; }
});
$('#logoutButton').addEventListener('click', async () => { try { await api('/logout', { method: 'POST', body: {} }); showLogin(); } catch (error) { toast(error.message, true); } });
$('#filtersForm').addEventListener('submit', event => event.preventDefault());
$('#filtersForm').addEventListener('input', event => {
  clearTimeout(searchTimer); page = 1; selection.clear();
  searchTimer = setTimeout(() => loadQuestions().catch(error => toast(error.message, true)), event.target.name === 'search' ? 250 : 0);
});
$('#previousPage').addEventListener('click', () => { page--; loadQuestions().catch(error => toast(error.message, true)); });
$('#nextPage').addEventListener('click', () => { page++; loadQuestions().catch(error => toast(error.message, true)); });
$('#reloadBank').addEventListener('click', async () => {
  const button = $('#reloadBank'); button.disabled = true;
  try { await api('/reload', { method: 'POST', body: {} }); selection.clear(); page = 1; await loadQuestions(); toast('A bank legutóbbi mentését betöltöttük.'); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; }
});
$('#selectPage').addEventListener('change', event => { for (const q of pageItems) event.target.checked ? selection.add(q.id) : selection.delete(q.id); updateSelection(); });
$('#clearSelection').addEventListener('click', () => { selection.clear(); updateSelection(); });
$('#selectAllResults').addEventListener('click', async () => {
  try { const data = await api(`/selection?${query()}`); data.ids.forEach(id => selection.add(id)); updateSelection(); }
  catch (error) { toast(error.message, true); }
});
$('#questionList').addEventListener('change', event => { const id = event.target.dataset.select; if (!id) return; event.target.checked ? selection.add(id) : selection.delete(id); updateSelection(); });
$('#questionList').addEventListener('click', event => { const button = event.target.closest('[data-edit]'); if (button) openQuestion(button.dataset.edit); });
function confirm(title, text, work) {
  confirmWork = work; $('#confirmTitle').textContent = title; $('#confirmText').textContent = text; $('#confirmError').textContent = ''; $('#confirmAction').disabled = false; $('#confirmDialog').showModal();
}
$('#confirmAction').addEventListener('click', async () => {
  $('#confirmAction').disabled = true;
  try { await confirmWork(); $('#confirmDialog').close(); }
  catch (error) { $('#confirmError').textContent = error.message; }
  finally { $('#confirmAction').disabled = false; }
});
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(`#${button.dataset.close}`).close()));
$('#bulkBar').addEventListener('click', event => {
  const status = event.target.dataset.bulk;
  if (!status || !selection.size) return;
  const ids = [...selection], revision = summary.revision;
  confirm(`${number(ids.length)} kérdés · ${stateLabels[status]}`, status === 'approved' ? 'A kijelölt kérdések a mentés után bekerülnek a játszható bankba. Ellenőrizted a megoldásokat és magyarázatokat?' : 'A kijelölt kérdések állapota módosul. Az eredeti forrás és az előzmények megmaradnak.', async () => {
    await api('/bulk', { method: 'POST', body: { ids, status, revision } }); selection.clear(); page = 1; await loadQuestions(); toast('Az állapotokat tartósan elmentettük.');
  });
});

async function openQuestion(id) {
  try {
    const result = id ? await api(`/questions/${id}`) : { question: null, revision: summary.revision };
    editorOriginal = result.question; editorRevision = result.revision;
    const form = $('#questionForm'); form.reset();
    const q = editorOriginal || { id: '', question: '', category: '', correct: '', wrong: ['', '', ''], explanation: '', difficulty: 'medium', status: 'draft' };
    for (const field of ['id', 'question', 'category', 'explanation', 'difficulty', 'status']) form.elements[field].value = q[field];
    [q.correct, ...q.wrong.slice(0, 3)].forEach((answer, i) => { form.elements[`answer${i}`].value = answer; });
    $('#editorEyebrow').textContent = id ? 'KÉRDÉS SZERKESZTÉSE' : 'ÚJ KÉZI KÉRDÉS';
    $('#questionProvenance').innerHTML = id ? `Forrás: <b>${sourceLabels[q.source]}</b> · Készítő: <b>${esc(q.createdBy)}</b><br>Bankba került: ${esc(date(q.createdAt))}<br>Utolsó módosítás: ${esc(q.updatedBy)} · ${esc(date(q.updatedAt))}${q.provider ? `<br>Szolgáltató: ${esc(q.provider)} · ${esc(q.model)}` : ''}` : 'Az új kérdés forrása: <b>Kézi</b>. A készítő és az időpont automatikusan rögzül.';
    $('#editorError').textContent = ''; updateWriteControls(); $('#questionDialog').showModal();
  } catch (error) { toast(error.message, true); }
}
$('#newQuestion').addEventListener('click', () => openQuestion());
$('#questionForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget; const data = new FormData(form);
  const answers = [0, 1, 2, 3].map(i => String(data.get(`answer${i}`)).trim()); const correctIndex = Number(data.get('correctIndex'));
  const question = { category: data.get('category'), question: data.get('question'), correct: answers[correctIndex], wrong: answers.filter((_, index) => index !== correctIndex), explanation: data.get('explanation'), difficulty: data.get('difficulty'), status: data.get('status'), ...(editorOriginal ? { tags: editorOriginal.tags, family: editorOriginal.family } : {}) };
  $('#saveQuestion').disabled = true; $('#editorError').textContent = '';
  try { await api(editorOriginal ? `/questions/${editorOriginal.id}` : '/questions', { method: editorOriginal ? 'PUT' : 'POST', body: { question, revision: editorRevision } }); $('#questionDialog').close(); await loadQuestions(); toast('A kérdést tartósan elmentettük.'); }
  catch (error) { $('#editorError').textContent = error.message; }
  finally { updateWriteControls(); }
});
async function download(path, filename) {
  const response = await fetch(`/api/admin${path}`, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error('A letöltés nem sikerült.');
  const url = URL.createObjectURL(await response.blob()); const link = document.createElement('a'); link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
}
$('#exportFiltered').addEventListener('click', () => download(`/export?${query()}`, 'nolege-kerdesek.json').catch(error => toast(error.message, true)));
$('#downloadBackup').addEventListener('click', () => download('/backup', `nolege-mentes-${new Date().toISOString().slice(0, 10)}.json`).catch(error => toast(error.message, true)));
async function readFile(file) { if (file.size > 10_000_000) throw new Error('Legfeljebb 10 MB-os JSON-fájlt válassz.'); try { return JSON.parse(await file.text()); } catch { throw new Error('A fájl nem érvényes JSON.'); } }
$('#bankImport').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const value = await readFile(file), questions = Array.isArray(value) ? value : value.questions;
    if (!Array.isArray(questions) || !questions.length) throw new Error('A fájlban nincs kérdéslista.');
    const revision = summary.revision;
    confirm(`${number(questions.length)} kérdés importálása`, 'Az új kérdések ellenőrzendő állapotba kerülnek. Az azonos szövegű kérdéseket kihagyjuk.', async () => {
      const result = await api('/import', { method: 'POST', body: { questions, revision } }); await loadQuestions(); toast(`${result.count} új kérdés mentve, ${result.duplicates} ismétlés kihagyva.`);
    });
  } catch (error) { toast(error.message, true); }
  finally { event.target.value = ''; }
});
$('#restoreFile').addEventListener('change', async event => {
  const file = event.target.files[0]; if (!file) return;
  try {
    const backup = await readFile(file), value = backup.catalog || backup;
    if (!Array.isArray(value.questions)) throw new Error('Ez nem teljes bankmentés.');
    const revision = summary.revision;
    confirm('Teljes bank visszaállítása', `${number(value.questions.length)} kérdésre állítod vissza a bankot. A jelenlegi kérdéslista helyére ez a mentés kerül; a visszaállítás új előzményként rögzül.`, async () => {
      await api('/restore', { method: 'POST', body: { backup, revision } }); selection.clear(); page = 1; await loadQuestions(); toast('A bankot visszaállítottuk és elmentettük.');
    });
  } catch (error) { toast(error.message, true); }
  finally { event.target.value = ''; }
});

function renderAPI(value) {
  applySummary(value);
  const state = aiStatusView(value.ai), details = value.diagnostics || {}, usage = details.usage || {}, free = details.quota?.freeModelDailyRequests;
  $('#apiOverview').innerHTML = `<div class="api-overview"><section class="panel api-health"><span class="eyebrow">UTOLSÓ VALÓDI MODELLHÍVÁS</span><h3 class="ai-indicator ai-${state.tone}"><span class="ai-dot"></span>${esc(state.title)}</h3><p class="small muted">${esc(state.detail)}</p><p class="small muted">${esc(date(value.ai.lastCompletedAt))}</p><p class="small muted">Legutóbbi siker: ${esc(date(value.ai.lastSuccessAt))}</p><div class="api-key-row">${['OpenRouter', 'Groq'].map(name => { const provider = details.providers?.find(p => p.name === name); return `<span>${name}: ${value.ai.providers.includes(name) ? '•••••••• · beállítva ✓' : 'nincs beállítva'}${provider ? `<br>${esc(provider.model)}` : ''}</span>`; }).join('')}</div></section><div class="api-metrics"><article class="stat-card"><span class="stat-label">MODELLHÍVÁSOK</span><strong>${number(usage.requests)}</strong><small>Az alkalmazás indulása óta</small></article><article class="stat-card"><span class="stat-label">ÖSSZES TOKEN</span><strong>${number(usage.totalTokens)}</strong><small>${number(usage.promptTokens)} bemenet · ${number(usage.completionTokens)} kimenet</small></article><article class="stat-card accent"><span class="stat-label">NAPI INGYENES KÉRÉSEK</span><strong>${free ? `${number(free.used)} / ${number(free.limit)}` : '—'}</strong><small>${free ? `${number(free.remaining)} kérés maradt` : 'Frissítsd a szolgáltatói adatokat'}</small></article><article class="stat-card"><span class="stat-label">SZOLGÁLTATÓI LEKÉRDEZÉS</span><strong>${details.inspectedAt ? 'Frissítve' : '—'}</strong><small>${esc(details.inspectedAt ? date(details.inspectedAt) : 'Állapotfrissítés: modellgenerálás nélkül')}</small></article></div>${details.lastError ? `<section class="api-error"><strong>Pontosabb hibajelzés · ${esc(details.lastError.code)}${details.lastError.httpStatus ? ` / HTTP ${details.lastError.httpStatus}` : ''}</strong><p>${esc(details.lastError.message || value.ai.lastError?.message || '')}</p>${details.lastError.raw ? `<p>${esc(details.lastError.raw)}</p>` : ''}<p class="small muted">Érintett modell: ${esc(details.lastError.model || 'nincs adat')} · Eredet: ${esc({ provider: 'háttérszolgáltató', account: 'fiók napi kerete', unknown: 'nem azonosított korlát' }[details.lastError.scope] || 'egyéb hiba')}</p><details><summary>Technikai részletek</summary><pre>${esc(JSON.stringify(details.lastError, null, 2))}</pre></details></section>` : ''}${details.quotaError ? `<div class="notice">${esc(details.quotaError)}</div>` : ''}</div>`;
  const form = $('#apiSettingsForm');
  // Do not replace a model name the operator is currently typing.
  if (!form.contains(document.activeElement)) { form.elements.openRouterModel.value = value.settings.openRouterModel; form.elements.backgroundAI.checked = value.settings.backgroundAI; }
  const models = [...new Map([{ id: value.settings.openRouterModel, name: value.settings.openRouterModel }, { id: 'openrouter/free', name: 'Automatikus ingyenes modell' }, ...(details.freeModels || [])].map(model => [model.id, model])).values()];
  $('#freeModelOptions').innerHTML = models.map(model => `<option value="${esc(model.id)}">${esc(model.name)}</option>`).join('');
  $('#requestLog').innerHTML = details.recent?.length ? `<div class="table-scroll"><table class="admin-table"><thead><tr><th>IDŐPONT</th><th>MŰVELET</th><th>MODELL</th><th>EREDMÉNY</th><th>TOKEN</th></tr></thead><tbody>${details.recent.map(item => `<tr><td>${esc(date(item.at))}</td><td>${esc({ generate: 'Generálás', chat: 'Kvízmester', 'connection-test': 'Kapcsolatteszt' }[item.operation] || item.operation)}</td><td class="model-cell">${esc(item.model)}</td><td>${item.ok ? 'Válasz érkezett' : esc(item.code)}<br><span class="muted">${number(item.durationMs)} ms</span></td><td>${item.totalTokens == null ? '—' : number(item.totalTokens)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">Ebben az alkalmazásindításban még nem történt modellhívás.</p>';
}
$('#refreshAPI').addEventListener('click', async () => {
  const button = $('#refreshAPI'); button.disabled = true; button.textContent = 'Állapot lekérése…';
  try { renderAPI(await api('/api-status?refresh=1')); toast('A szolgáltatói adatokat frissítettük. Kérdésgenerálás nem indult.'); }
  catch (error) { toast(error.message, true); }
  finally { button.disabled = false; button.textContent = 'Állapot frissítése ↻'; }
});
$('#testAPI').addEventListener('click', async () => {
  const button = $('#testAPI'); button.disabled = true; button.textContent = 'Kapcsolatteszt folyamatban…';
  try { const result = await api('/api-test', { method: 'POST', body: {} }); renderAPI(result); toast(`Az API válaszolt: ${result.result.answer}`); }
  catch (error) { toast(error.message, true); try { renderAPI(await api('/api-status')); } catch {} }
  finally { button.disabled = false; button.textContent = 'Kapcsolatteszt · AI-kéréssel'; }
});
$('#apiSettingsForm').addEventListener('submit', async event => {
  event.preventDefault(); const form = event.currentTarget;
  try { renderAPI(await api('/settings', { method: 'PUT', body: { revision: summary.revision, settings: { openRouterModel: form.elements.openRouterModel.value.trim(), backgroundAI: form.elements.backgroundAI.checked } } })); toast('A beállításokat elmentettük.'); }
  catch (error) { toast(error.message, true); }
});
$('#generateForm').addEventListener('submit', async event => {
  event.preventDefault(); const values = Object.fromEntries(new FormData(event.currentTarget));
  $('#generateButton').disabled = true; $('#generationMessage').textContent = 'A kérdések készülnek… Ez akár másfél percig is eltarthat.';
  try {
    preview = await api('/generate', { method: 'POST', body: { settings: { ...values, count: Number(values.count) } } }); previewRevision = summary.revision;
    $('#generationTitle').textContent = `${preview.questions.length} új kérdés érkezett.`;
    $('#generatedQuestions').innerHTML = preview.questions.map((q, index) => `<details class="preview-card" data-generated="${index}" ${index === 0 ? 'open' : ''}><summary>${index + 1}. ${esc(q.question)}</summary><label>Kérdés<textarea name="question" maxlength="360" rows="2" required>${esc(q.question)}</textarea></label><label>Témakör<input name="category" value="${esc(q.category)}" maxlength="80" required></label><label>Helyes válasz<input name="correct" value="${esc(q.correct)}" maxlength="140" required></label>${q.wrong.slice(0, 3).map((answer, i) => `<label>${i + 1}. hibás válasz<input name="wrong${i}" value="${esc(answer)}" maxlength="140" required></label>`).join('')}<label>Magyarázat<textarea name="explanation" rows="2" maxlength="700" required>${esc(q.explanation)}</textarea></label></details>`).join('');
    $('#previewError').textContent = ''; $('#generationMessage').textContent = 'A csomag elkészült. Az előnézetben átnézheted.'; $('#generationDialog').showModal();
  } catch (error) { $('#generationMessage').textContent = error.message; }
  finally { updateWriteControls(); try { renderAPI(await api('/api-status')); } catch {} }
});
$('#generationPreviewForm').addEventListener('submit', async event => {
  event.preventDefault(); $('#saveGenerated').disabled = true;
  const questions = [...document.querySelectorAll('[data-generated]')].map((card, i) => ({ ...preview.questions[i],
    question: card.querySelector('[name=question]').value, category: card.querySelector('[name=category]').value, correct: card.querySelector('[name=correct]').value,
    wrong: [0, 1, 2].map(n => card.querySelector(`[name=wrong${n}]`).value), explanation: card.querySelector('[name=explanation]').value }));
  try { const result = await api(`/generated/${preview.generationId}/import`, { method: 'POST', body: { questions, revision: previewRevision } }); $('#generationDialog').close(); await refreshSummary(); toast(`${result.count} AI-kérdés mentve ellenőrzésre.`); }
  catch (error) { $('#previewError').textContent = error.message; }
  finally { updateWriteControls(); }
});

async function loadHistory() {
  const result = await api('/history');
  $('#historyList').innerHTML = result.history.length ? result.history.map(item => `<article class="history-entry"><div><p>${esc(item.message)}</p><small>${esc(date(item.date))} · ${esc(item.sha.slice(0, 8))}</small></div><button class="button quiet" data-restore-version="${item.sha}" data-write>Erre állítom vissza</button></article>`).join('') : '<p class="small muted">Ebben a tárolóban még nincs távoli verzióelőzmény.</p>';
  updateWriteControls();
}
$('#refreshHistory').addEventListener('click', () => loadHistory().catch(error => toast(error.message, true)));
$('#historyList').addEventListener('click', event => {
  const sha = event.target.dataset.restoreVersion; if (!sha) return; const revision = summary.revision;
  confirm('Korábbi bankverzió visszaállítása', `A ${sha.slice(0, 8)} verzió kérdéseit és beállításait töltöd vissza. A művelet új mentésként jelenik meg.`, async () => {
    await api('/restore-version', { method: 'POST', body: { sha, revision } }); await refreshSummary(); toast('A korábbi bankverziót visszaállítottuk.'); await loadHistory();
  });
});
async function loadAudit() {
  const result = await api('/audit');
  $('#auditList').innerHTML = result.entries.length ? result.entries.map(item => `<article class="audit-entry"><div><p>${esc(actionLabels[item.action] || item.action)}${item.count ? ` · ${number(item.count)} kérdés/adat` : ''}</p><small>${esc(date(item.at))}${item.detail ? `<br>${esc(item.detail)}` : ''}</small></div><strong class="audit-who">${esc(item.actor)}</strong></article>`).join('') : '<p class="small muted">A következő mentett módosítás már itt fog megjelenni.</p>';
}
$('#refreshAudit').addEventListener('click', () => loadAudit().catch(error => toast(error.message, true)));
document.querySelector('.admin-tabs').addEventListener('click', async event => {
  const tab = event.target.closest('[data-tab]')?.dataset.tab; if (!tab) return;
  activeTab = tab; document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === tab));
  for (const name of ['bank', 'api', 'backups', 'audit']) $(`#${name}Pane`).hidden = name !== tab;
  try { if (tab === 'bank') await loadQuestions(); if (tab === 'api') renderAPI(await api('/api-status')); if (tab === 'audit') await loadAudit(); }
  catch (error) { toast(error.message, true); }
});

try { session = await api('/session'); if (session.authenticated) await entered(); else showLogin(); }
catch (error) { showLogin(); $('#loginError').textContent = error.message; }
