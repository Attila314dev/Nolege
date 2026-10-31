import assert from 'node:assert/strict';
import test from 'node:test';
import { createCatalog } from '../lib/catalog.js';
import { memoryCatalogStore, githubCatalogStore } from '../lib/catalog-store.js';
import { hashAdminPassword, tokenHash } from '../lib/admin-auth.js';
import { createAI } from '../lib/ai.js';
import { startApp } from '../test-support/helpers.js';

const fixturePassword = 'test-only-owner-password';
const fixtureToken = 'test-only-assistant-access-token-0123456789';
const env = { ADMIN_SESSION_SECRET: 'test-only-session-secret-at-least-thirty-two-characters',
  ADMIN_OWNER_PASSWORD_HASH: await hashAdminPassword(fixturePassword), ADMIN_ASSISTANT_TOKEN_HASH: tokenHash(fixtureToken) };
const question = n => ({ id: `fixture-${n}`, category: 'Teszt', question: `Mennyi ${n} és 4 összege?`, correct: String(n + 4), wrong: [String(n + 5), String(n + 6), String(n + 7)], explanation: `${n} és négy összege ${n + 4}.`, difficulty: 'easy', status: n <= 2 ? 'approved' : 'review', source: 'chatgpt', createdBy: 'ChatGPT', createdAt: '2026-10-28T10:00:00Z', updatedBy: 'ChatGPT', updatedAt: '2026-10-28T10:00:00Z' });
const seed = () => ({ schemaVersion: 1, revision: 'initial-revision', questions: [1, 2, 3, 4].map(question), settings: { openRouterModel: 'openrouter/free', backgroundAI: false }, audit: [] });
async function setup(t, options = {}) {
  const store = options.store || memoryCatalogStore(seed());
  const catalog = createCatalog({ store }); await catalog.ready;
  const app = await startApp(t, { catalog, adminEnv: env, ...options });
  async function request(path, { method = 'GET', body, cookie, csrf, token = fixtureToken, origin } = {}) {
    const response = await fetch(`${app.base}/api/admin${path}`, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...(cookie ? { cookie } : {}), ...(csrf ? { 'x-csrf-token': csrf } : {}), ...(origin ? { origin } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json(), headers: response.headers };
  }
  return { ...app, catalog, requestAdmin: request };
}

test('admin data, exports and mutations require authentication; the login page contains no bank data', async t => {
  const app = await setup(t);
  for (const path of ['/summary', '/questions', '/backup', '/export', '/audit', '/history', '/api-status']) assert.equal((await app.requestAdmin(path, { token: null })).status, 401, path);
  assert.equal((await app.requestAdmin('/bulk', { method: 'POST', token: null, body: { ids: ['fixture-3'], status: 'approved' } })).status, 401);
  const page = await app.request('/admin');
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(page.data.includes(question(3).question), false);
  assert.equal((await app.requestAdmin('/summary', { token: 'wrong-assistant-token-123456789012345678' })).status, 401);
});

test('owner sessions are HttpOnly and protected against CSRF and foreign origins', async t => {
  const app = await setup(t);
  const login = await app.requestAdmin('/login', { method: 'POST', token: null, body: { username: 'attila', password: fixturePassword } });
  assert.equal(login.status, 200); assert.match(login.headers.get('set-cookie'), /HttpOnly/); assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  const cookie = login.headers.get('set-cookie').split(';')[0], csrf = login.data.csrf;
  assert.equal((await app.requestAdmin('/summary', { token: null, cookie })).status, 200);
  const body = { ids: ['fixture-3'], status: 'approved', revision: app.catalog.summary().revision };
  assert.equal((await app.requestAdmin('/bulk', { token: null, cookie, method: 'POST', body })).status, 403);
  assert.equal((await app.requestAdmin('/bulk', { token: null, cookie, csrf, origin: 'https://foreign.invalid', method: 'POST', body })).status, 403);
  assert.equal((await app.requestAdmin('/bulk', { token: null, cookie, csrf, method: 'POST', body })).status, 200);
  assert.equal(app.catalog.audit()[0].actor, 'Attila');
  assert.equal((await app.requestAdmin('/summary', { token: null, cookie: `${cookie}tampered` })).status, 401);
});

test('failed login attempts are limited and an unconfigured admin has no default access', async t => {
  const app = await setup(t);
  for (let i = 0; i < 8; i++) assert.equal((await app.requestAdmin('/login', { method: 'POST', token: null, body: { username: 'attila', password: 'wrong' } })).status, 401);
  assert.equal((await app.requestAdmin('/login', { method: 'POST', token: null, body: { username: 'attila', password: fixturePassword } })).status, 429);
  const closed = await startApp(t, { adminEnv: {} });
  assert.equal((await closed.request('/api/admin/summary')).status, 503);
});

test('assistant edits preserve original source and creator, with the acting editor in the audit', async t => {
  const app = await setup(t);
  const original = app.catalog.get('fixture-3');
  const result = await app.requestAdmin('/questions/fixture-3', { method: 'PUT', body: { revision: app.catalog.summary().revision, question: { ...original, explanation: 'Egy új, ellenőrzött magyarázat.', source: 'manual', createdBy: 'Spoofed' } } });
  assert.equal(result.status, 200);
  const saved = app.catalog.get('fixture-3');
  assert.equal(saved.source, 'chatgpt'); assert.equal(saved.createdBy, 'ChatGPT'); assert.equal(saved.updatedBy, 'ChatGPT'); assert.equal(saved.createdAt, original.createdAt);
  assert.equal(app.catalog.audit()[0].actor, 'ChatGPT');
});

test('concurrent edits cannot silently overwrite one another and duplicate questions are rejected', async t => {
  const app = await setup(t); const revision = app.catalog.summary().revision;
  const [a, b] = await Promise.all([5, 6].map(n => app.requestAdmin('/questions', { method: 'POST', body: { revision, question: question(n) } })));
  assert.deepEqual([a.status, b.status].sort(), [201, 409]);
  const duplicate = await app.requestAdmin('/questions', { method: 'POST', body: { revision: app.catalog.summary().revision, question: question(1) } });
  assert.equal(duplicate.status, 422); assert.equal(app.catalog.summary().stats.total, 5);
});

test('import deduplicates normalized text and keeps incoming questions outside the playable bank', async t => {
  const app = await setup(t);
  const result = await app.requestAdmin('/import', { method: 'POST', body: { revision: app.catalog.summary().revision, questions: [question(1), question(5), question(5)] } });
  assert.equal(result.status, 200); assert.equal(result.data.count, 1); assert.equal(result.data.duplicates, 2);
  assert.equal(app.catalog.summary().stats.statuses.approved, 2);
  assert.equal((await app.request('/api/meta')).data.bankCount, 2);
  const selected = await app.requestAdmin('/selection?status=review'); assert.equal(selected.data.ids.length, 3);
});

test('approval refreshes the playable pool and archiving cannot change an already running game', async t => {
  const app = await setup(t);
  const host = await app.create({ count: 2 });
  const client = await app.connect(host.roomId, host.playerToken); client.send({ type: 'start' });
  const before = await client.state(room => room.phase === 'question');
  const updated = await app.requestAdmin('/bulk', { method: 'POST', body: { ids: ['fixture-1', 'fixture-2'], status: 'archived', revision: app.catalog.summary().revision } });
  assert.equal(updated.status, 200); assert.equal((await app.request('/api/meta')).data.bankCount, 0);
  const current = (await app.request(`/api/rooms/${host.roomId}/session`, { token: host.playerToken })).data;
  assert.equal(current.question.id, before.question.id); assert.equal(current.question.text, before.question.text);
  const next = await app.requestAdmin('/bulk', { method: 'POST', body: { ids: ['fixture-3', 'fixture-4'], status: 'approved', revision: app.catalog.summary().revision } });
  assert.equal(next.status, 200); assert.equal((await app.request('/api/meta')).data.bankCount, 2);
});

test('backups restore state, reject a damaged checksum and retain the audit trail', async t => {
  const app = await setup(t);
  const backup = await app.requestAdmin('/backup');
  assert.equal(JSON.stringify(backup.data).includes(env.ADMIN_SESSION_SECRET), false);
  await app.requestAdmin('/questions', { method: 'POST', body: { revision: app.catalog.summary().revision, question: question(9) } });
  const damaged = structuredClone(backup.data); damaged.catalog.questions[0].correct = 'Hibás';
  assert.equal((await app.requestAdmin('/restore', { method: 'POST', body: { revision: app.catalog.summary().revision, backup: damaged } })).status, 422);
  assert.equal(app.catalog.summary().stats.total, 5);
  const result = await app.requestAdmin('/restore', { method: 'POST', body: { revision: app.catalog.summary().revision, backup: backup.data } });
  assert.equal(result.status, 200); assert.equal(app.catalog.summary().stats.total, 4);
  assert.equal(app.catalog.audit().length, 2); assert.equal(app.catalog.audit()[0].action, 'backup_restored');
});

test('GitHub writes use the current file SHA and refuse to overwrite unreadable remote state', async () => {
  const initial = seed(); let reads = 0, writes = 0, unavailable = false;
  const store = githubCatalogStore({ token: 'test-only-github-token', fallback: initial, fetchImpl: async (_url, options) => {
    if (unavailable) throw new Error('secret network detail');
    if (options.method === 'PUT') { writes++; const body = JSON.parse(options.body); assert.equal(body.sha, 'file-sha-1'); assert.equal(body.branch, 'main'); return new Response(JSON.stringify({ content: { sha: 'file-sha-2' } })); }
    reads++; return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(JSON.stringify(initial)).toString('base64'), sha: 'file-sha-1' }));
  } });
  await store.read(); await store.write(initial); assert.equal(writes, 1);
  unavailable = true; await assert.rejects(store.read()); await assert.rejects(store.write(initial), error => error.code === 'storage_unavailable');
  assert.equal(writes, 1); assert.equal(reads, 1);
});

