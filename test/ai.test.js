import assert from 'node:assert/strict';
import test from 'node:test';
import { createAI, AIError } from '../lib/ai.js';
import { startApp } from '../test-support/helpers.js';

const sample = index => ({ category: 'AI-teszt', question: `Mennyi ${index} + 2?`, correct: String(index + 2),
  wrong: [String(index + 3), String(index + 4), String(index + 5)], explanation: `${index} és 2 összege ${index + 2}.`, difficulty: 'easy' });
const completion = content => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

test('a missing API key never makes a provider call or pretends to be live AI', async () => {
  const ai = createAI({ env: {}, fetchImpl: () => { throw new Error('unexpected provider request'); } });
  assert.equal(ai.status().configured, false);
  await assert.rejects(ai.generate({ topic: '', count: 2, difficulty: 'mixed' }), error => error instanceof AIError && error.code === 'not_configured');
});

test('health follows validated completions, exposes real model and timestamps, and clears after recovery', async () => {
  let clock = 1000, mode = 'invalid';
  const ai = createAI({ env: { OPENROUTER_API_KEY: 'test-only-private-key' }, now: () => clock,
    fetchImpl: async () => {
      assert.equal(ai.status().state, 'pending');
      return new Response(JSON.stringify({ model: 'actual-selected-model', choices: [{ finish_reason: 'stop', message: {
        content: mode === 'invalid' ? '{bad JSON' : JSON.stringify({ questions: [sample(1)] }) } }] }), { status: 200 });
    } });
  assert.equal(ai.status().state, 'unverified');
  await assert.rejects(ai.generate({ count: 1, topic: '', difficulty: 'easy' }));
  assert.equal(ai.status().state, 'error', 'HTTP 200 alone is not usable generation');
  assert.equal(ai.status().lastError.code, 'invalid_response');
  assert.equal(ai.status().lastSuccessAt, null);
  mode = 'valid'; clock += 100;
  await ai.generate({ count: 1, topic: '', difficulty: 'easy' });
  assert.equal(ai.status().state, 'working');
  assert.equal(ai.status().lastModel, 'actual-selected-model');
  assert.equal(ai.status().lastCompletedAt, clock);
  assert.equal(ai.status().lastError, null);
  assert.equal(ai.diagnostics().lastError, null);
  assert.equal(JSON.stringify(ai.status()).includes('test-only-private-key'), false);
});

test('Gemini is preferred, uses the Google endpoint and schema, and accounts for a five-question pack', async () => {
  let count = 0;
  const ai = createAI({ env: { GEMINI_API_KEY: 'test-only-google-key', OPENROUTER_API_KEY: 'test-only-fallback-key' }, fetchImpl: async (url, options) => {
    count++; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer test-only-google-key');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'gemini-3.8-flash'); assert.equal(body.reasoning_effort, 'minimal'); assert.equal(body.reasoning, undefined);
    assert.equal(body.max_tokens, 2650); assert.equal(body.max_completion_tokens, undefined);
    assert.equal(body.response_format.json_schema.strict, true); assert.equal(body.response_format.json_schema.schema.properties.questions.minItems, 5);
    return Response.json({ model: 'gemini-3.8-flash', usage: { prompt_tokens: 100, completion_tokens: 650, total_tokens: 750 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ questions: Array.from({ length: 5 }, (_, i) => sample(i + 100)) }) } }] });
  } });
  assert.equal(ai.status().primaryProvider, 'Gemini'); assert.equal(ai.recommendedBatchSize, 5);
  const result = await ai.generate({ topic: 'Számolás', count: 5, difficulty: 'easy' });
  assert.equal(result.provider, 'Gemini'); assert.equal(result.questions.length, 5); assert.equal(count, 1);
  assert.equal(ai.status().lastProvider, 'Gemini'); assert.equal(ai.status().state, 'working');
  assert.equal(ai.diagnostics().usage.requests, 1); assert.equal(ai.diagnostics().usage.totalTokens, 750);
  assert.equal(JSON.stringify(ai.diagnostics()).includes('test-only-google-key'), false);
});

