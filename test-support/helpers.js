import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createAI } from '../lib/ai.js';
import { createQuizServer } from '../lib/server.js';

export async function startApp(t, options = {}) {
  const quiz = createQuizServer({ ai: createAI({ env: {} }), timings: { questionMs: 1500, resultMs: 60 }, ...options });
  await new Promise(resolve => quiz.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${quiz.server.address().port}`;
  t.after(() => quiz.close());
  async function request(path, { method = 'GET', body, token } = {}) {
    const response = await fetch(base + path, { method, headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, headers: response.headers };
  }
  async function create(settings = { count: 2 }, password = '') {
    const result = await request('/api/createRoom', { method: 'POST', body: { nick: 'Host', password, settings } });
    if (result.status !== 201) throw new Error(result.data.error);
    return result.data;
  }
  async function connect(roomId, token, spectator = false) {
    const ws = new WebSocket(base.replace('http:', 'ws:'));
    const messages = [];
    ws.on('message', raw => messages.push(JSON.parse(raw.toString())));
    ws.on('error', () => {});
    await once(ws, 'open');
    const client = {
      ws, messages,
      send(value) { ws.send(JSON.stringify(value)); },
      async wait(predicate, after = 0) {
        for (let i = 0; i < 400; i++) {
          const message = messages.slice(after).find(predicate);
          if (message) return message;
          await delay(5);
        }
        throw new Error(`Message timed out: ${JSON.stringify(messages.at(-1))}`);
      },
      async state(predicate = () => true, after = 0) { return (await this.wait(message => message.type === 'state' && predicate(message.room), after)).room; }
    };
    client.send({ type: 'join', roomId, token, spectator });
    await client.wait(message => message.type === 'state' || message.type === 'error');
    return client;
  }
  return { ...quiz, base, request, create, connect };
}

export function correctOption(question, pack) {
  const source = pack.questions.find(q => q.question === question.text);
  if (!source) throw new Error('Question is missing from accepted pack');
  return question.options.indexOf(source.correct);
}
