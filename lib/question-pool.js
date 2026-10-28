import { bankPack, bankPool, fold, validatePack, validateQuestion } from './questions.js';

const keyOf = question => fold(question.question);
const dayOf = time => new Date(time).toISOString().slice(0, 10);

export function createQuestionPool({ bank, ai, store, now = Date.now, target = 100,
  batchSize = 20, lowWater = 80, retryMs = 5 * 60_000, dailyLimit = 12, autoRefill = true,
  approvedOnly = false, onGenerated } = {}) {
  let allowAI = !approvedOnly;
  let questions = [], used = new Map(), refilling = null, closed = false;
  let lastRefillAt = null, lastError = null, nextRetryAt = 0, storageError = null;
  let refillDay = dayOf(now()), dailyCalls = 0, timer;
  let writes = Promise.resolve(), canWrite = true;
  const listeners = new Set();
  function changed() { for (const listener of listeners) { try { listener(); } catch {} } }
  function savedState() {
    return { version: 1, questions, used: [...used].slice(-5000), lastRefillAt, lastError,
      nextRetryAt, refillDay, dailyCalls };
  }
  function persist() {
    if (closed || !store || !canWrite) return;
    const state = structuredClone(savedState());
    writes = writes.then(async () => {
      try { await store.write(state); storageError = null; }
      catch { storageError = 'A készlet mentése most nem sikerült. A játék tovább működik.'; }
      changed();
    });
  }
  const ready = (async () => {
    let saved;
    try { saved = await store?.read(); }
    catch { canWrite = false; storageError = 'A mentett készlet nem érhető el; a beépített bankból indulunk.'; }
    if (saved?.version === 1 && Array.isArray(saved.questions) && Array.isArray(saved.used)) {
      used = new Map(saved.used.filter(entry => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string').slice(-5000));
      const seen = new Set();
      for (const item of saved.questions.slice(0, target)) {
        try {
          const question = { ...validateQuestion(item), origin: item.origin === 'ai' ? 'ai' : 'bank' };
          const key = keyOf(question);
          if (!seen.has(key) && !used.has(key) && (!approvedOnly || bank.some(q => keyOf(q) === key))) { questions.push(question); seen.add(key); }
        } catch { /* Invalid persisted questions are discarded individually. */ }
      }
      lastRefillAt = Number(saved.lastRefillAt) || null;
      nextRetryAt = Math.min(Number(saved.nextRetryAt) || 0, now() + 24 * 60 * 60_000);
      // Only persist safe, application-owned messages.
      lastError = typeof saved.lastError === 'string' ? saved.lastError.slice(0, 300) : null;
      if (saved.refillDay === refillDay) dailyCalls = Math.max(0, Math.min(dailyLimit, Number(saved.dailyCalls) || 0));
    }
    // The initial 100 questions are usable without an AI call or a startup wait.
    const present = new Set(questions.map(keyOf));
    const fresh = bank.filter(q => !used.has(keyOf(q)) && !present.has(keyOf(q)));
    if (questions.length < target && fresh.length) {
      const seeded = bankPack(fresh, { topic: '', difficulty: 'mixed', count: Math.min(target - questions.length, fresh.length) });
      questions.push(...seeded.map(q => ({ ...q, origin: 'bank' })));
    }
    persist();
  })();

  function addApproved() {
    const present = new Set(questions.map(keyOf));
    const fresh = bank.filter(q => !used.has(keyOf(q)) && !present.has(keyOf(q)));
    const count = Math.min(target - questions.length, fresh.length);
    if (count > 0) questions.push(...bankPack(fresh, { topic: '', difficulty: 'mixed', count }).map(q => ({ ...q, origin: q.source === 'api' ? 'ai' : 'bank' })));
    return Math.max(0, count);
  }

  function schedule(continueFilling = false) {
    clearTimeout(timer);
    const hasFresh = approvedOnly && bank.some(q => !used.has(keyOf(q)) && !questions.some(item => keyOf(item) === keyOf(q)));
    if (closed || !autoRefill || (!hasFresh && (!allowAI || !ai.status().configured)) || questions.length >= target || (!continueFilling && questions.length > lowWater)) return;
    timer = setTimeout(() => void refill(), Math.max(20, nextRetryAt - now()));
    timer.unref?.();
  }
  function take(settings) {
    if (settings.topic) throw new Error('The general pool only serves general quizzes');
    const availableKeys = new Set(questions.map(keyOf));
    const unusedBank = bank.filter(q => !availableKeys.has(keyOf(q)) && !used.has(keyOf(q))).map(q => ({ ...q, origin: 'bank' }));
    let candidates = [...questions];
    if (bankPool(candidates, settings).length < settings.count) candidates.push(...unusedBank);
    let warning = '';
    if (bankPool(candidates, settings).length < settings.count) {
      // The emergency bank keeps parties playable when an API quota is exhausted.
      // Its reuse is explicit; a failed thematic request never enters this branch.
      const existing = new Set(candidates.map(keyOf));
      candidates.push(...bank.filter(q => !existing.has(keyOf(q))).map(q => ({ ...q, origin: 'bank' })));
      warning = 'A friss készlet ennél a nehézségnél elfogyott. A tartalék bankból korábbi kérdések is visszatérhetnek.';
    }
    const selected = bankPack(candidates, settings);
    const selectedKeys = new Set(selected.map(keyOf));
    const origin = new Map(candidates.map(q => [keyOf(q), q.origin]));
    questions = questions.filter(q => !selectedKeys.has(keyOf(q)));
    for (const q of selected) used.set(keyOf(q), q.question);
    if (used.size > 5000) used = new Map([...used].slice(-5000));
    persist(); changed(); schedule();
    return { questions: selected, source: 'pool', accepted: true, warning,
      aiCount: selected.filter(q => origin.get(keyOf(q)) === 'ai').length };
  }
  async function doRefill() {
    await ready;
    if (closed || questions.length >= target) return;
    if (approvedOnly && addApproved()) { lastError = null; nextRetryAt = 0; persist(); }
    if (questions.length >= target || !allowAI || !ai.status().configured || now() < nextRetryAt) return;
    if (dayOf(now()) !== refillDay) { refillDay = dayOf(now()); dailyCalls = 0; }
    if (dailyCalls >= dailyLimit) {
      lastError = 'A háttérfeltöltés mai keretét elértük. A meglévő kérdésekből tovább játszhattok.';
      nextRetryAt = Date.parse(`${refillDay}T00:00:00Z`) + 24 * 60 * 60_000;
      persist(); return;
    }
    dailyCalls++; persist();
    try {
      const count = Math.min(batchSize, target - questions.length);
      const generated = await ai.generate({ topic: '', count, difficulty: 'mixed', timeLimitSec: 10 },
        { excludeQuestions: [...used.values(), ...questions.map(q => q.question)].slice(-100) });
      if (closed) return;
      if (approvedOnly) {
        if (!onGenerated) throw new Error('Review storage unavailable');
        await onGenerated({ ...generated, questions: validatePack(generated.questions, count) });
        lastRefillAt = now();
        lastError = `${count} új AI-kérdés ellenőrzésre vár az adminban. Jóváhagyás után kerülhetnek játékba.`;
        nextRetryAt = now() + 30 * 60_000;
        persist(); return;
      }
      const existing = new Set([...used.keys(), ...questions.map(keyOf)]);
      let added = 0;
      for (const question of validatePack(generated.questions, count)) {
        const key = keyOf(question);
        if (existing.has(key) || questions.length >= target) continue;
        questions.push({ ...question, origin: 'ai' }); existing.add(key); added++;
      }
      if (!added) throw new Error('duplicate');
      lastRefillAt = now(); lastError = null; nextRetryAt = 0;
    } catch (error) {
      if (closed) return;
      lastError = error.code ? 'Az AI-utántöltés nem sikerült. A meglévő készletből tovább játszhattok.' : 'Az AI nem adott új, használható kérdéseket. Később újrapróbáljuk.';
      nextRetryAt = now() + Math.max(retryMs, (error.retryAfter || 0) * 1000);
    }
    persist();
  }
  function refill() {
    if (refilling) return refilling;
    refilling = doRefill().finally(() => { refilling = null; changed(); schedule(!lastError); });
    changed();
    return refilling;
  }
  // Restore low persisted stock, without spending quota merely to display status.
  void ready.then(schedule);
  return {
    ready, take, refill,
    synchronizeBank({ backgroundAI = false } = {}) {
      allowAI = backgroundAI;
      if (approvedOnly) {
        if (!backgroundAI) { lastError = null; nextRetryAt = 0; }
        const current = new Map(bank.map(q => [keyOf(q), q]));
        questions = questions.filter(q => current.has(keyOf(q))).map(q => ({ ...current.get(keyOf(q)), origin: current.get(keyOf(q)).source === 'api' ? 'ai' : 'bank' }));
        addApproved(); persist(); changed(); schedule();
      }
    },
    status() { return { available: questions.length, target, refilling: !!refilling,
      lastRefillAt, lastError, nextRetryAt: nextRetryAt || null, dailyCalls,
      persistence: store?.kind || 'memory', storageError }; },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async flush() { await writes; },
    async close() { closed = true; clearTimeout(timer); await ready; await writes; await store?.close?.(); }
  };
}
