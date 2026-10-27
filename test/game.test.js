import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { startApp, correctOption } from '../test-support/helpers.js';

test('the app serves the new UI and reports a playable offline question bank', async t => {
  const app = await startApp(t);
  for (const path of ['/', '/join/abcdef', '/room.html', '/home.js', '/client.js', '/common.js', '/style.css']) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    assert.ok(response.data.length > 100, path);
  }
  assert.equal((await app.request('/healthz')).data, 'ok');
  const { data } = await app.request('/api/meta');
  assert.equal(data.ai.configured, false);
  assert.ok(data.bankCount >= 140);
  assert.ok(data.topics.some(topic => topic.name === 'Harry Potter' && topic.count >= 15));
});

test('invite links bypass optional room passwords, while manual joins remain protected', async t => {
  const app = await startApp(t);
  const host = await app.create({ count: 2 }, 'private-test-password');
  const joined = await app.connect(host.roomId, host.playerToken);
  const state = await joined.state();
  const invite = new URL(state.invitePath, app.base).searchParams.get('invite');
  const publicRoom = await app.request(`/api/rooms/${host.roomId}`);
  assert.equal(publicRoom.data.requiresPassword, true);
  assert.equal(JSON.stringify(publicRoom.data).includes('private-test-password'), false);
  assert.equal((await app.request('/api/join', { method: 'POST', body: { roomId: host.roomId, nick: 'Guest', password: 'wrong' } })).status, 403);
  const guest = await app.request('/api/join', { method: 'POST', body: { roomId: host.roomId, nick: 'Guest', invite } });
  assert.equal(guest.status, 201);
  const duplicate = await app.request('/api/join', { method: 'POST', body: { roomId: host.roomId, nick: 'guest', invite } });
  assert.equal(duplicate.status, 409);
  const svg = await app.request(`/api/rooms/${host.roomId}/invite.svg`, { token: host.playerToken });
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /image\/svg/);
  assert.match(svg.data, /<svg/);
  assert.equal((await app.request(`/api/rooms/${host.roomId}/invite.svg`, { token: guest.data.playerToken })).status, 403);
  const guestClient = await app.connect(host.roomId, guest.data.playerToken);
  const guestState = await guestClient.state();
  assert.equal(guestState.invitePath, undefined);
  assert.equal(JSON.stringify(guestState).includes(host.playerToken), false);
  assert.equal(guestState.pack.questions, undefined);
});

test('host permissions come from the session token and all online players must be ready', async t => {
  const app = await startApp(t);
  const host = await app.create({ count: 2 });
  const hostClient = await app.connect(host.roomId, host.playerToken);
  const guest = (await app.request('/api/join', { method: 'POST', body: { roomId: host.roomId, nick: 'Guest' } })).data;
  const guestClient = await app.connect(host.roomId, guest.playerToken);
  const guestAttempt = guestClient.messages.length;
  guestClient.send({ type: 'start', nick: 'Host', isAdmin: true });
  const denied = await guestClient.wait(message => message.type === 'error', guestAttempt);
  assert.match(denied.error, /szobagazda/);
  assert.equal((await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: guest.playerToken, body: { settings: { count: 1 } } })).status, 403);
  const before = hostClient.messages.length;
  hostClient.send({ type: 'start' });
  await hostClient.wait(message => message.type === 'error', before);
  assert.equal((await app.request(`/api/rooms/${host.roomId}/session`, { token: host.playerToken })).data.phase, 'lobby');
  guestClient.send({ type: 'ready', ready: true });
  await hostClient.state(state => state.readyToStart && state.players.length === 2);
  hostClient.send({ type: 'start' });
  const questionState = await hostClient.state(state => state.phase === 'question');
  assert.equal(questionState.question.options.length, 4);
  assert.equal(questionState.question.correct, undefined);
  assert.equal(questionState.question.answerIndex, undefined);
  assert.equal(questionState.question.explanation, undefined);
});

