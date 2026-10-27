import assert from 'node:assert/strict';
import test from 'node:test';
import { getSession, saveSession } from '../public/common.js';

const storage = () => { const values = new Map(); return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) }; };

test('two browser tabs retain their own player identity when either tab is refreshed', t => {
  const previous = globalThis.window; t.after(() => { globalThis.window = previous; });
  const shared = storage(); const hostTab = storage(); const guestTab = storage();
  globalThis.window = { localStorage: shared, sessionStorage: hostTab };
  saveSession('abc123', { playerToken: 'host-token', playerId: 'host' }, 'Host');
  globalThis.window = { localStorage: shared, sessionStorage: guestTab };
  saveSession('abc123', { playerToken: 'guest-token', playerId: 'guest' }, 'Guest');
  assert.equal(getSession('abc123').token, 'guest-token');
  globalThis.window = { localStorage: shared, sessionStorage: hostTab };
  assert.equal(getSession('abc123').token, 'host-token');
  assert.equal(getSession('abc123').nick, 'Host');
});

test('a fresh tab can recover the last saved session and blocked local storage still permits refresh', t => {
  const previous = globalThis.window; t.after(() => { globalThis.window = previous; });
  const shared = storage();
  globalThis.window = { localStorage: shared, sessionStorage: storage() };
  saveSession('abc123', { playerToken: 'saved-token', playerId: 'player' }, 'Player');
  globalThis.window = { localStorage: shared, sessionStorage: storage() };
  assert.equal(getSession('abc123').token, 'saved-token');
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  globalThis.window = { localStorage: blocked, sessionStorage: storage() };
  saveSession('xyz789', { playerToken: 'tab-token', playerId: 'tab' }, 'Tab');
  assert.equal(getSession('xyz789').token, 'tab-token');
});
