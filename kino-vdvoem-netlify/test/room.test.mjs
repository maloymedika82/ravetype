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
  assert.equal((await call(store, user2, 'media', { url: 'https://example.com/wrong.mp4' })).status, 403);
  assert.equal((await call(store, user3)).status, 403);
  await call(store, user1, 'message', { body: 'Привет!' });
  await call(store, user1, 'media', { url: 'https://example.com/video.mp4' });
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


test('TURN credentials require a joined voice session and never expose server key', async () => {
  const store = fakeStore();
  const session = '4'.repeat(32);
  const previousFetch = globalThis.fetch;
  const previousId = process.env.CLOUDFLARE_TURN_KEY_ID;
  const previousToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
  try {
    process.env.CLOUDFLARE_TURN_KEY_ID = 'test-key';
    process.env.CLOUDFLARE_TURN_API_TOKEN = 'server-secret';
    let issued = 0;
    globalThis.fetch = async (url, options) => {
      issued++;
      assert.match(url, /\/credentials\/generate-ice-servers$/);
      assert.equal(options.headers.authorization, 'Bearer server-secret');
      assert.equal(JSON.parse(options.body).ttl, 3600);
      return new Response(JSON.stringify({ iceServers: [{ urls: 'turns:turn.cloudflare.com:443?transport=tcp', username: 'short', credential: 'short-secret' }] }), { status: 201 });
    };
    assert.equal((await call(store, user1, 'ice', { session })).status, 403);
    assert.equal(issued, 0);
    assert.equal((await call(store, user1, 'voice', { type: 'join', session })).status, 200);
    const result = await call(store, user1, 'ice', { session });
    assert.equal(result.status, 200);
    assert.equal(result.data.iceServers[0].username, 'short');
    assert.equal(JSON.stringify(result.data).includes('server-secret'), false);
    assert.equal(issued, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousId === undefined) delete process.env.CLOUDFLARE_TURN_KEY_ID;
    else process.env.CLOUDFLARE_TURN_KEY_ID = previousId;
    if (previousToken === undefined) delete process.env.CLOUDFLARE_TURN_API_TOKEN;
    else process.env.CLOUDFLARE_TURN_API_TOKEN = previousToken;
  }
});
