import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createQuizServer } from '../lib/server.js';
import { createAI } from '../lib/ai.js';

const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const app = createQuizServer({ ai: createAI({ env: {} }), timings: { questionMs: 15_000, resultMs: 700 } });
await app.ready; await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`, errors = [];
await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
async function noOverflow(page, label) {
  const layout = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth, dialogs: [...document.querySelectorAll('dialog[open]')].map(el => [el.scrollWidth, el.clientWidth]) }));
  assert.ok(layout.content <= layout.width + 1, `${label}: ${JSON.stringify(layout)}`);
  assert.ok(layout.dialogs.every(([content, width]) => content <= width + 1), `${label}: dialog overflow`);
}
async function getPage(context) { const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message)); return page; }
try {
  for (const [width, height] of [[320, 568], [375, 667], [390, 844], [768, 1024], [844, 390], [1365, 900]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await getPage(context); await page.goto(base); await page.locator('[data-theme-choice]').first().waitFor();
    assert.equal(await page.locator('[data-theme-choice]').count(), 3);
    for (const theme of ['sage', 'blue', 'coral']) {
      await page.locator(`[data-theme-choice=${theme}]`).click();
      assert.equal(await page.locator('html').getAttribute('data-theme'), theme);
      assert.equal(await page.locator('[data-theme-choice][aria-pressed=true]').count(), 1);
      assert.equal(await page.locator(`[data-theme-choice=${theme}] .theme-check`).innerText(), '✓');
      await noOverflow(page, `${width} ${theme}`);
    }
    const position = await page.evaluate(() => { const rect = selector => document.querySelector(selector).getBoundingClientRect(); return { brand: rect('.site-header>.brand').right, pickerLeft: rect('[data-theme-switcher]').left, pickerRight: rect('[data-theme-switcher]').right, live: rect('.site-header>.pill').left }; });
    assert.ok(position.brand <= position.pickerLeft && position.pickerRight <= position.live + 1, `theme picker order at ${width}`);
    await page.reload(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'coral');
    await page.locator('[data-install]').click(); await page.locator('#installDialog[open]').waitFor(); await noOverflow(page, `install ${width}`); await page.locator('#closeInstall').click();
    await page.goto(`${base}/admin`); await page.locator('[data-theme-choice]').first().waitFor(); assert.equal(await page.locator('html').getAttribute('data-theme'), 'coral'); await noOverflow(page, `admin theme ${width}`);
    if ([375, 1365].includes(width)) {
      await page.goto(base); await page.locator('[data-theme-choice=blue]').click();
      await page.waitForTimeout(200); // Let the existing button color transition finish before capture.
      await page.screenshot({ path: new URL(`../docs/nolege-v3.1-blue-${width}.png`, import.meta.url).pathname, fullPage: true });
      await page.locator('[data-theme-choice=coral]').click();
      await page.waitForTimeout(200);
      await page.screenshot({ path: new URL(`../docs/nolege-v3.1-coral-${width}.png`, import.meta.url).pathname, fullPage: true });
    }
    console.log(`PASS ${width}x${height}: all themes, checked squares, persistence, install help, admin, no overflow`);
    await context.close();
  }

  const pwa = await browser.newContext(); const page = await getPage(pwa); await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready); await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  const manifestResponse = await pwa.request.get(`${base}/app.webmanifest`); assert.equal(manifestResponse.status(), 200); assert.match(manifestResponse.headers()['content-type'], /manifest\+json/);
  await page.evaluate(() => { const event = new Event('beforeinstallprompt', { cancelable: true }); event.prompt = async () => { window.installInvoked = true; }; event.userChoice = Promise.resolve({ outcome: 'dismissed' }); dispatchEvent(event); });
  await page.locator('[data-install]').click(); await page.locator('#nativeInstall').click(); assert.equal(await page.evaluate(() => window.installInvoked), true); await page.locator('#closeInstall').click();
  await pwa.setOffline(true); await page.goto(`${base}/?offline-check=1`); await page.getByText('Kapcsolódjunk újra.', { exact: true }).waitFor(); await noOverflow(page, 'offline page');
  await pwa.setOffline(false); await page.goto(base);
  const cached = await page.evaluate(async () => { const entries = []; for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) entries.push(new URL(request.url).pathname); return entries; });
  assert.ok(cached.includes('/offline.html')); assert.ok(cached.every(path => !path.startsWith('/api/') && !path.startsWith('/admin')));
  await pwa.close(); console.log('PASS PWA: manifest, active service worker, native install gesture, offline fallback, no private cache');

  const ios = await browser.newContext({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1', viewport: { width: 390, height: 844 } });
  const iphone = await getPage(ios); await iphone.goto(base); await iphone.locator('[data-install]').click(); assert.match(await iphone.locator('#installInstructions').innerText(), /Safariban/); await ios.close();
  const blocked = await browser.newContext(); await blocked.addInitScript(() => { Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('Blocked', 'SecurityError'); } }); });
  const fallback = await getPage(blocked); await fallback.goto(base); await fallback.locator('[data-theme-choice=blue]').click(); assert.equal(await fallback.locator('html').getAttribute('data-theme'), 'blue'); await blocked.close();
  console.log('PASS install instructions for iPhone and theme switching with blocked storage');

  const hostContext = await browser.newContext({ viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true });
  await hostContext.addInitScript(() => {
    window.audioProbe = { contexts: 0, tones: [] };
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.audioProbe.contexts++; }
      createOscillator() { const node = super.createOscillator(); let frequency = node.frequency.value; const set = node.frequency.setValueAtTime.bind(node.frequency); node.frequency.setValueAtTime = (value, ...args) => { frequency = value; return set(value, ...args); }; const start = node.start.bind(node); node.start = (...args) => { window.audioProbe.tones.push({ type: node.type, frequency }); return start(...args); }; return node; }
    };
  });
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const spectatorContext = await browser.newContext();
  const host = await getPage(hostContext), guest = await getPage(guestContext), spectator = await getPage(spectatorContext);
  const created = await (await hostContext.request.post(`${base}/api/createRoom`, { data: { nick: 'Nyertes', settings: { count: 1 } } })).json();
  const joined = await (await guestContext.request.post(`${base}/api/join`, { data: { roomId: created.roomId, nick: 'Játékostárs' } })).json();
  async function enter(page, session) {
    await page.goto(base);
    await page.evaluate(({ roomId, playerToken, playerId }) => { sessionStorage.setItem(`nolege:session:${roomId}`, JSON.stringify({ token: playerToken, playerId })); }, session);
    await page.goto(`${base}/room.html?room=${created.roomId}`);
  }
  await enter(host, created); await enter(guest, joined); await spectator.goto(`${base}/room.html?room=${created.roomId}&spectator=1`);
  await host.locator('#startGame').waitFor(); assert.equal(await host.evaluate(() => window.audioProbe.contexts), 0);
  await host.locator('[data-theme-choice=blue]').click(); await host.locator('#soundSettings').click(); await host.locator('#soundDialog[open]').waitFor(); await noOverflow(host, 'sound settings');
  await host.locator('#musicVolume').fill('12'); await host.locator('#effectsVolume').fill('35'); await host.locator('#closeSound').click();
  const packResponse = await hostContext.request.get(`${base}/api/rooms/${created.roomId}/pack`, { headers: { authorization: `Bearer ${created.playerToken}` } });
  assert.equal(packResponse.status(), 200); const pack = await packResponse.json(), correct = pack.questions[0].correct;
  await guest.locator('[data-action=ready]').click(); await host.locator('#startGame:not([disabled])').click();
  await host.locator('[data-answer]').first().waitFor(); await noOverflow(host, 'match');
  await host.waitForFunction(() => window.audioProbe.tones.some(tone => tone.type === 'triangle'));
  await host.locator('#matchMute').click(); assert.equal(await host.locator('#matchMute').getAttribute('aria-pressed'), 'true'); await host.locator('#matchMute').click();
  const correctIndex = await host.locator('[data-answer]').evaluateAll((buttons, answer) => buttons.findIndex(button => button.children[1].textContent === answer), correct);
  assert.ok(correctIndex >= 0);
  await guest.locator(`[data-answer="${(correctIndex + 1) % 4}"]`).click();
  await host.waitForFunction(() => Number(document.querySelector('#countdown')?.textContent) <= 5);
  await host.waitForFunction(() => window.audioProbe.tones.some(tone => [820, 1040].includes(Math.round(tone.frequency))));
  await host.locator(`[data-answer="${correctIndex}"]`).click();
  await host.locator('.finish-stage.is-winner').waitFor(); await host.locator('.confetti-canvas').waitFor();
  assert.equal(await guest.locator('.finish-stage.is-winner').count(), 0); assert.equal(await guest.locator('.confetti-canvas').count(), 0);
  assert.equal(await spectator.locator('.finish-stage.is-winner').count(), 0); assert.equal(await spectator.locator('.confetti-canvas').count(), 0);
  await host.waitForTimeout(650); // Capture the falling pieces after the first animation frames.
  await host.screenshot({ path: new URL('../docs/nolege-v3.1-winner-mobile.png', import.meta.url).pathname, fullPage: false });
  await host.reload(); await host.locator('.finish-stage.is-winner').waitFor(); assert.equal(await host.locator('.confetti-canvas').count(), 0);
  await host.locator('#soundSettings').click(); assert.equal(await host.locator('#musicVolume').inputValue(), '12'); assert.equal(await host.locator('#effectsVolume').inputValue(), '35');
  await hostContext.close(); await guestContext.close(); await spectatorContext.close();
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log('PASS multiplayer: gesture-only audio, ambient, mute, final-five-second tick, winner-only confetti, no repeat after refresh, saved volume');
} finally { await browser.close(); await app.close(); }
