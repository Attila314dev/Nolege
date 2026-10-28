import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCatalog, loadCatalogSeed } from '../lib/catalog.js';
import { fileCatalogStore, githubCatalogStore, memoryCatalogStore } from '../lib/catalog-store.js';
import { validateQuestion, fold } from '../lib/questions.js';

test('the starter catalog contains 800 distinct attributed review questions and preserves the 140 approved originals', () => {
  const seed = loadCatalogSeed(); assert.equal(seed.questions.length, 940);
  const authored = seed.questions.filter(q => q.source === 'chatgpt'); assert.equal(authored.length, 800);
  assert.equal(seed.questions.filter(q => q.status === 'approved').length, 140);
  const categories = new Map(); const texts = new Set();
  for (const q of seed.questions) {
    validateQuestion(q); assert.ok(q.wrong.length >= 3); assert.equal(new Set([q.correct, ...q.wrong.slice(0, 3)].map(fold)).size, 4);
    assert.ok(!texts.has(fold(q.question))); texts.add(fold(q.question));
    if (q.source === 'chatgpt') {
      assert.equal(q.wrong.length, 3);
      assert.equal(q.status, 'review'); assert.equal(q.createdBy, 'ChatGPT'); assert.ok(Date.parse(q.createdAt));
      categories.set(q.category, (categories.get(q.category) || 0) + 1);
    }
  }
  assert.equal(categories.size, 16); assert.ok([...categories.values()].every(count => count === 50));
  assert.equal(seed.settings.backgroundAI, false);
});

test('the new arithmetic cards independently satisfy their numerical equations', () => {
  let checked = 0;
  for (const q of loadCatalogSeed().questions.filter(q => q.id.startsWith('cg-mathematics-'))) {
    let match = q.question.match(/^Mennyi (−?\d+) ([+−×÷]) (−?\d+)\?$/);
    if (match) {
      const a = Number(match[1].replace('−', '-')), b = Number(match[3].replace('−', '-'));
      const result = { '+': () => a + b, '−': () => a - b, '×': () => a * b, '÷': () => a / b }[match[2]]();
      assert.equal(Number(q.correct), result, q.question); checked++;
    }
    match = q.question.match(/^Mennyi (\d+) pozitív négyzetgyöke\?$/);
    if (match) { assert.equal(Number(q.correct) ** 2, Number(match[1])); checked++; }
  }
  assert.ok(checked >= 8);
});

test('file catalog writes survive a new app instance and reject external edits without discarding them', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nolege-catalog-'));
  try {
    const file = path.join(dir, 'catalog.json'); const seed = loadCatalogSeed();
    const catalog = createCatalog({ store: fileCatalogStore(file, seed) }); await catalog.ready;
    const original = catalog.get('cg-geography-001');
    await catalog.save({ ...original, explanation: 'Tartósan módosított magyarázat.' }, catalog.summary().revision, 'Attila');
    const restarted = createCatalog({ store: fileCatalogStore(file, seed) }); await restarted.ready;
    assert.equal(restarted.get(original.id).explanation, 'Tartósan módosított magyarázat.');
    assert.equal(restarted.get(original.id).source, 'chatgpt'); assert.equal(restarted.get(original.id).updatedBy, 'Attila');
    const text = await readFile(file, 'utf8'); await writeFile(file, `${text}\n`);
    await assert.rejects(restarted.bulk([original.id], 'approved', restarted.summary().revision, 'Attila'), error => error.code === 'revision_conflict');
    assert.equal(await readFile(file, 'utf8'), `${text}\n`); assert.equal(restarted.get(original.id).status, 'review');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a GitHub catalog without runtime write permission exposes read-only state and rejects mutations', async () => {
  const seed = loadCatalogSeed(); let writes = 0;
  const store = githubCatalogStore({ fallback: seed, fetchImpl: async (_url, options) => {
    if (options.method === 'PUT') writes++;
    return Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(seed)).toString('base64'), sha: 'seed-sha' });
  } });
  const catalog = createCatalog({ store }); await catalog.ready; assert.equal(catalog.status().writable, false);
  await assert.rejects(catalog.bulk(['cg-geography-001'], 'approved', catalog.summary().revision, 'Attila'), error => error.code === 'storage_not_configured');
  assert.equal(writes, 0); assert.equal(catalog.get('cg-geography-001').status, 'review');
});

test('catalog growth beyond the GitHub inline limit reads the exact blob rather than a changing branch', async () => {
  const seed = loadCatalogSeed(), requests = [];
  const store = githubCatalogStore({ fallback: seed, token: 'test-only-token', fetchImpl: async url => {
    requests.push(url);
    return url.includes('/git/blobs/')
      ? Response.json({ encoding: 'base64', content: Buffer.from(JSON.stringify(seed)).toString('base64') })
      : Response.json({ encoding: 'none', content: '', sha: 'exact-file-sha' });
  } });
  assert.equal((await store.read()).questions.length, 940); assert.equal(requests.length, 2);
  assert.ok(requests[1].endsWith('/git/blobs/exact-file-sha'));
});

test('reloading and editing are serialized, preserving the reloaded revision', async () => {
  const seed = loadCatalogSeed(); let reads = 0, release;
  const underlying = memoryCatalogStore(seed);
  const store = { ...underlying, async read() { reads++; if (reads > 1) await new Promise(resolve => { release = resolve; }); return underlying.read(); } };
  const catalog = createCatalog({ store }); await catalog.ready;
  const reload = catalog.reload(); await new Promise(resolve => setImmediate(resolve));
  const edit = catalog.bulk(['cg-geography-001'], 'approved', catalog.summary().revision, 'Attila');
  release(); await reload; await edit;
  assert.equal(catalog.get('cg-geography-001').status, 'approved');
});
