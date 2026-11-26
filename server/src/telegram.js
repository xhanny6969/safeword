// Telegram Bot API for SafeWord: alerts and check-ins go to the wearer's
// circle (a Telegram group), the circle answers with buttons or replies, and
// the wearer's live location arrives as an ordinary location message.

export function createTelegram({ token, fetchImpl = globalThis.fetch }) {
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is missing')
  const base = `https://api.telegram.org/bot${token}`

  async function call(method, params = {}, timeoutMs = 15_000) {
    const res = await fetchImpl(`${base}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const json = await res.json().catch(() => ({}))
    if (!json.ok) throw new Error(`telegram ${method}: ${json.description ?? `HTTP ${res.status}`}`)
    return json.result
  }

  return {
    getMe: () => call('getMe'),
    getUpdates: (offset, timeout = 25) =>
      call('getUpdates', { offset, timeout, allowed_updates: ['message', 'edited_message', 'callback_query'] }, (timeout + 10) * 1000),
    sendMessage: (chatId, text, extra = {}) =>
      call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true, ...extra }),
    editMessageText: (chatId, messageId, text, extra = {}) =>
      call('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true, ...extra }),
    sendLocation: (chatId, latitude, longitude, extra = {}) =>
      call('sendLocation', { chat_id: chatId, latitude, longitude, ...extra }),
    answerCallbackQuery: (id, text) => call('answerCallbackQuery', { callback_query_id: id, text }),
    deleteMessage: (chatId, messageId) => call('deleteMessage', { chat_id: chatId, message_id: messageId }),
  }
}

/** Inline keyboard: rows of [label, data]. */
export function buttons(rows) {
  return { inline_keyboard: rows.map((row) => row.map(([text, data]) => ({ text, callback_data: data }))) }
}

function personName(u) {
  if (!u) return 'Someone'
  return [u.first_name, u.last_name].filter(Boolean).join(' ') || (u.username ? `@${u.username}` : 'Someone')
}

/**
 * Normalises one update. Returns one of:
 *   { type: 'command', cmd, arg, chatId, chatType, chatTitle, fromId, fromName, msgId }
 *   { type: 'text', text, chatId, chatType, fromId, fromName, msgId, replyTo }
 *   { type: 'location', lat, lon, live, chatId, chatType, fromId, at }
 *   { type: 'callback', id, data, chatId, msgId, fromId, fromName }
 */
export function eventFromUpdate(u) {
  if (u.callback_query) {
    const q = u.callback_query
    return {
      type: 'callback',
      id: q.id,
      data: q.data ?? '',
      chatId: q.message?.chat?.id ?? null,
      msgId: q.message?.message_id ?? null,
      fromId: q.from?.id ?? null,
      fromName: personName(q.from),
    }
  }
  const m = u.message ?? u.edited_message
  if (!m) return null
  const base = {
    chatId: m.chat?.id,
    chatType: m.chat?.type,
    chatTitle: m.chat?.title ?? null,
    fromId: m.from?.id ?? null,
    fromName: personName(m.from),
    msgId: m.message_id,
  }
  if (m.location) {
    return {
      ...base,
      type: 'location',
      lat: m.location.latitude,
      lon: m.location.longitude,
      live: Boolean(m.location.live_period),
      at: (m.edit_date ?? m.date) * 1000,
    }
  }
  const text = m.text ?? ''
  if (!text || u.edited_message) return null
  const cmd = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (cmd) return { ...base, type: 'command', cmd: `/${cmd[1].toLowerCase()}`, arg: (cmd[2] ?? '').trim() }
  return { ...base, type: 'text', text, replyTo: m.reply_to_message?.message_id ?? null }
}

/**
 * Long-polls Telegram forever and routes each event.
 * @param {object} o
 * @param {ReturnType<typeof createTelegram>} o.tg
 * @param {{ get offset(): number, set offset(v: number) }} o.cursor
 * @param {(ev: object) => Promise<void>} o.onEvent
 */
export async function pollForever({ tg, cursor, onEvent, onError = console.error, signal }) {
  while (!signal?.aborted) {
    try {
      const updates = await tg.getUpdates(cursor.offset)
      for (const u of updates) {
        cursor.offset = u.update_id + 1
        const ev = eventFromUpdate(u)
        if (ev) await onEvent(ev).catch(onError)
      }
    } catch (err) {
      onError(err)
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
}
