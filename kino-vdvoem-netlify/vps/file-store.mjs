import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const locks = new Map();
const valid = /^[a-z0-9-]{1,40}$/;
const keyPattern = /^(?:pair|[a-f0-9]{32})$/;

async function read(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function withLock(path, fn) {
  const previous = locks.get(path) || Promise.resolve();
  const result = previous.catch(() => {}).then(fn);
  locks.set(path, result);
  result.finally(() => { if (locks.get(path) === result) locks.delete(path); }).catch(() => {});
  return result;
}

export function fileStore(name) {
  if (!valid.test(name)) throw Error('Invalid store name');
  const directory = join(process.env.RAVETYPE_DATA_DIR, name);
  const pathFor = key => {
    if (!keyPattern.test(key)) throw Error('Invalid store key');
    return join(directory, key + '.json');
  };
  return {
    async getWithMetadata(key) {
      const entry = await read(pathFor(key));
      return entry ? { data: entry.data, etag: entry.etag } : null;
    },
    async get(key) {
      const entry = await read(pathFor(key));
      return entry?.data ?? null;
    },
    async setJSON(key, data, condition = {}) {
      const path = pathFor(key);
      return withLock(path, async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        const current = await read(path);
        if (condition.onlyIfNew && current) return { modified: false };
        if (condition.onlyIfMatch && current?.etag !== condition.onlyIfMatch) return { modified: false };
        if (condition.onlyIfMatch && !current) return { modified: false };
        const temp = path + '.' + randomUUID() + '.tmp';
        await writeFile(temp, JSON.stringify({ etag: randomUUID(), data }), { mode: 0o600 });
        await rename(temp, path);
        return { modified: true };
      });
    }
  };
}