test('every correct answer scores; duplicate and invalid answers do not alter the result', async t => {
  const app = await startApp(t);
  const host = await app.create({ count: 1 });
  const pack = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  const hostClient = await app.connect(host.roomId, host.playerToken);
  const guest = (await app.request('/api/join', { method: 'POST', body: { roomId: host.roomId, nick: 'Guest' } })).data;
  const guestClient = await app.connect(host.roomId, guest.playerToken);
  guestClient.send({ type: 'ready', ready: true });
  await hostClient.state(state => state.readyToStart && state.players.length === 2);
  hostClient.send({ type: 'start' });
  const { question } = await hostClient.state(state => state.phase === 'question');
  const option = correctOption(question, pack);
  hostClient.send({ type: 'answer', roundId: question.id, option: 42 });
  hostClient.send({ type: 'answer', roundId: 'stale-round-id', option });
  hostClient.send({ type: 'answer', roundId: question.id, option });
  const pong = once(hostClient.ws, 'pong'); hostClient.ws.ping(); await pong;
  hostClient.send({ type: 'answer', roundId: question.id, option: (option + 1) % 4 });
  await delay(30);
  guestClient.send({ type: 'answer', roundId: question.id, option });
  const resultState = await hostClient.state(state => state.phase === 'result');
  const result = resultState.result;
  assert.equal(result.details.filter(d => d.correct).length, 2);
  assert.ok(result.details.every(d => d.points >= 100 && d.points <= 200));
  const first = result.details.find(d => d.id === host.playerId);
  const second = result.details.find(d => d.id === guest.playerId);
  assert.ok(first.points >= second.points);
  assert.equal(result.fastest, 'Host');
  assert.equal(result.correct, pack.questions[0].correct);
  assert.ok(result.explanation.length > 10);
  const finished = await hostClient.state(state => state.phase === 'finished');
  assert.equal(finished.history.length, 1);
  assert.equal(finished.players.find(p => p.id === host.playerId).score, first.points);
});

test('refresh and a replaced socket preserve the player identity and score during a game', async t => {
  const app = await startApp(t, { timings: { questionMs: 2000, resultMs: 100 } });
  const host = await app.create({ count: 2 });
  const pack = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  const first = await app.connect(host.roomId, host.playerToken);
  first.send({ type: 'start' });
  const { question } = await first.state(state => state.phase === 'question');
  const replacement = await app.connect(host.roomId, host.playerToken);
  const restored = await replacement.state(state => state.phase === 'question');
  assert.equal(restored.you.id, host.playerId);
  assert.equal(restored.question.id, question.id);
  await delay(20);
  const session = await app.request(`/api/rooms/${host.roomId}/session`, { token: host.playerToken });
  assert.equal(session.data.players.find(p => p.id === host.playerId).connected, true);
  replacement.send({ type: 'answer', roundId: question.id, option: correctOption(question, pack) });
  const result = await replacement.state(state => state.phase === 'result');
  const points = result.players.find(p => p.id === host.playerId).score;
  replacement.ws.close();
  const reconnected = await app.connect(host.roomId, host.playerToken);
  const rejoined = await reconnected.state();
  assert.equal(rejoined.you.id, host.playerId);
  assert.equal(rejoined.players.find(p => p.id === host.playerId).score, points);
  assert.ok(points >= 100);
});

test('late spectators restore questions, results and the final scoreboard', async t => {
  const app = await startApp(t, { timings: { questionMs: 2000, resultMs: 100 } });
  const host = await app.create({ count: 1 });
  const pack = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  const client = await app.connect(host.roomId, host.playerToken);
  client.send({ type: 'start' });
  const first = await client.state(state => state.phase === 'question');
  const spectator = await app.connect(host.roomId, null, true);
  const current = await spectator.state(state => state.phase === 'question');
  assert.equal(current.question.id, first.question.id);
  assert.equal(current.you.spectator, true);
  assert.ok(current.question.timeRemainingMs < 2000);
  spectator.send({ type: 'answer', roundId: current.question.id, option: 0 });
  client.send({ type: 'answer', roundId: first.question.id, option: correctOption(first.question, pack) });
  const result = await client.state(state => state.phase === 'result');
  const late = await app.connect(host.roomId, null, true);
  const resultSnapshot = await late.state(state => state.phase === 'result');
  assert.equal(resultSnapshot.result.correct, result.result.correct);
  assert.equal(resultSnapshot.question.timeRemainingMs, 0);
  await client.state(state => state.phase === 'finished');
  const finalSpectator = await app.connect(host.roomId, null, true);
  const final = await finalSpectator.state(state => state.phase === 'finished');
  assert.equal(final.history.length, 1);
  assert.ok(final.players[0].score >= 100);
});

