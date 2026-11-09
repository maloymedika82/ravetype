import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRoomRequest } from '../netlify/functions/room-core.mjs';

const room = 'a'.repeat(32);
const user1 = '1'.repeat(32);
const user2 = '2'.repeat(32);
const user3 = '3'.repeat(32);

function fakeStore() {
  const data = new Map();
  return {
    async getWithMetadata(key) {
      const entry = data.get(key);
      return entry ? { data: structuredClone(entry.value), etag: entry.etag } : null;
    },
    async setJSON(key, value, condition) {
      const old = data.get(key);
      if (condition.onlyIfNew && old || condition.onlyIfMatch && old?.etag !== condition.onlyIfMatch) return { modified: false };
      data.set(key, { value: structuredClone(value), etag: String(Number(old?.etag || 0) + 1) });
      return { modified: true };
    },
  };
}

async function call(store, clientId, action = 'poll', extra = {}, now = 100000) {
  const request = new Request(`https://kino.netlify.app/api/room/${room}/${action}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://kino.netlify.app' },
    body: JSON.stringify({ clientId, name: clientId === user1 ? 'Аня' : 'Борис', ...extra }),
  });
  const response = await handleRoomRequest(request, store, now);
  return { status: response.status, data: await response.json() };
}

test('two viewers share chat, media and playback; third viewer cannot join', async () => {
  const store = fakeStore();
  assert.equal((await call(store, user1)).status, 200);
  assert.equal((await call(store, user2)).data.participants.length, 2);
  assert.equal((await call(store, user3)).status, 403);
  await call(store, user1, 'message', { body: 'Привет!' });
  await call(store, user2, 'media', { url: 'https://example.com/video.mp4' });
  await call(store, user1, 'playback', { playing: true, position: 42 });
  const current = await call(store, user2);
  assert.equal(current.data.messages[0].body, 'Привет!');
  assert.equal(current.data.room.media_url, 'https://example.com/video.mp4');
  assert.equal(current.data.room.position, 42);
  assert.equal(current.data.room.playing, 1);
  assert.equal((await call(store, user3, 'poll', {}, 131000)).status, 200);
});

test('invalid input is rejected without changing the room', async () => {
  const store = fakeStore();
  assert.equal((await call(store, user1, 'media', { url: 'javascript:alert(1)' })).status, 400);
  assert.equal((await call(store, user1, 'message', { body: '   ' })).status, 400);
  assert.equal((await call(store, user1, 'playback', { playing: true, position: -1 })).status, 400);
  assert.equal((await call(store, user1)).data.room.media_url, '');
});
