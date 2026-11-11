import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore } from './file-store.mjs';

test('file store keeps room state and rejects stale writes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ravetype-store-'));
  process.env.RAVETYPE_DATA_DIR = dir;
  try {
    const store = fileStore('watch-rooms');
    const key = 'a'.repeat(32);
    assert.equal(await store.get(key), null);
    assert.equal((await store.setJSON(key, { count: 1 }, { onlyIfNew: true })).modified, true);
    const first = await store.getWithMetadata(key);
    assert.deepEqual(first.data, { count: 1 });
    assert.equal((await store.setJSON(key, { count: 2 }, { onlyIfNew: true })).modified, false);
    assert.equal((await store.setJSON(key, { count: 2 }, { onlyIfMatch: 'stale' })).modified, false);
    assert.equal((await store.setJSON(key, { count: 2 }, { onlyIfMatch: first.etag })).modified, true);
    assert.deepEqual(await store.get(key), { count: 2 });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
