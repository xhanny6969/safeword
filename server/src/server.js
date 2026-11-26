// SafeWord backend: one process, no database.
//
//   Telegram: the wearer's private chat (setup, check-in fallback) and the
//   circle group (alerts, "I'm on it" buttons, replies, live location)
//        │
//        ▼
//   Engine (check-in timer, alerts) ──> /api/view (long-poll) ──> G2 app
//        ▲                                                          │
//        └──────────────── /api/input, /api/voice <─────────────────┘
//
// The token stays here. The glasses app only ever talks to this server, and
// speech-to-text runs locally, so no audio leaves the machine.

import { createServer } from 'node:http'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Engine } from './engine.js'
import { createTelegram, pollForever } from './telegram.js'
import { transcribe, warmUp } from './stt.js'
import { hhmm } from './views.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
if (existsSync(join(ROOT, '.env'))) process.loadEnvFile(join(ROOT, '.env'))

const PORT = Number(process.env.PORT || 8788)
const HOST = process.env.HOST || '127.0.0.1'
const STATE_FILE = process.env.STATE_FILE || join(ROOT, 'data', 'state.json')
const DEV = process.argv.includes('--dev') || process.env.DEV_ENDPOINTS === '1'
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a)

// Declared before anything awaits: engine events can fire during startup.
const waiters = new Set()
function wake() {
  for (const w of waiters) w()
  waiters.clear()
}

// ---- state ------------------------------------------------------------------

async function loadState() {
  try { return JSON.parse(await readFile(STATE_FILE, 'utf8')) } catch { return {} }
}
const saved = await loadState()
const tgState = {
  offset: 0,
  ownerId: null,
  ownerChatId: null,
  circleChatId: null,
  ...saved.telegram,
}

let saveTimer = null
function persist() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(dirname(STATE_FILE), { recursive: true })
      const tmp = STATE_FILE + '.tmp'
      await writeFile(tmp, JSON.stringify({ ...engine.toJSON(), telegram: tgState }, null, 1))
      await rename(tmp, STATE_FILE)
    } catch (err) {
      log('save failed', err.message)
    }
  }, 300)
}

// ---- Telegram ---------------------------------------------------------------

// A bot token looks like 1234567890:AAF... Anything else is never sent anywhere.
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || '').trim()
const TOKEN_OK = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/.test(BOT_TOKEN)
let tg = TOKEN_OK ? createTelegram({ token: BOT_TOKEN }) : null
const botMessages = new Set() // ids of our messages in the circle, so replies to them reach the glasses
let devId = 1000

// Without Telegram (dev/demo) messages go to the log, so the glasses flow still runs.
const out = {
  async circle(text, { buttons, silent } = {}) {
    if (!tg) { log(`[circle] ${text.split('\n')[0]}`); return ++devId }
    if (!tgState.circleChatId) return null
    const m = await tg.sendMessage(tgState.circleChatId, text, { reply_markup: buttons, disable_notification: Boolean(silent) })
    botMessages.add(m.message_id)
    return m.message_id
  },
  async editCircle(msgId, text, { buttons } = {}) {
    if (!tg) { log(`[circle edit ${msgId}] ${text.split('\n').filter(Boolean).at(-1)}`); return }
    try {
      await tg.editMessageText(tgState.circleChatId, msgId, text, { reply_markup: buttons })
    } catch (err) {
      if (!/not modified/.test(err.message)) throw err
    }
  },
  async circleLocation(loc) {
    if (!tg) { log(`[circle] location ${loc.lat},${loc.lon}`); return }
    const m = await tg.sendLocation(tgState.circleChatId, loc.lat, loc.lon)
    botMessages.add(m.message_id)
  },
  async wearer(text, { buttons } = {}) {
    if (!tg) { log(`[wearer] ${text}`); return ++devId }
    if (!tgState.ownerChatId) return null
    const m = await tg.sendMessage(tgState.ownerChatId, text, { reply_markup: buttons })
    return m.message_id
  },
  async editWearer(msgId, text) {
    if (!tg) { log(`[wearer edit ${msgId}] ${text}`); return }
    await tg.editMessageText(tgState.ownerChatId, msgId, text, { reply_markup: { inline_keyboard: [] } }).catch(() => {})
  },
}