test('status refresh reads quota without inference, while an explicit connection test counts actual tokens', async t => {
  let completions = 0;
  const ai = createAI({ env: { OPENROUTER_API_KEY: 'test-only-router-secret' }, fetchImpl: async url => {
    if (url.endsWith('/key')) return new Response(JSON.stringify({ data: { free_model_daily_requests: { used: 4, limit: 50, remaining: 46 }, is_free_tier: true } }));
    if (url.endsWith('/models')) return new Response(JSON.stringify({ data: [] }));
    completions++; return new Response(JSON.stringify({ model: 'example/free-model:free', usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }, choices: [{ finish_reason: 'stop', message: { content: 'rendben' } }] }));
  } });
  const app = await setup(t, { ai });
  const inspected = await app.requestAdmin('/api-status?refresh=1');
  assert.equal(inspected.status, 200); assert.equal(completions, 0); assert.equal(inspected.data.diagnostics.quota.freeModelDailyRequests.remaining, 46);
  assert.equal(inspected.data.ai.state, 'unverified');
  const tested = await app.requestAdmin('/api-test', { method: 'POST', body: {} });
  assert.equal(tested.status, 200); assert.equal(completions, 1); assert.equal(tested.data.diagnostics.usage.totalTokens, 11);
});

test('upstream 429 and daily quota errors remain distinct, with private provider messages redacted', async () => {
  for (const [message, expected] of [['Temporarily rate limited upstream', 'upstream_rate_limit'], ['Daily free model limit reached', 'daily_limit'], ['Too many requests', 'rate_limit']]) {
    const key = 'test-only-redaction-secret';
    const ai = createAI({ env: { OPENROUTER_API_KEY: key }, fetchImpl: async () => new Response(JSON.stringify({ error: { code: 429, message, metadata: { raw: `Provider details ${key}` } } }), { status: 429, headers: { 'retry-after': '120' } }) });
    await assert.rejects(ai.testConnection(), error => error.code === expected && error.retryAfter === 120);
    assert.equal(JSON.stringify(ai.diagnostics()).includes(key), false);
    assert.equal(JSON.stringify(ai.status()).includes('Provider details'), false);
  }
});

