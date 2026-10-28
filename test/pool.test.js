import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AIError, createAI } from '../lib/ai.js';
import { loadBank, parseSettings } from '../lib/questions.js';
import { createQuestionPool } from '../lib/question-pool.js';
import { filePoolStore } from '../lib/pool-store.js';
import { aiStatusView } from '../public/ai-status.js';
import { startApp } from '../test-support/helpers.js';

const bank = loadBank();
const general = count => parseSettings({ count });
const sample = n => ({ category: 'Matematika', question: `Mennyi ${n} és 2 összege?`, correct: String(n + 2), wrong: [String(n + 3), String(n + 4), String(n + 5)], explanation: `Az összeadás eredménye ${n + 2}.`, difficulty: 'easy' });
const offline = { status: () => ({ configured: false }) };
function generator() {
  let calls = 0, next = 10000;
  return { status: () => ({ configured: true }), calls: () => calls,
    async generate(settings) { calls++; return { questions: Array.from({ length: settings.count }, () => sample(next++)) }; } };
}
async function poolFor(t, options = {}) {
  const pool = createQuestionPool({ bank, ai: offline, autoRefill: false, ...options });
  await pool.ready;
  t.after(() => pool.close());
  return pool;
}

test('the initial 100 questions need no provider call, and consecutive allocations do not repeat', async t => {
  const ai = generator();
  const pool = await poolFor(t, { ai });
  assert.equal(pool.status().available, 100);
  assert.equal(ai.calls(), 0);
  const packs = Array.from({ length: 4 }, () => pool.take(general(20)));
  assert.equal(new Set(packs.flatMap(pack => pack.questions.map(q => q.question))).size, 80);
  assert.ok(packs.every(pack => pack.source === 'pool' && pack.accepted));
  assert.equal(ai.calls(), 0);
});

test('background refill is one shared operation and adds a validated 20-question batch', async t => {
  let resolve, settingsReceived;
  const pool = await poolFor(t, { ai: { status: () => ({ configured: true }), generate: settings => {
    settingsReceived = settings; return new Promise(done => { resolve = done; });
  } } });
  pool.take(general(20));
  assert.equal(pool.status().available, 80);
  const first = pool.refill();
  assert.equal(pool.refill(), first);
  assert.equal(pool.status().refilling, true);
  await new Promise(done => setImmediate(done));
  assert.equal(settingsReceived.count, 20);
  resolve({ questions: Array.from({ length: 20 }, (_, n) => sample(n + 1000)) });
  await first;
  assert.equal(pool.status().available, 100);
  assert.equal(pool.status().refilling, false);
  assert.ok(pool.status().lastRefillAt);
});

test('quota failures back off without blocking play or making repeated calls', async t => {
  let clock = 1000000, calls = 0;
  const pool = await poolFor(t, { now: () => clock, retryMs: 300000,
    ai: { status: () => ({ configured: true }), async generate() { calls++; throw new AIError('quota', 'Kvóta megtelt.', 60); } } });
  pool.take(general(20));
  await pool.refill(); await pool.refill();
  assert.equal(calls, 1);
  assert.equal(pool.status().nextRetryAt, clock + 300000);
  assert.equal(pool.take(general(20)).questions.length, 20);
  assert.ok(pool.status().lastError);
  clock += 300001;
  await pool.refill();
  assert.equal(calls, 2);
});

test('a daily refill ceiling survives serial writes and resets only on the next UTC day', async t => {
  let clock = Date.parse('2026-10-28T10:00:00Z');
  const ai = generator();
  const pool = await poolFor(t, { ai, now: () => clock, dailyLimit: 1 });
  pool.take(general(20)); await pool.refill();
  pool.take(general(20)); await pool.refill();
  assert.equal(ai.calls(), 1);
  assert.match(pool.status().lastError, /mai keret/);
  clock = Date.parse('2026-10-29T00:01:00Z');
  await pool.refill();
  assert.equal(ai.calls(), 2);
});

test('duplicate AI batches cannot reinsert consumed questions or silently fill the stock', async t => {
  let returned;
  const pool = await poolFor(t, { ai: { status: () => ({ configured: true }), async generate() { return { questions: returned }; } } });
  returned = pool.take(general(20)).questions;
  await pool.refill();
  assert.equal(pool.status().available, 80);
  assert.match(pool.status().lastError, /új, használható/);
  assert.ok(pool.status().nextRetryAt);
});

test('the emergency bank stays playable after the fresh stock runs out, with an explicit reuse notice', async t => {
  const pool = await poolFor(t);
  const warnings = [];
  for (let i = 0; i < 9; i++) {
    const pack = pool.take(general(20));
    assert.equal(pack.questions.length, 20);
    assert.equal(new Set(pack.questions.map(q => q.question)).size, 20);
    if (pack.warning) warnings.push(pack.warning);
  }
  assert.ok(warnings.some(warning => warning.includes('korábbi kérdések')));
});

