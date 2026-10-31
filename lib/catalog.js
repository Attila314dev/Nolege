import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { QuizError, fold, validateQuestion } from './questions.js';

export const STATUSES = ['draft', 'review', 'approved', 'archived'];
export const SOURCES = ['manual', 'chatgpt', 'api', 'legacy'];
const iso = time => new Date(time).toISOString();
const short = (value, max = 100) => String(value ?? '').slice(0, max);

export function normalizeRecord(input, { existing, actor = 'Attila', now = Date.now(), source } = {}) {
  const valid = validateQuestion(input);
  const timestamp = iso(now);
  const suppliedId = typeof input.id === 'string' && /^[a-zA-Z0-9_-]{6,80}$/.test(input.id) ? input.id : randomUUID();
  const status = input.status ?? existing?.status ?? 'draft';
  if (!STATUSES.includes(status)) throw new QuizError('Érvénytelen kérdésállapot.');
  return { ...valid, id: existing?.id || suppliedId, status,
    source: SOURCES.includes(existing?.source) ? existing.source : source || (SOURCES.includes(input.source) ? input.source : actor === 'ChatGPT' ? 'chatgpt' : 'manual'),
    createdBy: short(existing?.createdBy || input.createdBy || actor),
    createdAt: existing?.createdAt || (Number.isFinite(Date.parse(input.createdAt)) ? input.createdAt : timestamp),
    updatedBy: actor, updatedAt: timestamp,
    ...(input.provider || existing?.provider ? { provider: short(existing?.provider || input.provider) } : {}),
    ...(input.model || existing?.model ? { model: short(existing?.model || input.model, 150) } : {}) };
}

export function validateCatalog(value) {
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.questions) || value.questions.length > 10000) throw new QuizError('Nem megfelelő kérdésbank-mentés.', 422, 'invalid_backup');
  const ids = new Set(), texts = new Set();
  const questions = value.questions.map(input => {
    const q = normalizeRecord(input, { existing: input, actor: input.updatedBy || input.createdBy || 'Korábbi bank', now: Number.isFinite(Date.parse(input.updatedAt)) ? Date.parse(input.updatedAt) : Date.now() });
    if (ids.has(q.id) || texts.has(fold(q.question))) throw new QuizError('Ismétlődő azonosító vagy kérdésszöveg van a mentésben.', 422, 'duplicate_question');
    ids.add(q.id); texts.add(fold(q.question)); return q;
  });
  return { schemaVersion: 1, revision: short(value.revision || randomUUID(), 80), questions,
    settings: { backgroundAI: value.settings?.backgroundAI === true },
    audit: Array.isArray(value.audit) ? value.audit.slice(-1000).map(item => ({ id: short(item.id), at: short(item.at), actor: short(item.actor), action: short(item.action), count: Number(item.count) || 0, detail: short(item.detail, 200) })) : [] };
}

export function loadCatalogSeed() {
  return validateCatalog(JSON.parse(fs.readFileSync(new URL('../bank/catalog.json', import.meta.url), 'utf8')));
}

