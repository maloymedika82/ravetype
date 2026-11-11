import { getStore } from './store.mjs';
import { handleRoomRequest } from './room-core.mjs';

export const config = { path: '/api/room/:id/:action' };

export default async function handler(request) {
  return handleRoomRequest(request, getStore('watch-rooms'));
}
