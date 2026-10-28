import { createQuizServer } from './lib/server.js';
import { existsSync } from 'node:fs';
import { filePoolStore, redisPoolStore } from './lib/pool-store.js';

if (existsSync('.env')) process.loadEnvFile('.env');

const poolStore = process.env.REDIS_URL?.trim()
  ? redisPoolStore(process.env.REDIS_URL.trim())
  : filePoolStore(process.env.QUESTION_POOL_FILE || './data/general-pool.json');
const quiz = createQuizServer({ poolStore });
await quiz.ready;
const port = Number(process.env.PORT || 10000);
quiz.server.listen(port, '0.0.0.0', () => {
  console.log(`Nolege 2.1 listening on ${quiz.server.address().port}; pool store: ${poolStore.kind}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await quiz.close();
    process.exit(0);
  });
}