const engine = new Engine({ out }, {
  ...saved,
  settings: {
    ...saved.settings,
    ...(process.env.GRACE_SEC ? { graceSec: Number(process.env.GRACE_SEC) } : {}),
    ...(process.env.TZ_NAME ? { tz: process.env.TZ_NAME } : {}),
  },
})
engine.on('persist', persist)
engine.on('warn', (m) => log('warn', m))
engine.on('log', (m) => log(m))
engine.on('view', ({ version, reason }) => { wake(); if (reason !== 'tick') log(`view v${version} (${reason})`) })

setInterval(() => engine.tick().catch((e) => log('tick', e.message)), 1000)
warmUp().then((ok) => log(ok ? 'speech-to-text ready (Whisper, local)' : 'speech-to-text unavailable: run npm run fetch-model'))

const HELP = [
  'SafeWord watches your back through your Even G2 glasses.',
  '',
  '1. Make a Telegram group with the people who should hear if something is wrong, add me, and send /circle there.',
  '2. Pick a safe word: /codeword pineapple (I delete that message right away). Say it in any sentence while holding the touchpad, and your circle is alerted without a sound.',
  '3. Share your live location in the group (📎 → Location → Share My Live Location), so alerts carry a pin.',
  '',
  'On the glasses: tap to start check-ins, tap again whenever you are OK. Swipe for a silent SOS. Hold and speak: "check on me every 20 minutes", "I\'m fine", "tell them I\'m on the train", "I\'m home".',
  '',
  '/every 20  check-in interval in minutes',
  '/test  send a test alert to your circle',
  '/status  what is running',
].join('\n')

const mask = (w) => (w.length <= 2 ? '••' : `${w[0]}${'•'.repeat(w.length - 2)}${w.at(-1)}`)

function status() {
  const s = engine.session
  const a = engine.openAlert
  const tz = engine.settings.tz
  return [
    `Circle: ${engine.circle?.name ?? 'not linked (send /circle in your group)'}`,
    `Safe word: ${engine.settings.codeword ? mask(engine.settings.codeword) : 'not set (/codeword ...)'}`,
    `Check-ins: ${s ? `every ${Math.round(s.intervalMs / 60000)} min, next ${hhmm(s.dueAt, tz)}${s.paused ? ' (paused by an alert)' : ''}` : 'off'}`,
    `Location: ${engine.location ? `${engine.location.live ? 'live' : 'last shared'} at ${hhmm(engine.location.at, tz)}` : 'not shared'}`,
    `Alert: ${a ? `${a.kind} since ${hhmm(a.at, tz)}` : 'none open'}`,
  ].join('\n')
}

