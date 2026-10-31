import { createQuizServer } from './lib/server.js';
import { existsSync } from 'node:fs';
import { filePoolStore, redisPoolStore } from './lib/pool-store.js';
import { createCatalog, loadCatalogSeed } from './lib/catalog.js';
import { fileCatalogStore, githubCatalogStore } from './lib/catalog-store.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const poolStore = process.env.REDIS_URL?.trim()
  ? redisPoolStore(process.env.REDIS_URL.trim())
  : filePoolStore(process.env.QUESTION_POOL_FILE || './data/general-pool.json');
const seed = loadCatalogSeed();
const catalogStore = process.env.RENDER || process.env.GITHUB_BANK_TOKEN
  ? githubCatalogStore({ token: process.env.GITHUB_BANK_TOKEN, repo: process.env.GITHUB_BANK_REPO || 'Attila314dev/Nolege', fallback: seed })
  : fileCatalogStore(process.env.CATALOG_FILE || './bank/catalog.json', seed);
const catalog = createCatalog({ store: catalogStore });
await catalog.ready;
const quiz = createQuizServer({ poolStore, catalog });
await quiz.ready;
const port = Number(process.env.PORT || 10000);
quiz.server.listen(port, '0.0.0.0', () => {
  console.log(`Nolege 3.3 listening on ${quiz.server.address().port}; catalog store: ${catalogStore.kind}; pool store: ${poolStore.kind}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await quiz.close();
    process.exit(0);
  });
}
