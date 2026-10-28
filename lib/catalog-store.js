import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { QuizError } from './questions.js';

const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);

export function memoryCatalogStore(initial) {
  let value = copy(initial);
  return { kind: 'memory', writable: true, async read() { return copy(value); },
    async write(next) { value = copy(next); }, async history() { return []; } };
}

export function fileCatalogStore(filename, fallback) {
  let revision;
  return {
    kind: 'file', writable: true,
    async read() {
      try { const text = await fs.readFile(filename, 'utf8'); revision = digest(text); return JSON.parse(text); }
      catch (error) { if (error.code === 'ENOENT') { revision = null; return copy(fallback); } throw error; }
    },
    async write(value) {
      let current = null;
      try { current = digest(await fs.readFile(filename, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current !== revision) throw new QuizError('A bank időközben megváltozott. Frissítsd az adatokat, majd próbáld újra.', 409, 'revision_conflict');
      const text = `${JSON.stringify(value, null, 2)}\n`;
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(`${filename}.tmp`, text, { mode: 0o600 });
      await fs.rename(`${filename}.tmp`, filename);
      revision = digest(text);
    },
    async history() { return []; }
  };
}

// This credential belongs to the running app, independently of the ChatGPT connector.
// Only this fixed data path is writable; request bodies cannot choose repository paths.
export function githubCatalogStore({ token, repo = 'Attila314dev/Nolege', branch = 'main',
  filename = 'bank/catalog.json', fallback, fetchImpl = fetch } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !/^[\w./-]+$/.test(branch)) throw new Error('Invalid bank repository');
  const root = `https://api.github.com/repos/${repo}`;
  const endpoint = `${root}/contents/${filename}`;
  let sha = null, error = null, remote = false, previouslyLoaded = false;
  const writable = !!token?.trim();
  async function request(url, options = {}, asText = false) {
    let response;
    try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(15_000), headers: {
      accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'Nolege-question-bank/3.0',
      ...(token ? { authorization: `Bearer ${token.trim()}` } : {}), ...options.headers } }); }
    catch { throw new QuizError('A GitHub-mentés most nem érhető el. A változás nincs elmentve.', 503, 'storage_unavailable'); }
    if (!response.ok) {
      if ([409, 422].includes(response.status)) throw new QuizError('A bankot közben más is módosította. Frissíts, és ellenőrizd a változásaidat.', 409, 'revision_conflict');
      if ([401, 403].includes(response.status)) throw new QuizError('A GitHub-hozzáférést vagy annak írási jogosultságát ellenőrizni kell.', 503, 'storage_auth');
      throw new QuizError('A GitHub-kérdésbank most nem érhető el. Próbáld később.', 503, 'storage_unavailable');
    }
    return asText ? response.text() : response.json();
  }
  async function readFile(ref) {
    // Public browsing needs no REST quota or credential. Authenticated writes
    // still use the Contents API and its current SHA for conflict protection.
    if (!writable) {
      const text = await request(`https://raw.githubusercontent.com/${repo}/${ref}/${filename}`, {}, true);
      const value = JSON.parse(text);
      const sha = createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
      return { value, sha };
    }
    const data = await request(`${endpoint}?ref=${encodeURIComponent(ref)}`, { headers: { accept: 'application/vnd.github.object+json' } });
    if (typeof data.sha !== 'string') throw new Error('Invalid catalog response');
    if (data.encoding === 'base64' && data.content) return { value: JSON.parse(Buffer.from(data.content, 'base64').toString('utf8')), sha: data.sha };
    // Above 1 MB the Contents API omits inline data. Read this exact blob,
    // rather than a branch that might change between the two requests.
    if (data.encoding === 'none') {
      const blob = await request(`${root}/git/blobs/${data.sha}`);
      if (blob.encoding === 'base64' && blob.content) return { value: JSON.parse(Buffer.from(blob.content, 'base64').toString('utf8')), sha: data.sha };
    }
    throw new Error('Invalid catalog response');
  }
  return {
    kind: 'github', writable,
    status() { return { remote, error, repo, branch }; },
    async read() {
      try {
        const loaded = await readFile(branch);
        const value = loaded.value;
        sha = loaded.sha; remote = true; previouslyLoaded = true; error = null;
        return value;
      } catch (failure) {
        error = 'A GitHub-bank olvasása nem sikerült; a telepített példány látható.';
        // Never write over a remote state we could not successfully read.
        remote = false; sha = null;
        if (!fallback || previouslyLoaded) throw failure;
        return copy(fallback);
      }
    },
    async write(value, message = 'Update Nolege question bank') {
      if (!writable) throw new QuizError('A tartós mentéshez állítsd be Renderben a GITHUB_BANK_TOKEN változót, csak ehhez a repóhoz adott Contents: Read and write jogosultsággal.', 503, 'storage_not_configured');
      if (!remote || !sha) throw new QuizError('Előbb töltsd újra sikeresen a GitHub-bankot. A változás nincs elmentve.', 503, 'storage_unavailable');
      const data = await request(endpoint, { method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, branch, sha, content: Buffer.from(`${JSON.stringify(value, null, 2)}\n`).toString('base64') }) });
      if (!data.content?.sha) throw new QuizError('A GitHub nem igazolta a mentést. Frissítsd a bankot.', 503, 'storage_unavailable');
      sha = data.content.sha; error = null;
    },
    async history() {
      const commits = await request(`${root}/commits?path=${encodeURIComponent(filename)}&sha=${encodeURIComponent(branch)}&per_page=20`);
      return commits.map(item => ({ sha: item.sha, date: item.commit.author.date, message: item.commit.message, url: item.html_url }));
    },
    async atVersion(commit) {
      if (!/^[a-f0-9]{40}$/.test(commit)) throw new QuizError('Érvénytelen mentési azonosító.');
      return (await readFile(commit)).value;
    }
  };
}