test('Gemini admin generation preserves Google attribution and imports only for review', async t => {
  let completions = 0;
  const ai = createAI({ env: { GEMINI_API_KEY: 'test-only-gemini-key' }, fetchImpl: async (url, options) => {
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'gemini-3.8-flash' }] });
    completions++; const body = JSON.parse(options.body); const count = JSON.parse(body.messages.at(-1).content).kerdesekSzama;
    return Response.json({ model: 'gemini-3.8-flash', usage: { prompt_tokens: 100, completion_tokens: 700, total_tokens: 800 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: Array.from({ length: count }, (_, i) => {
      const { category, question: text, correct, wrong, explanation, difficulty } = question(800 + i); return { category, question: text, correct, wrong, explanation, difficulty };
    }) }) } }] });
  } });
  const app = await setup(t, { ai });
  const inspected = await app.requestAdmin('/api-status?refresh=1'); assert.equal(inspected.status, 200); assert.equal(completions, 0); assert.equal(inspected.data.diagnostics.checks.Gemini.modelAvailable, true);
  const generated = await app.requestAdmin('/generate', { method: 'POST', body: { settings: { topic: 'Teszt', count: 5 } } });
  assert.equal(generated.status, 200); assert.equal(generated.data.provider, 'Gemini'); assert.equal(generated.data.questions.length, 5);
  const imported = await app.requestAdmin(`/generated/${generated.data.generationId}/import`, { method: 'POST', body: { revision: app.catalog.summary().revision } });
  assert.equal(imported.status, 200); assert.equal(app.catalog.summary().stats.statuses.approved, 2); assert.equal(app.catalog.summary().stats.sources.api, 5);
  for (const item of app.catalog.list({ source: 'api' }).questions) { assert.equal(item.status, 'review'); assert.equal(item.provider, 'Gemini'); assert.equal(item.model, 'gemini-3.8-flash'); }
  assert.equal(ai.diagnostics().usage.requests, 1); assert.equal(ai.diagnostics().usage.totalTokens, 800);
});
