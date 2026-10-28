import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from 'redis';

export function filePoolStore(filename) {
  return {
    kind: 'file',
    async read() {
      try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    },
    async write(value) {
      await fs.mkdir(path.dirname(filename), { recursive: true });
      const temporary = `${filename}.tmp`;
      await fs.writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
      await fs.rename(temporary, filename);
    },
    async close() {}
  };
}

// A separate store keeps the ready questions across web-service deployments.
// Free Render Key Value survives app restarts, but has no disk persistence of its own.
export function redisPoolStore(url, { key = 'nolege:general-pool:v1' } = {}) {
  const client = createClient({ url, disableOfflineQueue: true,
    socket: { connectTimeout: 5000, reconnectStrategy: false } });
  client.on('error', () => {}); // Errors are reported as safe storage status, never connection strings.
  let connecting;
  async function connect() {
    if (client.isReady) return;
    connecting ??= client.connect().finally(() => { connecting = null; });
    await connecting;
  }
  return {
    kind: 'redis',
    async read() { await connect(); const value = await client.withCommandOptions({ timeout: 5000 }).get(key); return value ? JSON.parse(value) : null; },
    async write(value) { await connect(); await client.withCommandOptions({ timeout: 5000 }).set(key, JSON.stringify(value)); },
    async close() { if (client.isOpen) client.destroy(); }
  };
}
