import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';

const root = new URL('../', import.meta.url);
const questions = JSON.parse(await readFile(new URL('questions.json', root), 'utf8'));
const sockets = new Set();
let server;
let baseUrl;

before(async () => {
  server = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let logs = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${logs}`)), 5_000);
    const fail = error => { clearTimeout(timeout); reject(error); };
    server.once('error', fail);
    server.once('exit', code => fail(new Error(`Server exited (${code}): ${logs}`)));
    server.stderr.on('data', chunk => { logs += chunk; });
    server.stdout.on('data', chunk => {
      logs += chunk;
      const match = logs.match(/Server listening on (\d+)/);
      if (match) {
        baseUrl = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timeout);
        resolve();
      }
    });
  });
});

after(async () => {
  for (const socket of sockets) socket.terminate();
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = once(server, 'exit');
    server.kill();
    await exited;
  }
});

async function post(path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

async function connect(init) {
  const socket = new WebSocket(baseUrl.replace('http:', 'ws:'));
  sockets.add(socket);
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'join', ...init }));
  const client = {
    socket,
    messages,
    send(message) { socket.send(JSON.stringify(message)); },
    async wait(type, predicate = () => true) {
      for (let attempt = 0; attempt < 250; attempt++) {
        const message = messages.find(item => item.type === type && predicate(item));
        if (message) return message;
        const error = messages.find(item => item.type === 'error');
        if (error) throw new Error(error.error);
        await delay(20);
      }
      throw new Error(`Timed out waiting for ${type}`);
    }
  };
  await client.wait('joined');
  return client;
}

async function createGame() {
  const created = await post('/api/createRoom', { adminNick: 'Host', password: 'test-pass' });
  assert.equal(created.status, 200);
  const roomId = created.body.roomId;
  const host = await connect({ roomId, password: 'test-pass', nick: 'Host', isAdmin: true });
  return { roomId, host };
}

function correctOption(question) {
  const source = questions.find(item => item.question === question.question);
  assert.ok(source, 'the question comes from the committed question set');
  const index = question.options.indexOf(source.correct);
  assert.notEqual(index, -1);
  return 'ABCD'[index];
}

test('the server serves the lobby and health check', async () => {
  const health = await fetch(`${baseUrl}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), 'ok');
  for (const path of ['/', '/room.html', '/client.js', '/style.css']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, path);
    assert.ok((await response.text()).length > 0, path);
  }
});

test('two players can join and only the first correct answer scores', async () => {
  const { roomId, host } = await createGame();
  const rejected = await post('/api/join', { roomId, password: 'wrong', nick: 'Guest' });
  assert.equal(rejected.status, 403);
  const joined = await post('/api/join', { roomId, password: 'test-pass', nick: 'Guest' });
  assert.equal(joined.status, 200);
  const guest = await connect({ roomId, password: 'test-pass', nick: 'Guest' });
  host.send({ type: 'startGame' });
  const question = await host.wait('question');
  assert.equal(question.total, 15);
  assert.equal(question.options.length, 4);
  assert.equal(question.answerIndex, undefined);
  assert.deepEqual((await guest.wait('question')).options, question.options);
  const option = correctOption(question);
  host.send({ type: 'submitAnswer', option });
  // Confirm arrival at the server before sending the second player's answer.
  const pong = once(host.socket, 'pong');
  host.socket.ping();
  await pong;
  guest.send({ type: 'submitAnswer', option });
  const result = await host.wait('roundResult');
  assert.equal(result.winner, 'Host');
  assert.deepEqual(result.scoreboard, [{ nick: 'Host', score: 1 }, { nick: 'Guest', score: 0 }]);
  assert.equal(result.details.filter(item => item.isCorrect).length, 2);
});

test('late spectators receive the active question, remaining time and round result', async () => {
  const { roomId, host } = await createGame();
  host.send({ type: 'startGame' });
  const question = await host.wait('question');
  await delay(150);
  const spectator = await connect({ roomId, spectator: true });
  const current = await spectator.wait('question');
  assert.equal(current.index, question.index);
  assert.equal(current.question, question.question);
  assert.deepEqual(current.options, question.options);
  assert.equal(current.answerIndex, undefined);
  assert.ok(current.timeRemainingMs > 0);
  assert.ok(current.timeRemainingMs < question.timeRemainingMs);
  host.send({ type: 'submitAnswer', option: correctOption(question) });
  const result = await host.wait('roundResult');
  assert.deepEqual(await spectator.wait('roundResult'), result);

  // Joining during the result display must also restore the current phase.
  const resultSpectator = await connect({ roomId, spectator: true });
  assert.equal((await resultSpectator.wait('question')).timeRemainingMs, 0);
  assert.deepEqual(await resultSpectator.wait('roundResult'), result);
  const next = await spectator.wait('question', item => item.index === 2);
  assert.equal(next.total, 15);
  assert.ok(next.timeRemainingMs > 0);
  assert.equal((await resultSpectator.wait('question', item => item.index === 2)).question, next.question);
  const nextSpectator = await connect({ roomId, spectator: true });
  assert.equal((await nextSpectator.wait('question')).index, 2);
  assert.equal(nextSpectator.messages.some(item => item.type === 'roundResult'), false);
});
