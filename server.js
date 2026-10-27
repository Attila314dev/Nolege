import { createQuizServer } from './lib/server.js';
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const quiz = createQuizServer();
const port = Number(process.env.PORT || 10000);
quiz.server.listen(port, '0.0.0.0', () => {
  console.log(`Nolege 2.0 listening on ${quiz.server.address().port}`);
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.once(signal, async () => {
    await quiz.close();
    process.exit(0);
  });
}