export function createCatalog({ store, now = Date.now } = {}) {
  let state, pending = Promise.resolve();
  const listeners = new Set();
  const ready = store.read().then(value => { state = validateCatalog(value); });
  const notify = () => { for (const listener of listeners) listener(); };
  function filtered(filters = {}) {
    const search = fold(filters.search);
    return state.questions.filter(q => (!filters.status || q.status === filters.status)
      && (!filters.source || q.source === filters.source) && (!filters.category || q.category === filters.category)
      && (!filters.difficulty || q.difficulty === filters.difficulty)
      && (!search || fold(`${q.question} ${q.correct} ${q.category} ${q.tags.join(' ')}`).includes(search)));
  }
  function stats() {
    const count = (field, value) => state.questions.filter(q => q[field] === value).length;
    return { total: state.questions.length, active: state.questions.filter(q => q.status !== 'archived').length, goal: 1000,
      statuses: Object.fromEntries(STATUSES.map(status => [status, count('status', status)])),
      sources: Object.fromEntries(SOURCES.map(source => [source, count('source', source)])),
      categories: [...new Set(state.questions.map(q => q.category))].sort((a, b) => a.localeCompare(b, 'hu')) };
  }
  function mutate(revision, actor, action, work) {
    const task = pending.then(async () => {
      await ready;
      if (!store.writable) throw new QuizError('A tartós GitHub-mentés még nincs bekötve. Renderben a GITHUB_BANK_TOKEN változó szükséges.', 503, 'storage_not_configured');
      if (revision !== state.revision) throw new QuizError('Közben módosult a bank. Frissítsd az adatokat, majd ellenőrizd a változásodat.', 409, 'revision_conflict');
      const next = structuredClone(state);
      const result = work(next) || {};
      next.revision = randomUUID();
      next.audit.push({ id: randomUUID(), at: iso(now()), actor, action, count: result.count || 0, detail: short(result.detail || '', 200) });
      next.audit = next.audit.slice(-1000);
      const validated = validateCatalog(next);
      await store.write(validated, `Nolege bank: ${action} (${actor}, ${result.count || 0})`);
      state = validated; notify();
      return { revision: state.revision, ...result };
    });
    pending = task.catch(() => {});
    return task;
  }
  return {
    ready,
    status() { const extra = store.status?.() || {}; return { configured: store.writable, writable: store.writable && !(store.kind === 'github' && !extra.remote), kind: store.kind, ...extra }; },
    summary() { return { revision: state.revision, stats: stats(), storage: this.status(), settings: { ...state.settings } }; },
    list(filters = {}, page = 1) { const found = filtered(filters); return { ...this.summary(), total: found.length, page, pageSize: 25, questions: structuredClone(found.slice((page - 1) * 25, page * 25)) }; },
    selection(filters) { return filtered(filters).map(q => q.id); },
    get(id) { const q = state.questions.find(q => q.id === id); if (!q) throw new QuizError('Nincs ilyen kérdés.', 404); return structuredClone(q); },
    approved() { return state.questions.filter(q => q.status === 'approved').map(q => ({ ...q, catalogId: q.id })); },
    export(filters) { return { schemaVersion: 1, exportedAt: iso(now()), questions: structuredClone(filtered(filters)) }; },
    backup() { return structuredClone(state); },
    audit() { return structuredClone(state.audit.slice().reverse()); },
    history() { return store.history(); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    reload() {
      const task = pending.then(async () => { await ready; state = validateCatalog(await store.read()); notify(); return this.summary(); });
      pending = task.catch(() => {}); return task;
    },
    save(input, revision, actor) {
      return mutate(revision, actor, input.id ? 'question_updated' : 'question_created', next => {
        const index = next.questions.findIndex(q => q.id === input.id);
        if (input.id && index < 0) throw new QuizError('Nincs ilyen kérdés. Frissítsd a bankot.', 404);
        const q = normalizeRecord(index < 0 ? { ...input, createdBy: actor, createdAt: iso(now()) } : input, { existing: index >= 0 ? next.questions[index] : undefined, actor, now: now(), source: index < 0 ? actor === 'ChatGPT' ? 'chatgpt' : 'manual' : undefined });
        if (index >= 0) next.questions[index] = q; else next.questions.push(q);
        return { count: 1, id: q.id, detail: q.question.slice(0, 120) };
      });
    },
    bulk(ids, status, revision, actor) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !STATUSES.includes(status)) throw new QuizError('Jelölj ki kérdéseket és érvényes állapotot.');
      return mutate(revision, actor, `bulk_${status}`, next => {
        const wanted = new Set(ids); let count = 0;
        for (const q of next.questions) if (wanted.has(q.id)) { q.status = status; q.updatedBy = actor; q.updatedAt = iso(now()); count++; }
        if (count !== wanted.size) throw new QuizError('A kijelölés egy része már nem érhető el.', 409);
        return { count };
      });
    },
    import(items, revision, actor, source) {
      if (!Array.isArray(items) || !items.length || items.length > 5000) throw new QuizError('Az import 1–5000 kérdést tartalmazhat.');
      return mutate(revision, actor, 'questions_imported', next => {
        const present = new Set(next.questions.map(q => fold(q.question)));
        let count = 0, duplicates = 0;
        const ids = new Set(next.questions.map(q => q.id));
        for (const input of items) {
          const q = normalizeRecord({ ...input, status: 'review' }, { actor, now: now(), source });
          if (present.has(fold(q.question))) { duplicates++; continue; }
          if (ids.has(q.id)) q.id = randomUUID();
          present.add(fold(q.question)); ids.add(q.id); next.questions.push(q); count++;
        }
        return { count, duplicates };
      });
    },
    settings(settings, revision, actor) {
      return mutate(revision, actor, 'settings_updated', next => { next.settings = { ...next.settings, ...settings }; return { count: 1 }; });
    },
    restore(backup, revision, actor) {
      const validated = validateCatalog(backup);
      return mutate(revision, actor, 'backup_restored', next => { next.questions = validated.questions; next.settings = validated.settings; return { count: next.questions.length }; });
    },
    async restoreVersion(sha, revision, actor) { if (!store.atVersion) throw new QuizError('Ebben a tárolóban nincs távoli verzióelőzmény.', 422); return this.restore(await store.atVersion(sha), revision, actor); }
  };
}
