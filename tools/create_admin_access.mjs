import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { hashAdminPassword, tokenHash } from '../lib/admin-auth.js';

// Keep plaintext access credentials outside the repository. The terminal only
// receives a path; Render receives hashes and the independent signing secret.
const filename = path.resolve(process.argv[2] || path.join(tmpdir(), `nolege-private-${Date.now()}.json`));
const password = randomBytes(24).toString('base64url');
const assistantToken = randomBytes(32).toString('base64url');
const value = { username: 'attila', password, assistantToken, createdAt: new Date().toISOString(),
  renderEnv: { ADMIN_OWNER_USERNAME: 'attila', ADMIN_OWNER_PASSWORD_HASH: await hashAdminPassword(password),
    ADMIN_ASSISTANT_TOKEN_HASH: tokenHash(assistantToken), ADMIN_SESSION_SECRET: randomBytes(48).toString('base64url') } };
await writeFile(filename, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
console.log(filename);
