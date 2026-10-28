import assert from 'node:assert/strict';
import test from 'node:test';
import { createFocusMode, matchInProgress } from '../public/focus.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

class Element extends EventTarget {
  hidden = true;
  disabled = false;
  textContent = '';
  attributes = new Map();
  classes = new Set();
  classList = { toggle: (name, value) => value ? this.classes.add(name) : this.classes.delete(name) };
  setAttribute(name, value) { this.attributes.set(name, value); }
  click() { this.dispatchEvent(new Event('click')); }
}
class Lock extends EventTarget {
  released = false;
  async release() { this.released = true; this.dispatchEvent(new Event('release')); }
}
function setup({ fullscreen = 'standard', awake = true, request } = {}) {
  const doc = new EventTarget();
  doc.hidden = false;
  doc.defaultView = new EventTarget();
  doc.body = new Element();
  doc.documentElement = new Element();
  const elements = new Map(['focusToolbar', 'fullscreenButton', 'awakeButton'].map(id => [id, new Element()]));
  doc.querySelector = selector => elements.get(selector.slice(1));
  const dialog = { open: true, close() { this.open = false; } };
  doc.querySelectorAll = () => dialog.open ? [dialog] : [];
  const locks = [];
  let requests = 0;
  const nav = awake ? { wakeLock: { async request(type) {
    assert.equal(type, 'screen'); requests++;
    const lock = request ? await request() : new Lock();
    locks.push(lock); return lock;
  } } } : {};
  if (fullscreen) {
    const prefix = fullscreen === 'webkit';
    const elementKey = prefix ? 'webkitFullscreenElement' : 'fullscreenElement';
    const event = prefix ? 'webkitfullscreenchange' : 'fullscreenchange';
    doc[prefix ? 'webkitFullscreenEnabled' : 'fullscreenEnabled'] = true;
    doc.documentElement[prefix ? 'webkitRequestFullscreen' : 'requestFullscreen'] = async () => {
      doc[elementKey] = doc.documentElement; doc.dispatchEvent(new Event(event));
    };
    doc[prefix ? 'webkitExitFullscreen' : 'exitFullscreen'] = async () => {
      doc[elementKey] = null; doc.dispatchEvent(new Event(event));
    };
  }
  const notices = [];
  const mode = createFocusMode({ doc, nav, notify: message => notices.push(message) });
  return { doc, elements, locks, mode, dialog, notices, requests: () => requests };
}

test('focus covers every question and the result intervals, then releases the display at the end', async () => {
  const f = setup();
  for (const phase of ['lobby', 'question', 'result', 'question', 'result', 'finished']) {
    f.mode.setActive(matchInProgress(phase));
    await flush();
    const active = phase === 'question' || phase === 'result';
    assert.equal(f.doc.body.classes.has('match-focus'), active, phase);
    assert.equal(f.elements.get('focusToolbar').hidden, !active, phase);
  }
  assert.equal(f.dialog.open, false);
  assert.equal(f.requests(), 1, 'state broadcasts must not repeatedly acquire wake locks');
  assert.equal(f.locks[0].released, true);
});

test('focus works when mobile fullscreen and wake-lock APIs are missing or disallowed', async () => {
  const f = setup({ fullscreen: false, awake: false });
  f.mode.setActive(true);
  assert.equal(f.elements.get('fullscreenButton').hidden, true);
  assert.equal(f.elements.get('awakeButton').hidden, true);
  assert.equal(f.doc.body.classes.has('match-focus'), true);
  const denied = setup({ request: async () => { throw new Error('Low battery or permission denied'); } });
  denied.mode.setActive(true); await flush();
  assert.equal(denied.doc.body.classes.has('match-focus'), true);
  assert.equal(denied.elements.get('awakeButton').attributes.get('aria-pressed'), 'false');
});

test('returning to the visible match reacquires wake lock and the user can turn it off', async () => {
  const f = setup();
  f.mode.setActive(true); await flush();
  f.doc.hidden = true; f.doc.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(f.locks[0].released, true);
  f.doc.hidden = false; f.doc.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(f.requests(), 2);
  f.elements.get('awakeButton').click(); await flush();
  assert.equal(f.locks[1].released, true);
  f.doc.dispatchEvent(new Event('visibilitychange')); await flush();
  assert.equal(f.requests(), 2, 'an explicit off preference must survive visibility changes');
  f.elements.get('awakeButton').click(); await flush();
  assert.equal(f.requests(), 3);
  f.doc.defaultView.dispatchEvent(new Event('pagehide')); await flush();
  assert.equal(f.locks[2].released, true);
});

test('a slow wake-lock request cannot keep the screen awake after the match ends', async () => {
  let resolve;
  const f = setup({ request: () => new Promise(done => { resolve = done; }) });
  f.mode.setActive(true);
  f.mode.setActive(false);
  const lock = new Lock(); resolve(lock); await flush();
  assert.equal(lock.released, true);
  assert.equal(f.elements.get('awakeButton').attributes.get('aria-pressed'), 'false');
});

test('fullscreen follows a tap, can be exited, and is cleaned up when the match finishes', async () => {
  for (const fullscreen of ['standard', 'webkit']) {
    const f = setup({ fullscreen });
    f.mode.setActive(true);
    assert.equal(f.doc.fullscreenElement || f.doc.webkitFullscreenElement, undefined);
    f.elements.get('fullscreenButton').click(); await flush();
    assert.equal(f.elements.get('fullscreenButton').attributes.get('aria-pressed'), 'true');
    f.elements.get('fullscreenButton').click(); await flush();
    assert.equal(f.elements.get('fullscreenButton').attributes.get('aria-pressed'), 'false');
    f.elements.get('fullscreenButton').click(); await flush();
    f.mode.setActive(false); await flush();
    assert.equal(f.elements.get('fullscreenButton').attributes.get('aria-pressed'), 'false');
  }
});

test('a rejected fullscreen request preserves the playable focus view', async () => {
  const f = setup();
  f.doc.documentElement.requestFullscreen = async () => { throw new Error('Not allowed'); };
  // Capture the rejected implementation when the controller is created.
  const mode = createFocusMode({ doc: f.doc, nav: {}, notify: message => f.notices.push(message) });
  mode.setActive(true);
  f.elements.get('fullscreenButton').click(); await flush();
  assert.equal(f.doc.body.classes.has('match-focus'), true);
  assert.equal(f.elements.get('fullscreenButton').disabled, false);
  assert.equal(f.notices.length, 1);
});