test('settings, exact question counts and accepted JSON packs work without an AI key', async t => {
  const app = await startApp(t);
  const invalid = await app.request('/api/createRoom', { method: 'POST', body: { nick: 'Host', settings: { count: 999 } } });
  assert.equal(invalid.status, 400);
  const host = await app.create({ count: 4, topic: 'Harry Potter' });
  const prepared = await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: host.playerToken, body: { settings: { count: 7, topic: 'Harry Potter', timeLimitSec: 20 } } });
  assert.equal(prepared.status, 200);
  assert.equal(prepared.data.pack.source, 'bank');
  assert.equal(prepared.data.pack.count, 7);
  assert.equal(prepared.data.settings.timeLimitSec, 20);
  const pack = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  assert.equal(pack.questions.length, 7);
  assert.equal(pack.questions.every(q => q.explanation.length > 10), true);
  const edited = structuredClone(pack); edited.questions = edited.questions.slice(0, 2); edited.questions[0].explanation = 'Egy saját, ellenőrzött magyarázat a kérdéshez.';
  const imported = await app.request(`/api/rooms/${host.roomId}/pack`, { method: 'PUT', token: host.playerToken, body: edited });
  assert.equal(imported.status, 200);
  assert.equal(imported.data.settings.count, 2);
  assert.equal(imported.data.pack.accepted, true);
  assert.equal(imported.data.pack.source, 'edited');
  const bad = structuredClone(edited); bad.questions[0].wrong[0] = bad.questions[0].correct;
  assert.equal((await app.request(`/api/rooms/${host.roomId}/pack`, { method: 'PUT', token: host.playerToken, body: bad })).status, 400);
  const noTopic = await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: host.playerToken, body: { settings: { count: 5, topic: 'egy nem létező teszttémakör' } } });
  assert.equal(noTopic.status, 422);
  const stillThere = (await app.request(`/api/rooms/${host.roomId}/session`, { token: host.playerToken })).data;
  assert.equal(stillThere.preparing, false);
  assert.equal(stillThere.pack.count, 2);
  assert.equal(stillThere.settings.topic, 'Harry Potter');
});

test('the question helper cannot reveal upcoming answers and clearly identifies offline responses', async t => {
  const app = await startApp(t);
  const host = await app.create({ count: 1 });
  const pack = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  const client = await app.connect(host.roomId, host.playerToken);
  client.send({ type: 'start' });
  const { question } = await client.state(state => state.phase === 'question');
  const early = await app.request(`/api/rooms/${host.roomId}/chat`, { method: 'POST', token: host.playerToken, body: { index: 1, message: 'Mi a helyes válasz?' } });
  assert.equal(early.status, 403);
  client.send({ type: 'answer', roundId: question.id, option: correctOption(question, pack) });
  await client.state(state => state.phase === 'result');
  const reply = await app.request(`/api/rooms/${host.roomId}/chat`, { method: 'POST', token: host.playerToken, body: { index: 1, message: 'Miért?' } });
  assert.equal(reply.status, 200);
  assert.equal(reply.data.source, 'bank');
  assert.ok(reply.data.answer.includes(pack.questions[0].correct));
  const rules = await app.request(`/api/rooms/${host.roomId}/chat`, { method: 'POST', token: host.playerToken, body: { index: 1, message: 'Hány pontot ér a gyorsaság?' } });
  assert.match(rules.data.answer, /100 alappont/);
});

test('a complete multi-question game can be followed by a newly prepared round', async t => {
  const app = await startApp(t, { timings: { questionMs: 1000, resultMs: 20 } });
  const host = await app.create({ count: 3 });
  const pack = (await app.request(`/api/rooms/${host.roomId}/pack`, { token: host.playerToken })).data;
  const client = await app.connect(host.roomId, host.playerToken);
  client.send({ type: 'start' });
  for (let index = 1; index <= 3; index++) {
    const state = await client.state(state => state.phase === 'question' && state.question.index === index);
    client.send({ type: 'answer', roundId: state.question.id, option: correctOption(state.question, pack) });
  }
  const finished = await client.state(state => state.phase === 'finished');
  assert.equal(finished.history.length, 3);
  assert.ok(finished.players[0].score >= 300);
  const prepared = await app.request(`/api/rooms/${host.roomId}/prepare`, { method: 'POST', token: host.playerToken, body: { settings: { count: 1 } } });
  assert.equal(prepared.data.phase, 'lobby');
  assert.equal(prepared.data.history.length, 0);
  client.send({ type: 'start' });
  const next = await client.state(state => state.phase === 'question' && state.question.total === 1);
  assert.equal(next.players[0].score, 0);
});

test('closing a room requires the host and removes its sessions and public listing', async t => {
  const app = await startApp(t);
  const host = await app.create({ count: 1 });
  assert.equal((await app.request(`/api/rooms/${host.roomId}`, { method: 'DELETE', token: 'invalid' })).status, 401);
  assert.equal((await app.request(`/api/rooms/${host.roomId}`, { method: 'DELETE', token: host.playerToken })).status, 200);
  assert.equal((await app.request(`/api/rooms/${host.roomId}`)).status, 404);
  assert.equal((await app.request('/api/rooms')).data.length, 0);
});
