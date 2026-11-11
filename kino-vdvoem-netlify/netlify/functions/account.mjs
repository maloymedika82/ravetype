import { getStore } from '@netlify/blobs';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const config = { path: '/api/account/:action' };
const accounts = () => getStore('watch-accounts');
const rooms = () => getStore('watch-rooms');
const hex = n => randomBytes(n).toString('hex');
const digest = s => createHash('sha256').update(s).digest('hex');
const passwordHash = (password, salt) => scryptSync(password, salt, 64).toString('hex');
const reply = (value, status = 200, cookie) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...(cookie ? { 'set-cookie': cookie } : {}) } });
const sessionCookie = token => `watch_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${30 * 86400}`;
const clearCookie = 'watch_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0';
const cookieToken = request => request.headers.get('cookie')?.match(/(?:^|;\s*)watch_session=([a-f0-9]{64})(?:;|$)/)?.[1] || '';
const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const validName = s => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 24;
const validPassword = s => typeof s === 'string' && s.length >= 8 && s.length <= 128;

export default async function handler(request) {
  const url = new URL(request.url), action = url.pathname.match(/^\/api\/account\/(status|register|login|logout|rotate-invite|rate)\/?$/)?.[1];
  if (request.method !== 'POST' || !action) return reply({ error: 'Не найдено' }, 404);
  if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return reply({ error: 'Неверный источник' }, 403);
  if (!request.headers.get('content-type')?.startsWith('application/json')) return reply({ error: 'Неверный запрос' }, 400);
  let data;
  try { const raw = await request.text(); if (raw.length > 5000) throw Error(); data = JSON.parse(raw); } catch { return reply({ error: 'Неверный запрос' }, 400); }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return reply({ error: 'Неверный запрос' }, 400);
  const token = cookieToken(request), tokenHash = token && digest(token), now = Date.now();
  const store = accounts();
  for (let attempt = 0; attempt < 8; attempt++) {
    const entry = await store.getWithMetadata('pair', { consistency: 'strong', type: 'json' });
    const pair = entry?.data || null;
    const session = pair?.sessions?.find(s => s.hash === tokenHash && s.expires > now);
    const user = pair?.users.find(u => u.id === session?.user_id);
    const publicState = () => ({ hasPair: Boolean(pair), user: user ? { id: user.id, name: user.name } : null, partner: user ? pair.users.filter(u => u.id !== user.id).map(u => ({ id: u.id, name: u.name }))[0] || null : null, library: user ? pair.library || [] : [] });
    if (action === 'status') return reply(publicState());
    if (action === 'register') {
      if (!validName(data.name) || !validPassword(data.password)) return reply({ error: 'Имя до 24 символов, пароль от 8 символов' }, 400);
      if (pair?.users.length >= 2) return reply({ error: 'Оба профиля уже созданы' }, 403);
      if (pair?.users.some(u => u.name.toLowerCase() === data.name.trim().toLowerCase())) return reply({ error: 'Это имя уже занято' }, 409);
      if (!pair) {
        const setup = process.env.PAIR_SETUP_CODE || '';
        if (setup.length < 16 || typeof data.code !== 'string' || !safeEqual(digest(data.code), digest(setup))) return reply({ error: 'Неверный код создания пары' }, 403);
      } else if (!pair.invite_hash || typeof data.code !== 'string' || !safeEqual(digest(data.code), pair.invite_hash)) return reply({ error: 'Неверный код приглашения' }, 403);
      const salt = hex(16), id = hex(16), sessionToken = hex(32), invite = pair ? '' : hex(12);
      const next = pair || { users: [], sessions: [], library: [], invite_hash: digest(invite) };
      next.users.push({ id, name: data.name.trim().replace(/\s+/g, ' '), salt, hash: passwordHash(data.password, salt) });
      if (pair) next.invite_hash = null;
      next.sessions = (next.sessions || []).filter(s => s.expires > now).slice(-20);
      next.sessions.push({ hash: digest(sessionToken), user_id: id, expires: now + 30 * 86400000 });
      const result = await store.setJSON('pair', next, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
      if (result.modified) return reply({ user: { id, name: next.users.at(-1).name }, inviteCode: invite || undefined, library: next.library }, 200, sessionCookie(sessionToken));
      continue;
    }
    if (!pair) return reply({ error: 'Сначала создайте первый профиль' }, 404);
    if (action === 'login') {
      const found = pair.users.find(u => u.name.toLowerCase() === String(data.name || '').trim().toLowerCase());
      const fallback = '0'.repeat(32);
      const actual = passwordHash(String(data.password || '').slice(0, 128), found?.salt || fallback);
      if (!found || !validPassword(data.password) || !safeEqual(actual, found.hash)) return reply({ error: 'Неверное имя или пароль' }, 403);
      const sessionToken = hex(32);
      pair.sessions = (pair.sessions || []).filter(s => s.expires > now).slice(-20);
      pair.sessions.push({ hash: digest(sessionToken), user_id: found.id, expires: now + 30 * 86400000 });
      const result = await store.setJSON('pair', pair, { onlyIfMatch: entry.etag });
      if (result.modified) return reply({ user: { id: found.id, name: found.name }, library: pair.library || [] }, 200, sessionCookie(sessionToken));
      continue;
    }
    if (!user) return reply({ error: 'Войдите в профиль' }, 401);
    if (action === 'logout') {
      pair.sessions = pair.sessions.filter(s => s.hash !== tokenHash);
      const result = await store.setJSON('pair', pair, { onlyIfMatch: entry.etag });
      if (result.modified) return reply({ ok: true }, 200, clearCookie);
      continue;
    }
    if (action === 'rotate-invite') {
      if (pair.users[0].id !== user.id || pair.users.length !== 1) return reply({ error: 'Приглашение недоступно' }, 403);
      const invite = hex(12); pair.invite_hash = digest(invite);
      const result = await store.setJSON('pair', pair, { onlyIfMatch: entry.etag });
      if (result.modified) return reply({ inviteCode: invite });
      continue;
    }
    if (action === 'rate') {
      if (!/^[a-f0-9]{32}$/.test(data.roomId || '') || !/^[a-f0-9]{32}$/.test(data.clientId || '') || !Number.isInteger(data.rating) || data.rating < 1 || data.rating > 5) return reply({ error: 'Неверная оценка' }, 400);
      const room = await rooms().get(data.roomId, { consistency: 'strong', type: 'json' });
      if (!room?.room?.media_url) return reply({ error: 'Фильм не найден' }, 404);
      const ownRating = room.ratings?.find(r => r.client_id === data.clientId && r.rating === data.rating);
      if (!ownRating) return reply({ error: 'Сначала оцените фильм в комнате' }, 403);
      const mediaUrl = room.room.media_url, library = pair.library || [];
      let item = library.find(x => x.room_id === data.roomId && x.media_url === mediaUrl);
      if (!item) { item = { room_id: data.roomId, media_url: mediaUrl, watched_at: now, ratings: {} }; library.unshift(item); }
      item.ratings[user.id] = data.rating;
      pair.library = library.slice(0, 60);
      const result = await store.setJSON('pair', pair, { onlyIfMatch: entry.etag });
      if (result.modified) return reply({ library: pair.library });
    }
  }
  return reply({ error: 'Попробуйте ещё раз' }, 409);
}