test('Gemini passive inspection verifies the configured model without inference or unrelated provider traffic', async () => {
  let reads = 0;
  const ai = createAI({ env: { GEMINI_API_KEY: 'test-only-google-key', GEMINI_MODEL: 'gemini-3.1-flash-lite' }, fetchImpl: async (url, options) => {
    reads++; assert.equal(url, 'https://generativelanguage.googleapis.com/v1beta/openai/models'); assert.equal(options.method, undefined);
    assert.equal(options.headers.authorization, 'Bearer test-only-google-key');
    return Response.json({ data: [{ id: 'gemini-3.8-flash' }, { id: 'models/gemini-3.1-flash-lite' }] });
  } });
  const results = await Promise.all([ai.inspect(), ai.inspect()]);
  assert.equal(reads, 1); assert.equal(results[0].checks.Gemini.modelAvailable, true);
  assert.equal(ai.status().state, 'unverified'); assert.equal(ai.status().lastSuccessAt, null);
  assert.equal(ai.diagnostics().usage.requests, 0); assert.equal(ai.diagnostics().quota, null);
});

test('Gemini daily-quota errors retain retry information and redact credentials inside Google details', async () => {
  const key = 'test-only-gemini-private-key';
  const ai = createAI({ env: { GEMINI_API_KEY: key }, fetchImpl: async () => Response.json({ error: { code: 429, message: 'Quota exceeded', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', description: `Rejected ${key}` }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '45.5s' }
  ] } }, { status: 429 }) });
  await assert.rejects(ai.generate({ topic: '', count: 5, difficulty: 'mixed' }), error => error.code === 'daily_limit' && error.retryAfter === 46);
  assert.equal(ai.diagnostics().lastError.provider, 'Gemini'); assert.equal(ai.diagnostics().lastError.scope, 'account');
  assert.equal(JSON.stringify(ai.diagnostics()).includes(key), false);
});

