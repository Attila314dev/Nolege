import { randomBytes, scrypt, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { QuizError } from './questions.js';

const derive = promisify(scrypt);
const equal = (left, right) => {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
};
export const tokenHash = value => createHash('sha256').update(value).digest('hex');
export async function hashAdminPassword(password) {
  const salt = randomBytes(24).toString('hex');
  return `scrypt:${salt}:${(await derive(password, salt, 64)).toString('hex')}`;
}
async function passwordMatches(password, encoded) {
  const [method, salt, expected] = String(encoded || '').split(':');
  if (method !== 'scrypt' || !/^[a-f0-9]{48}$/.test(salt) || !/^[a-f0-9]{128}$/.test(expected)) return false;
  return equal((await derive(password, salt, 64)).toString('hex'), expected);
}

export function createAdminAuth({ env = process.env, now = Date.now } = {}) {
  const secret = env.ADMIN_SESSION_SECRET || '';
  const ownerHash = env.ADMIN_OWNER_PASSWORD_HASH || '';
  const assistantHash = env.ADMIN_ASSISTANT_TOKEN_HASH || '';
  const owner = env.ADMIN_OWNER_USERNAME || 'attila';
  const configured = secret.length >= 32 && ownerHash.startsWith('scrypt:');
  const attempts = new Map();
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  function sameOrigin(req) {
    const origin = req.get('origin');
    if (origin && origin !== `${req.protocol}://${req.get('host')}`) throw new QuizError('Az adminművelet csak a saját oldalról indítható.', 403, 'origin_denied');
  }
  function cookie(req, value, maxAge) {
    return `nolege_admin=${value}; Path=/api/admin; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${req.secure ? '; Secure' : ''}`;
  }
  function authenticate(req, mutation = false) {
    if (!configured) throw new QuizError('Az adminbelépés még nincs beállítva.', 503, 'admin_not_configured');
    const bearer = req.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,200})$/)?.[1];
    if (bearer && assistantHash.length === 64 && equal(tokenHash(bearer), assistantHash)) {
      if (mutation) sameOrigin(req);
      return { role: 'assistant', actor: 'ChatGPT', csrf: null };
    }
    const raw = req.get('cookie')?.split(';').map(part => part.trim()).find(part => part.startsWith('nolege_admin='))?.slice('nolege_admin='.length);
    if (!raw || raw.length > 2000) throw new QuizError('Jelentkezz be az adminoldalra.', 401, 'admin_unauthorized');
    const [payload, signature, extra] = raw.split('.');
    if (extra || !payload || !equal(signature, sign(payload))) throw new QuizError('A belépés már nem érvényes.', 401, 'admin_unauthorized');
    let session;
    try { session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { throw new QuizError('Érvénytelen belépés.', 401, 'admin_unauthorized'); }
    if (session.role !== 'owner' || session.exp <= now() || typeof session.csrf !== 'string') throw new QuizError('A belépés lejárt. Jelentkezz be újra.', 401, 'admin_unauthorized');
    if (mutation) {
      sameOrigin(req);
      if (!equal(req.get('x-csrf-token'), session.csrf)) throw new QuizError('Frissítsd az adminoldalt, majd próbáld újra.', 403, 'csrf_invalid');
    }
    return { role: 'owner', actor: 'Attila', csrf: session.csrf };
  }
  return {
    configured,
    authenticate,
    async login(req, res) {
      sameOrigin(req);
      if (!configured) throw new QuizError('Az adminbelépés nincs beállítva. A szükséges Render-változók az üzemeltetési leírásban szerepelnek.', 503, 'admin_not_configured');
      const key = req.ip;
      const previous = attempts.get(key);
      const attempt = !previous || now() - previous.at >= 15 * 60_000 ? { at: now(), count: 0 } : previous;
      if (attempt.count >= 8) throw new QuizError('Túl sok belépési próbálkozás. Várj 15 percet.', 429, 'login_rate_limit');
      attempt.count++; attempts.set(key, attempt);
      if (attempts.size > 5000) for (const [ip, entry] of attempts) if (now() - entry.at >= 15 * 60_000) attempts.delete(ip);
      const password = typeof req.body?.password === 'string' ? req.body.password : '';
      const username = typeof req.body?.username === 'string' ? req.body.username.toLowerCase().trim() : '';
      const valid = password.length > 0 && password.length <= 200 && await passwordMatches(password, ownerHash);
      if (!valid || username !== owner.toLowerCase()) throw new QuizError('Hibás felhasználónév vagy jelszó.', 401, 'login_failed');
      attempts.delete(key);
      const session = { role: 'owner', exp: now() + 12 * 60 * 60_000, csrf: randomBytes(24).toString('base64url') };
      const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
      res.setHeader('set-cookie', cookie(req, `${payload}.${sign(payload)}`, 12 * 60 * 60));
      return { authenticated: true, role: 'owner', actor: 'Attila', csrf: session.csrf };
    },
    logout(req, res) { res.setHeader('set-cookie', cookie(req, '', 0)); }
  };
}
