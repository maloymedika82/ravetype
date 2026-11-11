import { randomUUID } from 'node:crypto';
const roomPattern = /^[a-f0-9]{32}$/;
const actions = new Set(['poll', 'media', 'playback', 'message', 'voice', 'manage', 'ice', 'progress', 'wait', 'rate']);

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new SyntaxError();
  if (Number(request.headers.get('content-length') || 0) > 60000) throw new SyntaxError();
  const raw = await request.text();
  if (raw.length > 60000) throw new SyntaxError();
  return JSON.parse(raw);
}

function snapshot(state, now, ownerToken = '') {
  return {
    room: { ...state.room, owner_id: state.owner_id, is_owner: Boolean(ownerToken), ...(ownerToken ? { owner_token: ownerToken } : {}) },
    participants: state.participants.filter(p => p.last_seen > now - 30000).map(({ client_id, name, custom_name }) => ({ client_id, name: custom_name || name })),
    messages: state.messages,
    voice: state.voice || { members: [], offer: null, answer: null },
    progress: (state.progress || []).filter(p => p.at > now - 18000 && p.media_url === state.room.media_url),
    ratings: state.ratings || [],
    history: state.history || [],
  };
}

function newState(id, now) {
  return {
    room: { id, media_url: '', playing: 0, position: 0, updated_at: now, revision: 0 },
    participants: [],
    messages: [],
    owner_id: null,
    owner_token: null,
    kicked: {},
    voice: { members: [], offer: null, answer: null },
    progress: [], ratings: [], history: [],
  };
}