test('a failing fallback never hides a Gemini key error, and a later success clears the old diagnostic', async () => {
  let healthy = false;
  const ai = createAI({ env: { GEMINI_API_KEY: 'test-only-google-key', OPENROUTER_API_KEY: 'test-only-router-key' }, fetchImpl: async url => {
    if (url.includes('openrouter')) return Response.json({ error: { code: 429, message: 'Rate limit' } }, { status: 429 });
    if (!healthy) return Response.json({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.' } }, { status: 400 });
    return completion('rendben');
  } });
  await assert.rejects(ai.testConnection(), error => error.code === 'auth');
  assert.equal(ai.diagnostics().lastError.provider, 'Gemini'); assert.equal(ai.diagnostics().recent.length, 2);
  healthy = true; await ai.testConnection(); assert.equal(ai.diagnostics().lastError, null); assert.equal(ai.status().state, 'working');
});

test('Groq generation uses strict structured output and validates the exact requested pack', async () => {
  let request;
  const ai = createAI({ env: { GROQ_API_KEY: 'test-only-not-a-real-key' }, fetchImpl: async (url, options) => {
    request = { url, options, body: JSON.parse(options.body) };
    return completion(JSON.stringify({ questions: [sample(1), sample(2)] }));
  } });
  const result = await ai.generate({ topic: 'Számolás', count: 2, difficulty: 'easy' });
  assert.equal(result.questions.length, 2);
  assert.equal(result.provider, 'Groq');
  assert.equal(request.url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(request.body.model, 'openai/gpt-oss-120b');
  assert.equal(request.body.response_format.json_schema.strict, true);
  assert.equal(request.body.response_format.json_schema.schema.properties.questions.minItems, 2);
  assert.equal(request.body.response_format.json_schema.schema.properties.questions.maxItems, 2);
  assert.ok(request.body.max_completion_tokens < 8000);
  assert.equal(JSON.stringify(ai.status()).includes('test-only-not-a-real-key'), false);
});

test('invalid, duplicate, truncated or incomplete AI packs are rejected', async t => {
  for (const [name, value] of [
    ['invalid JSON', 'not JSON'],
    ['wrong count', JSON.stringify({ questions: [sample(1)] })],
    ['duplicate question', JSON.stringify({ questions: [sample(1), sample(1)] })],
    ['duplicate answer', JSON.stringify({ questions: [{ ...sample(1), wrong: ['3', '4', '5'] }, sample(2)] })],
    ['missing explanation', JSON.stringify({ questions: [{ ...sample(1), explanation: '' }, sample(2)] })]
  ]) {
    await t.test(name, async () => {
      const ai = createAI({ env: { GROQ_API_KEY: 'test-only-key' }, fetchImpl: async () => completion(value) });
      await assert.rejects(ai.generate({ topic: '', count: 2, difficulty: 'mixed' }), error => error.code === 'invalid_response');
    });
  }
  const ai = createAI({ env: { GROQ_API_KEY: 'test-only-key' }, fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{"questions":[' } }] })) });
  await assert.rejects(ai.generate({ topic: '', count: 2, difficulty: 'mixed' }), error => error.code === 'invalid_response');
});

test('a quota error can fall back to the separately configured free OpenRouter route', async () => {
  const urls = [];
  const ai = createAI({ env: { GROQ_API_KEY: 'test-groq-key', OPENROUTER_API_KEY: 'test-router-key' }, fetchImpl: async (url, options) => {
    urls.push(url);
    if (url.includes('groq.com')) return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'openrouter/free');
    assert.ok(body.max_tokens > 0);
    return completion(JSON.stringify({ questions: [sample(1)] }));
  } });
  const result = await ai.generate({ topic: '', count: 1, difficulty: 'mixed' });
  assert.equal(result.provider, 'OpenRouter');
  assert.equal(urls.length, 2);
});

test('provider authentication, quota and timeout failures have safe actionable errors', async t => {
  for (const [status, code] of [[401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'provider_error']]) {
    await t.test(String(status), async () => {
      const ai = createAI({ env: { GROQ_API_KEY: 'test-only-secret' }, fetchImpl: async () => new Response('{"error":"sensitive provider details"}', { status }) });
      await assert.rejects(ai.generate({ count: 1, topic: '', difficulty: 'mixed' }), error => error.code === code && !error.message.includes('sensitive') && !error.message.includes('test-only-secret'));
    });
  }
  const ai = createAI({ env: { GROQ_API_KEY: 'test-only-key' }, timeoutMs: 20, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    const keepAlive = setTimeout(() => reject(new Error('unexpected test timeout')), 1000);
    signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); });
  }) });
  await assert.rejects(ai.generate({ count: 1, topic: '', difficulty: 'mixed' }), error => error.code === 'unavailable');
});

test('real app endpoints accept mock AI generation, require approval, and support follow-up chat', async t => {
  const ai = createAI({ env: { GROQ_API_KEY: 'test-only-key' }, fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    if (body.response_format) return completion(JSON.stringify({ questions: [sample(1), sample(2)] }));
    return completion('A tesztelt AI-kapcsolat rövid magyarázata a már lezárt kérdéshez.');
  } });
  const app = await startApp(t, { ai });
  const host = await app.create({ count: 2 });
  const client = await app.connect(host.roomId, host.playerToken);
  const prepared = await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: host.playerToken,
    body: { settings: { topic: 'Egyéni teszttéma', count: 2, difficulty: 'easy' } } });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.pack.source, 'ai');
  assert.equal(prepared.data.pack.accepted, false);
  const cursor = client.messages.length;
  client.send({ type: 'start' });
  await client.wait(message => message.type === 'error', cursor);
  assert.equal((await app.request(`/api/rooms/${host.roomId}/accept`, { method: 'POST', token: host.playerToken })).status, 200);
  client.send({ type: 'start' });
  for (let index = 1; index <= 2; index++) {
    const state = await client.state(room => room.phase === 'question' && room.question.index === index);
    const source = [sample(1), sample(2)].find(q => q.question === state.question.text);
    client.send({ type: 'answer', roundId: state.question.id, option: state.question.options.indexOf(source.correct) });
  }
  await client.state(room => room.phase === 'finished');
  const chat = await app.request(`/api/rooms/${host.roomId}/chat`, { method: 'POST', token: host.playerToken, body: { index: 1, message: 'Elmagyarázod részletesebben?' } });
  assert.equal(chat.status, 200);
  assert.equal(chat.data.source, 'ai');
  assert.match(chat.data.answer, /már lezárt/);
});

test('a failed background provider leaves the general stock playable and helper answers labelled honestly', async t => {
  const ai = createAI({ env: { GROQ_API_KEY: 'test-only-key' }, fetchImpl: async () => new Response('{}', { status: 429 }) });
  const app = await startApp(t, { ai });
  const host = await app.create({ count: 1 });
  const prepared = await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: host.playerToken, body: { settings: { count: 1 } } });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.pack.source, 'pool');
  assert.equal(prepared.data.pack.accepted, true);
  await app.pool.refill();
  assert.equal(ai.status().state, 'error');
  assert.equal(ai.status().lastError.code, 'rate_limit');
  assert.ok(app.pool.status().lastError);
  const pack = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  const client = await app.connect(host.roomId, host.playerToken); client.send({ type: 'start' });
  const { question } = await client.state(room => room.phase === 'question');
  client.send({ type: 'answer', roundId: question.id, option: question.options.indexOf(pack.questions[0].correct) });
  await client.state(room => room.phase === 'finished');
  const chat = await app.request(`/api/rooms/${host.roomId}/chat`, { method: 'POST', token: host.playerToken, body: { index: 1, message: 'Miért?' } });
  assert.equal(chat.data.source, 'bank');
  assert.ok(chat.data.warning);
});
