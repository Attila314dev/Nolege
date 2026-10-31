import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { createGameAudio } from '../public/audio.js';
import { createCelebration, isWinner, winners } from '../public/celebration.js';

function audioFixture({ blockedStorage = false } = {}) {
  const contexts = [], intervals = new Map(), handlers = new Map(); let intervalId = 0;
  const parameter = () => ({ value: 0, cancelScheduledValues() {}, setTargetAtTime(value) { this.value = value; }, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const node = () => ({ gain: parameter(), frequency: parameter(), connect() {}, disconnect() { this.disconnected = true; } });
  class Context {
    constructor() { this.state = 'running'; this.currentTime = 0; this.destination = {}; this.oscillators = []; contexts.push(this); }
    createGain() { return node(); } createBiquadFilter() { return node(); }
    createOscillator() { const oscillator = { ...node(), start(time) { this.startTime = time; }, stop(time) { if (time === undefined) { this.stopped = true; this.onended?.(); } } }; this.oscillators.push(oscillator); return oscillator; }
    async resume() { this.state = 'running'; this.onstatechange?.(); }
    async suspend() { this.state = 'suspended'; this.onstatechange?.(); }
    async close() { this.state = 'closed'; this.onstatechange?.(); }
  }
  const saved = new Map();
  const win = { AudioContext: Context, localStorage: { getItem(key) { if (blockedStorage) throw Error('blocked'); return saved.get(key) || null; }, setItem(key, value) { if (blockedStorage) throw Error('blocked'); saved.set(key, value); } }, setInterval(fn) { intervals.set(++intervalId, fn); return intervalId; }, clearInterval(id) { intervals.delete(id); } };
  const doc = { hidden: false, addEventListener(name, fn) { handlers.set(name, fn); }, removeEventListener(name) { handlers.delete(name); } };
  return { audio: createGameAudio({ win, doc }), contexts, intervals, doc, handlers, win };
}
const question = { phase: 'question', gameId: 'game1', questionId: 'q1', answered: false };

test('audio waits for an interaction, loops only during a match and releases voices on disconnect', async () => {
  const f = audioFixture(); f.audio.setMatch(question); assert.equal(f.contexts.length, 0);
  assert.equal(f.audio.tick(5), false); await f.audio.unlock();
  assert.equal(f.contexts.length, 1); assert.equal(f.intervals.size, 1); assert.ok(f.contexts[0].oscillators.length >= 4);
  f.audio.pause(); assert.equal(f.intervals.size, 0); assert.ok(f.contexts[0].oscillators.every(n => n.stopped));
  f.audio.setMatch({ ...question, phase: 'result' }); assert.equal(f.intervals.size, 1);
  f.audio.setMatch({ ...question, phase: 'finished' }); assert.equal(f.intervals.size, 0);
  await f.audio.close(); assert.equal(f.contexts[0].state, 'closed'); assert.equal(f.handlers.size, 0);
});

test('the final five seconds tick once each and stop after answering or muting', async () => {
  const f = audioFixture(); await f.audio.unlock(); f.audio.setPreferences({ musicEnabled: false }); f.audio.setMatch(question);
  for (const second of [8, 7, 6]) assert.equal(f.audio.tick(second), false);
  for (const second of [5, 4, 3, 2, 1]) { assert.equal(f.audio.tick(second), true); assert.equal(f.audio.tick(second), false); }
  assert.equal(f.contexts[0].oscillators.length, 5); assert.equal(f.audio.tick(0), false);
  assert.equal(f.audio.tick(3), false, 'a delayed server sync must not replay an earlier second');
  f.audio.setMatch({ ...question, questionId: 'q2', answered: true }); assert.equal(f.audio.tick(3), false);
  f.audio.setMatch({ ...question, questionId: 'q3' }); f.audio.setPreferences({ muted: true }); assert.equal(f.audio.tick(3), false);
  f.audio.setPreferences({ muted: false, effectsEnabled: false }); assert.equal(f.audio.tick(2), false);
  await f.audio.close();
});

test('backgrounding suspends sound; returning restores it and preferences survive storage restrictions', async () => {
  const f = audioFixture({ blockedStorage: true }); await f.audio.unlock(); f.audio.setMatch(question);
  f.audio.setPreferences({ musicVolume: 900, effectsVolume: -10 }); assert.equal(f.audio.state().musicVolume, 100); assert.equal(f.audio.state().effectsVolume, 0);
  f.doc.hidden = true; f.handlers.get('visibilitychange')(); assert.equal(f.intervals.size, 0); assert.equal(f.contexts[0].state, 'suspended');
  f.doc.hidden = false; f.handlers.get('visibilitychange')(); await Promise.resolve(); assert.equal(f.contexts[0].state, 'running'); assert.equal(f.intervals.size, 1);
  f.audio.setPreferences({ effectsVolume: 45 }); assert.equal(f.audio.win('game1'), true); assert.equal(f.audio.win('game1'), false);
  await f.audio.close();
});

test('celebration includes tied winners, excludes spectators and zero scores, and does not repeat on refresh', () => {
  const players = [{ id: 'a', score: 100 }, { id: 'b', score: 100 }, { id: 'c', score: 0 }];
  assert.deepEqual(winners(players).map(p => p.id), ['a', 'b']); assert.deepEqual(winners([{ id: 'a', score: 0 }]), []);
  const room = { id: 'room1', gameId: 'game1', phase: 'finished', players, you: { id: 'a' } };
  assert.equal(isWinner(room), true); assert.equal(isWinner({ ...room, you: { id: 'a', spectator: true } }), false);
  const saved = new Map(); const doc = { hidden: false, addEventListener() {} };
  const win = { matchMedia: () => ({ matches: true }), sessionStorage: { getItem: k => saved.get(k), setItem: (k, v) => saved.set(k, v) } };
  const celebration = createCelebration({ win, doc }); assert.equal(celebration.show(room), true); assert.equal(celebration.show(room), false);
  assert.equal(createCelebration({ win, doc }).show(room), false);
  assert.equal(celebration.show({ ...room, gameId: 'game2' }), true);
  assert.equal(celebration.show({ ...room, gameId: 'game3', you: { id: 'c' } }), false);
});

test('the service worker never intercepts API, admin, authenticated or write requests', async () => {
  const handlers = new Map(); const fallback = new Response('offline');
  const self = { location: { origin: 'https://nolege.test' }, addEventListener: (name, fn) => handlers.set(name, fn) };
  vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, URL, Set, caches: { match: async () => fallback }, fetch: async () => { throw Error('offline'); } });
  const listener = handlers.get('fetch');
  for (const [path, method, auth] of [['/api/meta', 'GET'], ['/api/admin/summary', 'GET'], ['/admin', 'GET'], ['/admin.html', 'GET'], ['/room.html', 'GET', true], ['/', 'POST'], ['https://other.test/style.css', 'GET']]) {
    let intercepted = false; listener({ request: { url: new URL(path, self.location.origin).href, method, mode: 'navigate', headers: new Headers(auth ? { authorization: 'Bearer fixture' } : {}) }, respondWith() { intercepted = true; } }); assert.equal(intercepted, false, path);
  }
  let response; listener({ request: { url: 'https://nolege.test/room.html?room=abc', method: 'GET', mode: 'navigate', headers: new Headers() }, respondWith(value) { response = value; } });
  assert.equal(await (await response).text(), 'offline');
});

test('the install manifest points at real icons and starts at the public home page', () => {
  const root = new URL('../public/', import.meta.url), manifest = JSON.parse(fs.readFileSync(new URL('app.webmanifest', root)));
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.scope, '/'); assert.equal(new URL(manifest.start_url, 'https://nolege.test').pathname, '/');
  for (const icon of manifest.icons) {
    const png = fs.readFileSync(new URL(icon.src.slice(1), root));
    const [width, height] = icon.sizes.split('x').map(Number); assert.equal(png.readUInt32BE(16), width); assert.equal(png.readUInt32BE(20), height);
  }
});