export async function handleRoomRequest(request, store, now = Date.now()) {
  const url = new URL(request.url);
  const route = url.pathname.match(/^\/api\/room\/([a-f0-9]{32})\/(poll|media|playback|message|voice|manage|ice|progress|wait|rate)\/?$/);
  if (request.method !== 'POST' || !route || !roomPattern.test(route[1]) || !actions.has(route[2])) return json({ error: 'Не найдено' }, 404);
  if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return json({ error: 'Неверный источник запроса' }, 403);

  try {
    const data = await readBody(request);
    const [ , id, action ] = route;
    const clientId = data.clientId;
    const name = typeof data.name === 'string' ? data.name.trim().replace(/\s+/g, ' ') : '';
    if (!roomPattern.test(clientId || '') || !name || name.length > 24) return json({ error: 'Укажите имя и обновите страницу' }, 400);

    let media;
    let position;
    let body;
    if (action === 'media') {
      media = typeof data.url === 'string' ? data.url.trim() : '';
      if (media.length > 1500) return json({ error: 'Ссылка слишком длинная' }, 400);
      try { media = new URL(media); } catch { return json({ error: 'Проверьте ссылку' }, 400); }
      if (!['http:', 'https:'].includes(media.protocol)) return json({ error: 'Поддерживаются только http и https' }, 400);
    } else if (action === 'playback') {
      position = Number(data.position);
      if (typeof data.playing !== 'boolean' || !Number.isFinite(position) || position < 0 || position > 86400) return json({ error: 'Неверная позиция видео' }, 400);
    } else if (action === 'progress') {
      position = Number(data.position);
      if (!Number.isFinite(position) || position < 0 || position > 86400 || typeof data.mediaUrl !== 'string' || data.mediaUrl.length > 1500) return json({ error: 'Неверная позиция' }, 400);
    } else if (action === 'wait') {
      if (typeof data.waiting !== 'boolean') return json({ error: 'Неверный статус' }, 400);
    } else if (action === 'rate') {
      if (!Number.isInteger(data.rating) || data.rating < 1 || data.rating > 5) return json({ error: 'Оцените от 1 до 5' }, 400);
    } else if (action === 'message') {
      body = typeof data.body === 'string' ? data.body.trim() : '';
      if (!body || body.length > 1000) return json({ error: 'Сообщение должно быть не длиннее 1000 символов' }, 400);
    } else if (action === 'manage') {
      if (!['rename', 'kick'].includes(data.type) || !roomPattern.test(data.target || '') ||
          (data.type === 'rename' && (typeof data.newName !== 'string' || !data.newName.trim() || data.newName.trim().length > 24))) return json({ error: 'Неверные настройки участника' }, 400);
    } else if (action === 'ice') {
      if (!roomPattern.test(data.session || '')) return json({ error: 'Неверный сеанс звонка' }, 400);
    } else if (action === 'voice') {
      if (!['join', 'leave', 'offer', 'answer'].includes(data.type) ||
          (data.type !== 'leave' && !roomPattern.test(data.session || '')) ||
          (['offer', 'answer'].includes(data.type) && (typeof data.sdp !== 'string' || data.sdp.length > 50000 || !data.sdp.length))) {
        return json({ error: 'Неверные данные голосового чата' }, 400);
      }
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await store.getWithMetadata(id, { consistency: 'strong', type: 'json' });
      const state = entry?.data || newState(id, now);
      const ownerAssigned = !state.owner_id;
      if (ownerAssigned) state.owner_id = clientId;
      const tokenAssigned = (ownerAssigned || (!state.owner_token && state.owner_id === clientId));
      if (tokenAssigned) state.owner_token = randomUUID().replace(/-/g, '');
      const ownerToken = state.owner_id === clientId && state.owner_token === data.ownerToken || tokenAssigned && state.owner_id === clientId ? state.owner_token : '';
      if (state.kicked?.[clientId] > now) return json({ error: 'Владелец удалил вас из комнаты' }, 403);
      const participants = state.participants.filter(p => p.last_seen > now - 30000);
      const member = participants.find(p => p.client_id === clientId);
      if (!member && participants.length >= 2) return json({ error: 'В комнате уже два зрителя' }, 403);
      if (['media', 'manage'].includes(action) && !ownerToken) return json({ error: 'Источник может менять только владелец комнаты' }, 403);
      if (action === 'ice') {
        const joined = state.voice?.members.some(v => v.client_id === clientId && v.session === data.session && v.last_seen > now - 30000);
        if (!joined) return json({ error: 'Сначала войдите в голосовой чат' }, 403);
        const meteredApp = process.env.METERED_TURN_APP;
        const meteredKey = process.env.METERED_TURN_API_KEY;
        if (meteredApp && meteredKey) {
          if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(meteredApp)) return json({ error: 'Неверное имя Metered приложения' }, 503);
          const response = await fetch('https://' + meteredApp + '.metered.live/api/v1/turn/credentials?apiKey=' + encodeURIComponent(meteredKey));
          if (!response.ok) return json({ error: 'Не удалось получить данные Metered TURN' }, 502);
          const iceServers = await response.json();
          if (!Array.isArray(iceServers) || !iceServers.some(server => server.username && server.credential)) return json({ error: 'Неверный ответ Metered TURN' }, 502);
          return json({ iceServers });
        }
        const keyId = process.env.CLOUDFLARE_TURN_KEY_ID;
        const keyToken = process.env.CLOUDFLARE_TURN_API_TOKEN;
        if (!keyId || !keyToken) return json({ error: 'TURN ещё не настроен на сервере' }, 503);
        const response = await fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(keyId) + '/credentials/generate-ice-servers', {
          method: 'POST',
          headers: { authorization: 'Bearer ' + keyToken, 'content-type': 'application/json' },
          body: JSON.stringify({ ttl: 3600 }),
        });
        if (!response.ok) return json({ error: 'Не удалось получить данные TURN' }, 502);
        const turn = await response.json();
        if (!Array.isArray(turn.iceServers) || !turn.iceServers.some(server => server.username && server.credential)) return json({ error: 'Неверный ответ TURN' }, 502);
        return json({ iceServers: turn.iceServers });
      }

      // Presence is refreshed every 10 seconds to keep polling inexpensive.
      const voiceHeartbeat = state.voice?.members.some(v => v.session === data.session && now - v.last_seen >= 10000);
      const needsWrite = ownerAssigned || tokenAssigned || action !== 'poll' || !member || member.name !== name || now - member.last_seen >= 10000 || participants.length !== state.participants.length || voiceHeartbeat;
      if (!needsWrite) return json(snapshot(state, now, ownerToken));
      state.participants = participants;
      state.voice ||= { members: [], offer: null, answer: null };
      const priorVoiceCount = state.voice.members.length;
      state.voice.members = state.voice.members.filter(v => v.last_seen > now - 30000 && participants.some(p => p.client_id === v.client_id));
      const voiceMember = state.voice.members.find(v => v.session === data.session && v.client_id === clientId);
      if (voiceMember) voiceMember.last_seen = now;
      if (state.voice.members.length !== priorVoiceCount) state.voice.offer = state.voice.answer = null;
      if (member) { member.name = name; member.last_seen = now; }
      else state.participants.push({ client_id: clientId, name, last_seen: now });

      if (action === 'media') {
        if (state.room.media_url && state.room.media_url !== media.href) {
          state.history ||= [];
          state.history.unshift({ media_url: state.room.media_url, watched_at: now, ratings: state.ratings || [] });
          state.history = state.history.slice(0, 30);
          state.ratings = [];
          state.progress = [];
        }
        state.room.waiting_for = null;
        Object.assign(state.room, { media_url: media.href, playing: 0, position: 0, updated_at: now, revision: state.room.revision + 1 });
      } else if (action === 'playback') {
        Object.assign(state.room, { playing: data.playing ? 1 : 0, position, updated_at: now, revision: state.room.revision + 1 });
      } else if (action === 'progress') {
        if (data.mediaUrl !== state.room.media_url) return json(snapshot(state, now, ownerToken));
        state.progress ||= [];
        state.progress = state.progress.filter(p => p.client_id !== clientId && p.at > now - 18000);
        state.progress.push({ client_id: clientId, position, playing: Boolean(data.playing), at: now, media_url: data.mediaUrl });
      } else if (action === 'wait') {
        state.room.waiting_for = data.waiting ? clientId : null;
        Object.assign(state.room, { playing: data.waiting ? 0 : Number(Boolean(data.resume)), position: Number(data.position) >= 0 && Number(data.position) <= 86400 ? Number(data.position) : state.room.position, updated_at: now, revision: state.room.revision + 1 });
      } else if (action === 'rate') {
        if (!state.room.media_url) return json({ error: 'Сначала выберите фильм' }, 400);
        state.ratings ||= [];
        state.ratings = state.ratings.filter(r => r.client_id !== clientId);
        state.ratings.push({ client_id: clientId, name: member?.custom_name || name, rating: data.rating, at: now });
      } else if (action === 'message') {
        state.messages.push({ id: randomUUID(), client_id: clientId, name: member?.custom_name || name, body, created_at: now });
        state.messages = state.messages.slice(-80);
      } else if (action === 'manage') {
        if (data.target === state.owner_id) return json({ error: 'Нельзя изменить владельца' }, 400);
        const target = state.participants.find(p => p.client_id === data.target);
        if (!target) return json({ error: 'Участник не найден' }, 404);
        if (data.type === 'rename') target.custom_name = data.newName.trim().replace(/\s+/g, ' ');
        else {
          state.participants = state.participants.filter(p => p.client_id !== data.target);
          state.voice.members = state.voice.members.filter(v => v.client_id !== data.target);
          state.voice.offer = state.voice.answer = null;
          state.kicked ||= {}; state.kicked[data.target] = now + 3600000;
        }
      } else if (action === 'voice') {
        const voice = state.voice;
        const current = voice.members.find(v => v.session === data.session && v.client_id === clientId);
        if (data.type === 'join') {
          if (!current) {
            if (voice.members.length >= 2) return json({ error: 'В звонке уже два человека' }, 403);
            voice.members.push({ client_id: clientId, session: data.session, last_seen: now });
            voice.offer = voice.answer = null;
          }
        } else if (data.type === 'leave') {
          voice.members = voice.members.filter(v => v.session !== data.session || v.client_id !== clientId);
          voice.offer = voice.answer = null;
        } else {
          if (!current || current.session !== data.session || voice.members.length !== 2) return json({ error: 'Сначала войдите в голосовой чат вдвоём' }, 400);
          const ordered = [...voice.members].sort((a, b) => a.session.localeCompare(b.session));
          if ((data.type === 'offer' && ordered[0].session !== data.session) ||
              (data.type === 'answer' && (ordered[1].session !== data.session || !voice.offer))) return json({ error: 'Неверное состояние звонка' }, 400);
          voice[data.type] = { client_id: clientId, session: data.session, peer_session: ordered[data.type === 'offer' ? 1 : 0].session, sdp: data.sdp };
        }
      }

      // Conditional writes prevent one viewer from overwriting the other's message or playback change.
      const result = await store.setJSON(id, state, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
      if (result.modified) return json(snapshot(state, now, ownerToken));
    }
    return json({ error: 'Комната занята. Повторите действие.' }, 409);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: 'Проверьте данные запроса' }, 400);
    console.error(error);
    return json({ error: 'Ошибка сервера. Попробуйте ещё раз.' }, 500);
  }
}

