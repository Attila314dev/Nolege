import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createAI } from '../lib/ai.js';
import { createQuizServer } from '../lib/server.js';

const launch = { headless: true };
if (process.env.CHROMIUM_EXECUTABLE) launch.executablePath = process.env.CHROMIUM_EXECUTABLE;
const browser = await chromium.launch(launch);
const app = createQuizServer({ ai: createAI({ env: {} }), timings: { questionMs: 60_000, resultMs: 1500 } });
await app.ready;
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const errors = [];
const sizes = [[375, 667], [390, 844], [412, 915], [768, 1024], [844, 390], [1365, 900]];
try {
  for (const [width, height] of sizes) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base);
    await page.locator('#homeAIStatus').getByText('AI nincs beállítva', { exact: true }).waitFor();
    await page.locator('#hostNick').fill(`Mobil${width}`);
    await page.locator('#createForm [name=topic]').fill('Modern popzene');
    assert.equal(await page.locator('#createForm [name=count]').inputValue(), '20');
    await page.locator('#createForm [name=topic]').fill('');
    assert.equal(await page.locator('#createForm [name=count]').inputValue(), '15');
    await page.locator('#createForm [name=count]').fill('3');
    await page.locator('#createButton').click();
    await page.locator('#startGame:not([disabled])').waitFor();
    await page.locator('#startGame').click();
    await page.locator('body.match-focus .question-text').waitFor();
    if (width === 375) {
      await page.reload();
      await page.locator('body.match-focus .question-text').waitFor();
      await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
      await page.screenshot({ path: new URL('../docs/nolege-v3.1-mobile-focus.png', import.meta.url).pathname, fullPage: true });
    }
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    assert.equal(await page.locator('.site-header').isVisible(), false);
    assert.equal(await page.locator('[data-chat]:visible').count(), 0);
    const layout = await page.evaluate(() => ({ width: innerWidth, content: document.documentElement.scrollWidth,
      answers: [...document.querySelectorAll('[data-answer]')].map(el => ({ height: el.getBoundingClientRect().height, right: el.getBoundingClientRect().right })) }));
    assert.ok(layout.content <= layout.width + 1, `horizontal overflow at ${width}x${height}`);
    assert.ok(layout.answers.every(answer => answer.height >= 44 && answer.right <= width + 1));
    for (let index = 1; index <= 3; index++) {
      await page.locator('.question-text').waitFor();
      await page.locator('[data-answer]').first().click();
      await page.locator('.result-title').waitFor();
      assert.equal(await page.locator('body.match-focus').count(), 1);
      assert.equal(await page.locator('[data-chat]:visible').count(), 0);
      assert.ok((await page.locator('.explanation').innerText()).length > 10);
      if (index === 3) await page.locator('.finish-stage').waitFor();
      else await page.locator('.question-text').waitFor();
    }
    assert.equal(await page.locator('body.match-focus').count(), 0);
    await page.locator('#reviewList [data-chat]').first().click();
    await page.locator('#chatInput').fill('Miért ez a jó válasz?');
    await page.locator('#chatSend').click();
    await page.locator('.chat-source').getByText('Beépített segéd', { exact: false }).waitFor();
    await page.locator('#closeChat').click();
    console.log(`PASS ${width}x${height}: play, result focus, no overflow, chat after finish`);
    await context.close();
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
} finally {
  await browser.close();
  await app.close();
}
