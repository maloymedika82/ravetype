import { handleRoomRequest } from '../kino-vdvoem-netlify/netlify/functions/room-core.mjs';

export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    const match = path.match(/^\/api\/room\/([a-f0-9]{32})\/(?:poll|media|playback|message|voice|manage)\/?$/);
    if (match) {
      const id = env.ROOMS.idFromName(match[1]);
      return env.ROOMS.get(id).fetch(request);
    }
    if (path.startsWith('/api/')) return new Response('Not found', { status: 404 });
    return env.ASSETS.fetch(request);
  },
};

export class RoomObject {
  constructor(state) {
    this.storage = state.storage;
    this.pending = Promise.resolve();
  }

  fetch(request) {
    // shortcut: one room is serialized in one Durable Object; upgrade only if a room needs high request throughput.
    const run = async () => handleRoomRequest(request, {
      getWithMetadata: async () => {
        const data = await this.storage.get('room');
        return data ? { data, etag: 'serialized' } : null;
      },
      setJSON: async (_id, data) => {
        await this.storage.put('room', data);
        return { modified: true };
      },
    });
    const result = this.pending.then(run, run);
    this.pending = result.then(() => {}, () => {});
    return result;
  }
}
