import { getStore } from '@netlify/blobs';
import { handleRoomRequest } from './room-core.mjs';

export const config = { path: '/api/room/:id/:action' };

export default async function handler(request) {
  return handleRoomRequest(request, getStore('watch-rooms'));
}