async function onEvent(ev) {
  const isOwner = tgState.ownerId != null && ev.fromId === tgState.ownerId
  const reply = (text, extra) => tg.sendMessage(ev.chatId, text, extra)

  if (ev.type === 'callback') {
    if (ev.data === 'checkin') {
      if (!isOwner) return void (await tg.answerCallbackQuery(ev.id, 'Only the wearer can check in.'))
      await engine.checkIn('phone')
      return void (await tg.answerCallbackQuery(ev.id, 'Checked in ✓'))
    }
    const m = /^(on|ok):(\d+)$/.exec(ev.data)
    if (m && ev.chatId === tgState.circleChatId) {
      const r = await engine.respond({ alertId: Number(m[2]), who: ev.fromName, action: m[1] })
      return void (await tg.answerCallbackQuery(ev.id, r.answer))
    }
    return void (await tg.answerCallbackQuery(ev.id, ''))
  }

  if (ev.type === 'location') {
    if (isOwner) engine.setLocation({ lat: ev.lat, lon: ev.lon, at: ev.at, live: ev.live })
    return
  }

  if (ev.chatType === 'private') {
    if (tgState.ownerId != null && !isOwner) return void (await reply('This SafeWord bot belongs to someone else.'))
    if (ev.type !== 'command') return void (await reply('Commands: /status, /codeword, /every, /test, /help'))
    if (ev.cmd === '/start' && tgState.ownerId == null) {
      tgState.ownerId = ev.fromId
      tgState.ownerChatId = ev.chatId
      engine.setName(ev.fromName.split(' ')[0])
      persist()
      log(`owner set: ${ev.fromName}`)
    }
    switch (ev.cmd) {
      case '/start':
      case '/help':
        return void (await reply(HELP))
      case '/status':
        return void (await reply(status()))
      case '/codeword': {
        if (!ev.arg) return void (await reply(`Usage: /codeword pineapple\nNow: ${engine.settings.codeword ? mask(engine.settings.codeword) : 'not set'}`))
        engine.setCodeword(ev.arg.toLowerCase())
        await tg.deleteMessage(ev.chatId, ev.msgId).catch(() => {})
        return void (await reply(`Safe word set: ${mask(engine.settings.codeword)} (your message is deleted). Hold the touchpad and use it in any sentence to alert your circle without a sound.`))
      }
      case '/every': {
        const n = Number(ev.arg)
        if (!(n >= 1 && n <= 240)) return void (await reply('Usage: /every 20 (minutes, 1 to 240)'))
        engine.setInterval(n)
        return void (await reply(`Check-ins every ${n} min.`))
      }
      case '/name':
        if (ev.arg) engine.setName(ev.arg.slice(0, 30))
        return void (await reply(`Your circle sees you as ${engine.settings.name}.`))
      case '/checkin':
        await engine.checkIn('phone')
        return void (await reply('Checked in ✓'))
      case '/test':
        if (!engine.circle) return void (await reply('Link a circle first: send /circle in your group.'))
        await engine.raise('test', { via: 'telegram' })
        return void (await reply('Test alert sent to your circle. Close it from the glasses or let someone tap "Reached them".'))
      default:
        return void (await reply(HELP))
    }
  }

  // Groups: only the circle matters.
  if (ev.type === 'command') {
    if (ev.cmd === '/circle') {
      if (!isOwner) return void (await reply('Only the wearer can make this group their circle. They need to /start me in a private chat first.'))
      tgState.circleChatId = ev.chatId
      engine.setCircle({ name: ev.chatTitle || 'Circle' })
      persist()
      log(`circle linked: ${ev.chatTitle}`)
      const m = await reply(`This group is now ${engine.settings.name}'s SafeWord circle.\n\nIf ${engine.settings.name} misses a check-in, sends a silent SOS from their glasses or says their safe word, the alert lands here with their location. Tap "I'm on it" so they can see help is coming; reply to the alert and your message shows up on their glasses.`)
      botMessages.add(m.message_id)
      return
    }
    if (ev.cmd === '/status' && ev.chatId === tgState.circleChatId) return void (await reply(status()))
    return
  }
  if (ev.type === 'text' && ev.chatId === tgState.circleChatId && ev.replyTo && botMessages.has(ev.replyTo)) {
    engine.circleReply({ who: ev.fromName.split(' ')[0], text: ev.text })
  }
}