test('stock, consumption history and refill budget are restored across a new app instance', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'nolege-pool-'));
  const filename = path.join(directory, 'pool.json');
  const ai = generator();
  const first = await poolFor(t, { ai, store: filePoolStore(filename) });
  const used = new Set(first.take(general(20)).questions.map(q => q.question));
  await first.refill(); await first.flush();
  const persisted = JSON.parse(await readFile(filename, 'utf8'));
  assert.equal(persisted.questions.length, 100);
  assert.equal(persisted.dailyCalls, 1);
  const second = await poolFor(t, { ai, store: filePoolStore(filename) });
  assert.equal(second.status().available, 100);
  assert.equal(second.status().dailyCalls, 1);
  const next = second.take(general(30));
  assert.ok(next.questions.every(q => !used.has(q.question)));
  t.after(() => rm(directory, { recursive: true, force: true }));
});

test('failed storage reads preserve remote data instead of overwriting it with fallback state', async t => {
  let writes = 0;
  const pool = await poolFor(t, { store: { kind: 'test', async read() { throw new Error('secret connection details'); }, async write() { writes++; } } });
  assert.equal(pool.status().available, 100);
  pool.take(general(10)); await pool.flush();
  assert.equal(writes, 0);
  assert.ok(pool.status().storageError);
  assert.equal(JSON.stringify(pool.status()).includes('secret connection details'), false);
});

test('the UI never turns a configured key into a false successful health indication', () => {
  assert.equal(aiStatusView({ configured: true }).tone, 'neutral');
  assert.equal(aiStatusView({ configured: true, state: 'working' }).tone, 'neutral');
  assert.equal(aiStatusView({ configured: true, state: 'working', lastSuccessAt: Date.now() }).tone, 'success');
  assert.equal(aiStatusView({ configured: true, state: 'pending' }).tone, 'pending');
  assert.equal(aiStatusView({ configured: true, state: 'error', lastSuccessAt: Date.now() }).tone, 'error');
});

test('a failed thematic generation preserves the previous pack and is never disguised as a general quiz', async t => {
  const ai = createAI({ env: { OPENROUTER_API_KEY: 'test-only-secret' }, fetchImpl: async () => new Response('{}', { status: 429 }) });
  const app = await startApp(t, { ai, poolOptions: { autoRefill: false } });
  const host = await app.create({ count: 2 });
  const before = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  const response = await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: host.playerToken,
    body: { settings: { topic: 'Modern popzene', count: 20 } } });
  assert.equal(response.status, 502);
  assert.equal(response.data.code, 'rate_limit');
  const after = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  assert.deepEqual(after, before);
  const state = (await app.request(`/api/rooms/${host.roomId}/session`, { token: host.playerToken })).data;
  assert.equal(state.preparing, false);
  assert.match(state.prepareError, /egyedi témakör nem készült el/);
  assert.equal(state.ai.state, 'error');
});

test('a twenty-question custom theme is temporary and never pollutes the general stock', async t => {
  const questions = Array.from({ length: 20 }, (_, n) => sample(n + 8000));
  const ai = createAI({ env: { OPENROUTER_API_KEY: 'test-only-key' }, fetchImpl: async () => new Response(JSON.stringify({ model: 'verified-test-model', choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions }) } }] }), { status: 200 }) });
  const app = await startApp(t, { ai, poolOptions: { autoRefill: false } });
  const host = await app.create({ topic: 'Modern popzene', count: 20 });
  const stockBefore = app.pool.status().available;
  const response = await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: host.playerToken,
    body: { settings: { topic: 'Modern popzene', count: 20 } } });
  assert.equal(response.status, 200);
  assert.equal(response.data.pack.count, 20);
  assert.equal(response.data.pack.source, 'ai');
  assert.equal(response.data.pack.accepted, false);
  assert.equal(response.data.ai.lastModel, 'verified-test-model');
  assert.equal(app.pool.status().available, stockBefore);
  assert.equal(response.data.ai.state, 'working');
});

test('a general quiz with a difficulty absent from stock can still generate an exact AI pack', async t => {
  const questions = Array.from({ length: 20 }, (_, n) => ({ ...sample(n + 9000), difficulty: 'hard' }));
  const ai = createAI({ env: { OPENROUTER_API_KEY: 'test-only-key' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions }) } }] }), { status: 200 }) });
  const app = await startApp(t, { ai, poolOptions: { autoRefill: false } });
  const host = await app.create({ count: 20, difficulty: 'hard' });
  const response = await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: host.playerToken,
    body: { settings: { count: 20, difficulty: 'hard' } } });
  assert.equal(response.status, 200);
  assert.equal(response.data.pack.source, 'ai');
  assert.equal(response.data.pack.count, 20);
});
