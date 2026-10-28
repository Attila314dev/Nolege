import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { QuizError, parseSettings, validatePack } from './questions.js';
import { createAdminAuth } from './admin-auth.js';
import { AIError } from './ai.js';

const checksum = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function createAdminRouter({ catalog, ai, pool, env, now = Date.now } = {}) {
  const router = express.Router();
  const auth = createAdminAuth({ env, now });
  const generated = new Map();
  const calls = new Map();
  const wrap = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res, next)).catch(error => next(error instanceof AIError ? new QuizError(error.message, 502, error.code) : error));
  const filters = query => Object.fromEntries(['search', 'category', 'source', 'status', 'difficulty'].map(key => [key, typeof query[key] === 'string' ? query[key].slice(0, 150) : '']));
  function limit(key, max = 6, windowMs = 60_000) {
    const entry = calls.get(key);
    if (!entry || now() - entry.at >= windowMs) { calls.set(key, { at: now(), count: 1 }); return; }
    if (entry.count >= max) throw new QuizError('Ezt a műveletet túl sűrűn kérted. Várj egy kicsit.', 429, 'admin_rate_limit');
    entry.count++;
  }
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow'); next();
  });
  router.post('/login', wrap(async (req, res) => res.json(await auth.login(req, res))));
  router.get('/session', (req, res) => {
    try { res.json({ authenticated: true, ...auth.authenticate(req) }); }
    catch { res.json({ authenticated: false, configured: auth.configured }); }
  });
  router.use(wrap(async (req, _res, next) => {
    req.admin = auth.authenticate(req, !['GET', 'HEAD'].includes(req.method));
    if (!catalog) throw new QuizError('A kérdésbank-adminisztráció még nincs bekötve.', 503, 'catalog_not_configured');
    await catalog.ready; next();
  }));
  const status = () => ({ ...catalog.summary(), ai: ai.status(), diagnostics: ai.diagnostics?.() || {}, pool: pool.status() });
  router.post('/logout', (req, res) => { auth.logout(req, res); res.json({ ok: true }); });
  router.get('/summary', (_req, res) => res.json(status()));
  router.get('/questions', wrap((req, res) => {
    const page = Number(req.query.page || 1);
    if (!Number.isInteger(page) || page < 1 || page > 1000) throw new QuizError('Érvénytelen oldalszám.');
    res.json(catalog.list(filters(req.query), page));
  }));
  router.get('/questions/:id', wrap((req, res) => res.json({ question: catalog.get(req.params.id), revision: catalog.summary().revision })));
  router.get('/selection', (req, res) => res.json({ ids: catalog.selection(filters(req.query)) }));
  router.post('/questions', wrap(async (req, res) => res.status(201).json(await catalog.save({ ...req.body.question, id: undefined }, req.body.revision, req.admin.actor))));
  router.put('/questions/:id', wrap(async (req, res) => res.json(await catalog.save({ ...req.body.question, id: req.params.id }, req.body.revision, req.admin.actor))));
  router.post('/bulk', wrap(async (req, res) => res.json(await catalog.bulk(req.body.ids, req.body.status, req.body.revision, req.admin.actor))));
  router.post('/import', wrap(async (req, res) => res.json(await catalog.import(req.body.questions, req.body.revision, req.admin.actor))));
  router.get('/export', wrap((req, res) => {
    res.setHeader('Content-Disposition', 'attachment; filename="nolege-kerdesbank.json"'); res.json(catalog.export(filters(req.query)));
  }));
  router.get('/backup', wrap((_req, res) => {
    const value = catalog.backup();
    res.setHeader('Content-Disposition', 'attachment; filename="nolege-bank-mentes.json"');
    res.json({ format: 'nolege-bank-v1', createdAt: new Date(now()).toISOString(), checksum: checksum(value), catalog: value });
  }));
  router.post('/restore', wrap(async (req, res) => {
    const backup = req.body.backup;
    if (backup?.format === 'nolege-bank-v1' && checksum(backup.catalog) !== backup.checksum) throw new QuizError('A mentés ellenőrzőösszege hibás. Válassz sértetlen mentést.', 422, 'checksum_mismatch');
    res.json(await catalog.restore(backup?.format === 'nolege-bank-v1' ? backup.catalog : backup, req.body.revision, req.admin.actor));
  }));
  router.get('/history', wrap(async (_req, res) => res.json({ history: await catalog.history() })));
  router.post('/restore-version', wrap(async (req, res) => res.json(await catalog.restoreVersion(req.body.sha, req.body.revision, req.admin.actor))));
  router.get('/audit', (_req, res) => res.json({ entries: catalog.audit() }));
  router.post('/reload', wrap(async (_req, res) => { limit('reload'); await catalog.reload(); res.json(status()); }));
  router.get('/api-status', wrap(async (req, res) => {
    if (req.query.refresh === '1') { limit('inspect'); await ai.inspect?.(); }
    res.json(status());
  }));
  router.post('/api-test', wrap(async (_req, res) => { limit('connection-test', 2); const result = await ai.testConnection(); res.json({ result, ...status() }); }));
  router.put('/settings', wrap(async (req, res) => {
    const result = await catalog.settings(req.body.settings, req.body.revision, req.admin.actor); res.json({ ...result, ...status() });
  }));
  router.post('/generate', wrap(async (req, res) => {
    limit('generate', 3);
    const settings = parseSettings(req.body.settings);
    const result = await ai.generate(settings);
    for (const [key, item] of generated) if (now() - item.at > 30 * 60_000) generated.delete(key);
    const id = randomUUID();
    generated.set(id, { ...result, at: now() });
    res.json({ generationId: id, questions: result.questions, provider: result.provider, model: result.model });
  }));
  router.post('/generated/:id/import', wrap(async (req, res) => {
    const pack = generated.get(req.params.id);
    if (!pack || now() - pack.at > 30 * 60_000) throw new QuizError('Az előnézet lejárt. Készíts új csomagot.', 410, 'preview_expired');
    const questions = validatePack(req.body.questions || pack.questions).map(q => ({ ...q, provider: pack.provider, model: pack.model }));
    const result = await catalog.import(questions, req.body.revision, req.admin.actor, 'api');
    generated.delete(req.params.id); res.json(result);
  }));
  return router;
}
