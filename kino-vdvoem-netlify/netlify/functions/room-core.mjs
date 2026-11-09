const roomPattern = /^[a-f0-9]{32}$/;
const actions = new Set(['poll', 'media', 'playback', 'message']);

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

async function readBody(request) {
  if (!request.headers.get('content-type')?.startsWith('application/json')) throw new SyntaxError();
  if (Number(request.headers.get('content-length') || 0) > 3000) throw new SyntaxError();
  const raw = await request.text();
  if (raw.length > 3000) throw new SyntaxError();
  return JSON.parse(raw);
}

function snapshot(state, now) {
  return {
    room: state.room,
    participants: state.participants.filter(p => p.last_seen > now - 30000).map(({ client_id, name }) => ({ client_id, name })),
    messages: state.messages,
  };
}

function newState(id, now) {
  return {
    room: { id, media_url: '', playing: 0, position: 0, updated_at: now, revision: 0 },
    participants: [],
    messages: [],
  };
}

export async function handleRoomRequest(request, store, now = Date.now()) {
  const url = new URL(request.url);
  const route = url.pathname.match(/^\/api\/room\/([a-f0-9]{32})\/(poll|media|playback|message)\/?$/);
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
    } else if (action === 'message') {
      body = typeof data.body === 'string' ? data.body.trim() : '';
      if (!body || body.length > 1000) return json({ error: 'Сообщение должно быть не длиннее 1000 символов' }, 400);
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await store.getWithMetadata(id, { consistency: 'strong', type: 'json' });
      const state = entry?.data || newState(id, now);
      const participants = state.participants.filter(p => p.last_seen > now - 30000);
      const member = participants.find(p => p.client_id === clientId);
      if (!member && participants.length >= 2) return json({ error: 'В комнате уже два зрителя' }, 403);

      // Presence is refreshed every 10 seconds to keep polling inexpensive.
      const needsWrite = action !== 'poll' || !member || member.name !== name || now - member.last_seen >= 10000 || participants.length !== state.participants.length;
      if (!needsWrite) return json(snapshot(state, now));
      state.participants = participants;
      if (member) { member.name = name; member.last_seen = now; }
      else state.participants.push({ client_id: clientId, name, last_seen: now });

      if (action === 'media') {
        Object.assign(state.room, { media_url: media.href, playing: 0, position: 0, updated_at: now, revision: state.room.revision + 1 });
      } else if (action === 'playback') {
        Object.assign(state.room, { playing: data.playing ? 1 : 0, position, updated_at: now, revision: state.room.revision + 1 });
      } else if (action === 'message') {
        state.messages.push({ id: crypto.randomUUID(), client_id: clientId, name, body, created_at: now });
        state.messages = state.messages.slice(-80);
      }

      // Conditional writes prevent one viewer from overwriting the other's message or playback change.
      const result = await store.setJSON(id, state, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
      if (result.modified) return json(snapshot(state, now));
    }
    return json({ error: 'Комната занята. Повторите действие.' }, 409);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: 'Проверьте данные запроса' }, 400);
    console.error(error);
    return json({ error: 'Ошибка сервера. Попробуйте ещё раз.' }, 500);
  }
}