let me = null
if (tg) {
  try {
    me = await tg.getMe()
  } catch (e) {
    log(`Telegram: off (${e.message}; check TELEGRAM_BOT_TOKEN in server/.env)`)
    tg = null
  }
}
if (tg) {
  log(`Telegram: @${me.username}${tgState.ownerId ? '' : ', send /start to the bot'}${engine.circle ? `, circle "${engine.circle.name}"` : ', no circle yet'}`)
  const cursor = { get offset() { return tgState.offset }, set offset(v) { tgState.offset = v; persist() } }
  pollForever({ tg, cursor, onEvent, onError: (e) => log('telegram', e.message) })
} else if (BOT_TOKEN && !TOKEN_OK) {
  log('Telegram: off (TELEGRAM_BOT_TOKEN in server/.env does not look like a bot token: expected 1234567890:AAF..., from @BotFather)')
} else {
  log('Telegram: off (set TELEGRAM_BOT_TOKEN in server/.env); messages go to this log')
}

// ---- HTTP -------------------------------------------------------------------

function send(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function body(req, limit = 4_000_000) {
  const chunks = []
  let n = 0
  for await (const c of req) {
    n += c.length
    if (n > limit) throw Object.assign(new Error('body too large'), { status: 413 })
    chunks.push(c)
  }
  return Buffer.concat(chunks)
}
const json = async (req) => JSON.parse((await body(req, 20_000)).toString() || '{}')

const view = () => ({ ...engine.view(), version: engine.version })

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  try {
    if (req.method === 'OPTIONS') return send(res, 204, {})
    if (url.pathname === '/api/health') {
      return send(res, 200, { ok: true, telegram: Boolean(tg), owner: tgState.ownerId != null, circle: engine.circle?.name ?? null, codeword: Boolean(engine.settings.codeword), location: Boolean(engine.location) })
    }

    if (url.pathname === '/api/view' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0)
      if (engine.version > since) return send(res, 200, view())
      const done = () => { clearTimeout(timer); waiters.delete(done); if (!res.writableEnded) send(res, 200, view()) }
      const timer = setTimeout(done, 20_000)
      waiters.add(done)
      req.on('close', () => { clearTimeout(timer); waiters.delete(done) })
      return
    }

    if (url.pathname === '/api/input' && req.method === 'POST') {
      const { action } = await json(req)
      if (!['tap', 'next', 'prev'].includes(action)) return send(res, 400, { error: 'action must be tap, next or prev' })
      await engine.input(action)
      return send(res, 200, view())
    }

    if (url.pathname === '/api/voice' && req.method === 'POST') {
      const pcm = await body(req)
      const t0 = Date.now()
      const text = await transcribe(pcm)
      log(`voice ${pcm.length} bytes -> "${text}" in ${Date.now() - t0} ms`)
      await engine.voice(text)
      return send(res, 200, { text, ...view() })
    }

    // Dev endpoints: drive the flow without glasses, a microphone or a second phone.
    if (DEV && req.method === 'POST' && url.pathname.startsWith('/api/dev/')) {
      const b = await json(req)
      switch (url.pathname) {
        case '/api/dev/say': await engine.voice(String(b.text ?? '')); break
        case '/api/dev/circle': engine.setCircle({ name: b.name || 'Family' }); break
        case '/api/dev/location': engine.setLocation({ lat: Number(b.lat), lon: Number(b.lon), live: b.live !== false }); break
        case '/api/dev/codeword': engine.setCodeword(String(b.word ?? '')); break
        case '/api/dev/grace': engine.settings.graceSec = Number(b.seconds) || 120; engine.changed('settings'); break
        case '/api/dev/respond': {
          const a = engine.openAlert
          if (b.action === 'reply') engine.circleReply({ who: b.who || 'Budi', text: b.text || 'calling you now' })
          else if (a) await engine.respond({ alertId: a.id, who: b.who || 'Budi', action: b.action || 'on' })
          break
        }
        default: return send(res, 404, { error: 'unknown dev endpoint' })
      }
      return send(res, 200, view())
    }

    send(res, 404, { error: 'not found' })
  } catch (err) {
    log('http', req.method, url.pathname, err.message)
    send(res, err.status || 500, { error: err.message })
  }
})

server.listen(PORT, HOST, () => log(`SafeWord server on http://${HOST}:${PORT}${DEV ? ' (dev endpoints on)' : ''}`))
