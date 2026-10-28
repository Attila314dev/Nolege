import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { createQuizServer } from '../lib/server.js';
import { createAI } from '../lib/ai.js';
import { createCatalog, loadCatalogSeed } from '../lib/catalog.js';
import { memoryCatalogStore } from '../lib/catalog-store.js';
import { hashAdminPassword } from '../lib/admin-auth.js';

const password = 'test-only-browser-password';
const adminEnv = { ADMIN_SESSION_SECRET: 'test-only-browser-session-secret-0123456789', ADMIN_OWNER_PASSWORD_HASH: await hashAdminPassword(password) };
let inference = 0;
const ai = createAI({ env: { OPENROUTER_API_KEY: 'test-only-browser-api-key' }, fetchImpl: async (url, options) => {
  if (url.endsWith('/models')) return Response.json({ data: [] });
  if (url.endsWith('/key')) return Response.json({ data: { free_model_daily_requests: { used: 4, limit: 50, remaining: 46 } } });
  inference++;
  const body = JSON.parse(options.body);
  let content = 'rendben';
  if (body.response_format) {
    const count = JSON.parse(body.messages.at(-1).content).kerdesekSzama;
    content = JSON.stringify({ questions: Array.from({ length: count }, (_, i) => ({ question: `Böngészőpróba: mennyi ${i + 700} meg 2?`, correct: String(i + 702), wrong: [String(i + 703), String(i + 704), String(i + 705)], category: 'Böngészőpróba', difficulty: 'easy', explanation: 'Kettőt hozzáadunk a kiinduló számhoz.' })) });
  }
  return Response.json({ model: 'mock/model:free', usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }, choices: [{ finish_reason: 'stop', message: { content } }] });
} });
const catalog = createCatalog({ store: memoryCatalogStore(loadCatalogSeed()) });
await catalog.ready;
const app = createQuizServer({ catalog, adminEnv, ai });
await app.ready;
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
const temp = await mkdtemp(path.join(tmpdir(), 'nolege-admin-browser-'));
const errors = [];
async function noOverflow(page, name) {
  const layout = await page.evaluate(() => ({ view: innerWidth, width: document.documentElement.scrollWidth, modal: [...document.querySelectorAll('dialog[open]')].map(el => ({ width: el.scrollWidth, client: el.clientWidth })) }));
  assert.ok(layout.width <= layout.view + 1, `${name}: horizontal overflow ${JSON.stringify(layout)}`);
  assert.ok(layout.modal.every(el => el.width <= el.client + 1), `${name}: dialog overflow`);
}
async function filter(page, name, value) {
  const response = page.waitForResponse(r => r.url().includes('/api/admin/questions?') && r.request().method() === 'GET');
  await page.locator(`#filtersForm [name=${name}]`).selectOption(value); await response;
  await page.waitForFunction(() => !document.querySelector('#questionList').textContent.includes('undefined'));
}
try {
  for (const [width, height] of [[375, 667], [390, 844], [412, 915], [768, 1024], [844, 390], [1365, 900]]) {
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 900, hasTouch: width < 900 });
    const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/admin`); await page.locator('#loginForm [name=password]').fill(password);
    await noOverflow(page, `login ${width}`);
    await page.locator('#loginButton').click(); await page.locator('#questionList [data-edit]').first().waitFor();
    assert.match(await page.locator('#adminStats').innerText(), /940/);
    assert.match(await page.locator('#listCount').innerText(), /800/);
    await noOverflow(page, `bank ${width}`);
    if ([375, 1365].includes(width)) {
      await mkdir(new URL('../docs/', import.meta.url), { recursive: true });
      await page.screenshot({ path: new URL(`../docs/nolege-admin-${width === 375 ? 'mobile' : 'desktop'}.png`, import.meta.url).pathname, fullPage: true });
    }
    await page.locator('#questionList [data-edit]').first().click(); await page.locator('#questionDialog[open]').waitFor();
    assert.match(await page.locator('#questionProvenance').innerText(), /ChatGPT/);
    await noOverflow(page, `editor ${width}`); await page.locator('[data-close=questionDialog]').click();
    await page.locator('[data-tab=api]').click(); await page.locator('#apiOverview .api-health').waitFor();
    await noOverflow(page, `API ${width}`);
    if (width === 375) {
      await page.locator('#refreshAPI').click(); await page.getByText('46 kérés maradt', { exact: true }).waitFor(); assert.equal(inference, 0);
      await page.locator('#testAPI').click(); await page.waitForFunction(() => document.querySelector('#testAPI').textContent.includes('· AI-kéréssel'));
      assert.equal(inference, 1);
      await page.locator('#generateForm [name=topic]').fill('Böngészőpróba'); await page.locator('#generateForm [name=count]').fill('2');
      await page.locator('#generateForm [name=difficulty]').selectOption('easy'); await page.locator('#generateButton').click();
      await page.locator('#generationDialog[open]').waitFor(); assert.equal(await page.locator('[data-generated]').count(), 2);
      await page.locator('[data-generated="0"] [name=explanation]').fill('Szerkesztett próbamondat az előnézetben.');
      await noOverflow(page, 'generated preview'); await page.locator('#saveGenerated').click(); await page.locator('#generationDialog').waitFor({ state: 'hidden' });
      assert.equal(catalog.summary().stats.sources.api, 2); assert.equal(catalog.summary().stats.statuses.approved, 140); assert.equal(inference, 2);
      const generated = catalog.list({ source: 'api' }).questions[0]; assert.equal(generated.model, 'mock/model:free'); assert.match(generated.explanation, /Szerkesztett/);
      // Restore the seed between viewport tests; all writes are isolated in memory.
      await catalog.restore(loadCatalogSeed(), catalog.summary().revision, 'Browser fixture');
    }
    await page.locator('[data-tab=backups]').click(); await noOverflow(page, `backup ${width}`);
    if (width === 1365) {
      const downloadPromise = page.waitForEvent('download'); await page.locator('#downloadBackup').click();
      const backupPath = path.join(temp, 'backup.json'); await (await downloadPromise).saveAs(backupPath);
      const backup = JSON.parse(await readFile(backupPath, 'utf8')); assert.equal(backup.catalog.questions.length, 940);
      await page.locator('[data-tab=bank]').click(); await page.locator('#newQuestion').click(); await page.locator('#questionDialog[open]').waitFor();
      const form = page.locator('#questionForm');
      for (const [name, value] of Object.entries({ question: 'Böngészőpróba: mennyi kilenc meg három?', category: 'Próba', answer0: '12', answer1: '11', answer2: '13', answer3: '14', explanation: 'Kilenc és három összege tizenkettő.' })) await form.locator(`[name=${name}]`).fill(value);
      await page.locator('#saveQuestion').click(); await page.locator('#questionDialog').waitFor({ state: 'hidden' });
      assert.equal(catalog.summary().stats.total, 941);
      await filter(page, 'status', 'draft'); await page.locator('#questionList [data-edit]').first().waitFor();
      await page.locator('#questionList [data-edit]').first().click(); await form.locator('[name=explanation]').fill('Átnézett próbamondat.');
      await page.locator('#saveQuestion').click(); await page.locator('#questionDialog').waitFor({ state: 'hidden' });
      await page.locator('#selectAllResults').click(); await page.locator('#bulkBar:not([hidden])').waitFor();
      await page.locator('[data-bulk=approved]').click(); await page.locator('#confirmAction').click(); await page.locator('#confirmDialog').waitFor({ state: 'hidden' });
      assert.equal(catalog.summary().stats.statuses.approved, 141);
      await page.locator('[data-tab=backups]').click(); await page.locator('#restoreFile').setInputFiles(backupPath);
      await page.locator('#confirmDialog[open]').waitFor(); await page.locator('#confirmAction').click(); await page.locator('#confirmDialog').waitFor({ state: 'hidden' });
      assert.equal(catalog.summary().stats.total, 940); assert.equal(catalog.summary().stats.statuses.approved, 140);
      await page.locator('[data-tab=bank]').click(); await filter(page, 'status', 'review');
      const importPromise = page.waitForResponse(r => r.url().endsWith('/api/admin/import'));
      await page.locator('#bankImport').setInputFiles({ name: 'repeat.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(catalog.export({ status: 'review' }).questions.slice(0, 2))) });
      await page.locator('#confirmDialog[open]').waitFor(); await page.locator('#confirmAction').click(); const importResponse = await importPromise;
      assert.equal((await importResponse.json()).duplicates, 2); await page.locator('#confirmDialog').waitFor({ state: 'hidden' });
    }
    await page.locator('[data-tab=audit]').click(); await page.locator('#auditList .audit-entry').first().waitFor(); await noOverflow(page, `audit ${width}`);
    await page.locator('#logoutButton').click(); await page.locator('#loginSection:not([hidden])').waitFor();
    assert.equal((await context.request.get(`${base}/api/admin/summary`)).status(), 401);
    console.log(`PASS admin ${width}x${height}: login, filters, editor, API, backups, audit, logout; no overflow`);
    await context.close();
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
} finally { await browser.close(); await app.close(); await rm(temp, { recursive: true, force: true }); }
