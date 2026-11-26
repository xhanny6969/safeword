// SafeWord engine: check-in timer, alerts, circle responses, and the one card
// the glasses show. No I/O of its own: Telegram is reached through `out`, the
// clock through `now`, so every path runs in tests.
//
// The timer lives here, on the server, not in the glasses app. If the app is
// closed, the phone dies or the wearer can't touch anything, a missed check-in
// still raises the alert. Alerts that fail to send are retried every tick.

import { EventEmitter } from 'node:events'
import { intentOf } from './intent.js'
import * as V from './views.js'

const MIN = 60_000
const FLASH_MS = 5000

/**
 * @typedef {object} Out  how the engine reaches people (Telegram in production)
 * @property {(text: string, o?: { buttons?: object, silent?: boolean }) => Promise<number|null>} circle  post to the circle; returns message id
 * @property {(msgId: number, text: string, o?: { buttons?: object }) => Promise<void>} editCircle
 * @property {(loc: { lat: number, lon: number }) => Promise<void>} circleLocation
 * @property {(text: string, o?: { buttons?: object }) => Promise<number|null>} wearer  private chat with the wearer
 * @property {(msgId: number, text: string) => Promise<void>} editWearer
 */

export class Engine extends EventEmitter {
  /** @param {{ out: Out, now?: () => number }} deps */
  constructor({ out, now = () => Date.now() }, saved = {}) {
    super()
    this.out = out
    this.now = now
    this.settings = { name: 'Your friend', intervalMin: 30, graceSec: 120, codeword: '', tz: undefined, ...saved.settings }
    this.circle = saved.circle ?? null
    this.session = saved.session ?? null
    this.alerts = saved.alerts ?? []
    this.location = saved.location ?? null
    this.inbox = saved.inbox ?? []
    this.seq = saved.seq ?? 0
    this.card = 'main'
    this.flashMsg = null
    this.version = 1
    this.lastKey = ''
    this.sending = new Set()
  }

  get openAlert() {
    return this.alerts.find((a) => !a.resolvedAt) ?? null
  }

  toJSON() {
    return {
      settings: this.settings,
      circle: this.circle,
      session: this.session,
      alerts: this.alerts.slice(-20),
      location: this.location,
      inbox: this.inbox.slice(-10),
      seq: this.seq,
    }
  }

  // ---- view -------------------------------------------------------------------

  view() {
    const c = V.card(this)
    if (this.flashMsg && this.now() < this.flashMsg.until) c.footer = this.flashMsg.text
    return c
  }

  refresh(reason = 'tick') {
    const v = this.view()
    const key = JSON.stringify(v)
    if (key !== this.lastKey) {
      this.lastKey = key
      this.version++
      this.emit('view', { version: this.version, reason })
    }
    return v
  }

  changed(reason) {
    this.emit('persist')
    return this.refresh(reason)
  }

  flash(text) {
    this.flashMsg = { text, until: this.now() + FLASH_MS }
  }

  async safely(what, fn) {
    try {
      return await fn()
    } catch (err) {
      this.emit('warn', `${what}: ${err.message}`)
      return null
    }
  }

  // ---- settings, circle, location ---------------------------------------------

  /** Clears sessions, alerts, location and the safe word (demo/dev reset). */
  reset({ keepCircle = false } = {}) {
    this.session = null
    this.alerts = []
    this.location = null
    this.inbox = []
    this.settings.codeword = ''
    if (!keepCircle) this.circle = null
    this.card = 'main'
    this.flashMsg = null
    return this.changed('reset')
  }

  setCircle(circle) {
    this.circle = circle
    return this.changed('circle')
  }

  setName(name) {
    if (name) this.settings.name = name
    return this.changed('settings')
  }

  setCodeword(word) {
    this.settings.codeword = String(word ?? '').trim()
    return this.changed('settings')
  }

  setInterval(minutes) {
    this.settings.intervalMin = minutes
    if (this.session && !this.session.prompted) {
      this.session.intervalMs = minutes * MIN
      this.session.dueAt = this.now() + this.session.intervalMs
    }
    return this.changed('settings')
  }

  setLocation({ lat, lon, at, live }) {
    this.location = { lat, lon, at: at ?? this.now(), live: Boolean(live) }
    return this.changed('location')
  }

  // ---- check-ins --------------------------------------------------------------

  async startSession(minutes = this.settings.intervalMin, via = 'glasses') {
    const now = this.now()
    const m = Math.max(1, Math.min(240, Math.round(minutes)))
    this.session = { startedAt: now, intervalMs: m * MIN, dueAt: now + m * MIN, checkins: 0, prompted: false, paused: false, promptMsgId: null }
    this.card = 'main'
    this.flash(`Check-ins on · next ${V.hhmm(this.session.dueAt, this.settings.tz)}`)
    await this.safely('circle', () => this.out.circle(
      `🟢 ${this.settings.name} turned on check-ins: every ${m} min, next at ${V.hhmm(this.session.dueAt, this.settings.tz)}. If one is missed, the alert lands here.`,
      { silent: true },
    ))
    this.emit('log', `session on, every ${m} min (${via})`)
    return this.changed('start')
  }

  async checkIn(via = 'glasses') {
    const s = this.session
    if (this.openAlert) return this.selfSafe(via)
    if (!s) {
      this.flash('No check-ins running · tap to start')
      return this.refresh('noop')
    }
    const now = this.now()
    const prompt = s.promptMsgId
    s.checkins++
    s.lastOkAt = now
    s.prompted = false
    s.promptMsgId = null
    s.dueAt = now + s.intervalMs
    this.card = 'main'
    this.flash(`Checked in ✓ · next ${V.hhmm(s.dueAt, this.settings.tz)}`)
    if (prompt) await this.safely('wearer', () => this.out.editWearer(prompt, `✅ Checked in at ${V.hhmm(now, this.settings.tz)} (${via}).`))
    this.emit('log', `check-in ${s.checkins} (${via})`)
    return this.changed('checkin')
  }

  async endSession(via = 'glasses') {
    if (!this.session) {
      this.flash('Check-ins are already off')
      return this.refresh('noop')
    }
    const prompt = this.session.promptMsgId
    this.session = null
    this.card = 'main'
    this.flash('Check-ins off · circle told you\'re home')
    if (prompt) await this.safely('wearer', () => this.out.editWearer(prompt, '✅ Check-ins ended.'))
    await this.safely('circle', () => this.out.circle(`✅ ${this.settings.name} is home safe. Check-ins are off.`, { silent: true }))
    this.emit('log', `session off (${via})`)
    return this.changed('end')
  }

  // ---- alerts -----------------------------------------------------------------

  async raise(kind, extra = {}) {
    if (this.openAlert && kind !== 'test') {
      // One open alert at a time; a second trigger adds urgency to the first.
      const a = this.openAlert
      if (kind === 'sos' || kind === 'duress') a.kind = kind
      if (extra.heard) a.heard = extra.heard
      await this.deliver(a)
      this.card = 'main'
      return this.changed('alert')
    }
    const a = {
      id: ++this.seq,
      kind,
      at: this.now(),
      dueAt: extra.dueAt ?? null,
      heard: extra.heard ?? null,
      via: extra.via ?? 'glasses',
      msgId: null,
      responders: [],
      resolvedAt: null,
      resolvedBy: null,
    }
    this.alerts.push(a)
    if (this.session) this.session.paused = true
    this.card = 'main'
    this.emit('log', `ALERT ${a.id} ${kind} (${a.via})`)
    await this.deliver(a)
    return this.changed('alert')
  }

  alertText(a) {
    return V.alertText(a, { name: this.settings.name, location: this.location, now: this.now(), tz: this.settings.tz, graceSec: this.settings.graceSec })
  }

  /** Posts the alert (and the location pin) if it has not gone out yet. */
  async deliver(a) {
    if (!this.circle || this.sending.has(a.id)) return
    this.sending.add(a.id)
    try {
      if (!a.msgId) {
        const id = await this.safely('alert', () => this.out.circle(this.alertText(a), { buttons: V.alertButtons(a) }))
        if (!id) return
        a.msgId = id
        if (this.location) await this.safely('location', () => this.out.circleLocation(this.location))
      } else {
        await this.update(a)
      }
    } finally {
      this.sending.delete(a.id)
    }
  }

  async update(a) {
    if (!a.msgId) return
    await this.safely('alert edit', () => this.out.editCircle(a.msgId, this.alertText(a), { buttons: V.alertButtons(a) }))
  }

  findAlert(id) {
    return this.alerts.find((a) => a.id === Number(id)) ?? null
  }

  /** A circle member pressed a button under an alert. */
  async respond({ alertId, who, action }) {
    const a = this.findAlert(alertId)
    if (!a) return { answer: 'That alert is gone.' }
    if (a.resolvedAt) return { answer: 'Already closed.' }
    const now = this.now()
    if (action === 'on') {
      if (!a.responders.some((r) => r.name === who)) a.responders.push({ name: who, at: now })
      this.flash(`${who} is on it`)
      await this.update(a)
      this.changed('respond')
      return { answer: `${this.settings.name} can see that you're on it.` }
    }
    if (action === 'ok') {
      await this.resolve(a, who)
      this.flash(`${who} closed the alert: all OK`)
      this.changed('resolved')
      return { answer: 'Alert closed. Thank you.' }
    }
    return { answer: '' }
  }

  async resolve(a, by) {
    a.resolvedAt = this.now()
    a.resolvedBy = by
    await this.update(a)
    const s = this.session
    if (s) {
      s.paused = false
      s.prompted = false
      s.dueAt = this.now() + s.intervalMs
    }
  }

  async selfSafe(via = 'glasses') {
    const a = this.openAlert
    if (!a) {
      this.flash('No open alert')
      return this.refresh('noop')
    }
    await this.resolve(a, 'self')
    if (this.session?.promptMsgId) {
      const prompt = this.session.promptMsgId
      this.session.promptMsgId = null
      await this.safely('wearer', () => this.out.editWearer(prompt, '✅ You said you are safe.'))
    }
    await this.safely('circle', () => this.out.circle(`🟢 ${this.settings.name} says they are safe now (${V.hhmm(this.now(), this.settings.tz)}).`))
    this.card = 'main'
    this.flash('Circle told you\'re safe')
    this.emit('log', `alert ${a.id} closed by wearer (${via})`)
    return this.changed('safe')
  }

  /** A circle member replied to one of the bot's messages. */
  circleReply({ who, text }) {
    this.inbox.push({ who, text: String(text).slice(0, 200), at: this.now() })
    this.inbox = this.inbox.slice(-10)
    this.flash(`${who}: ${text}`.slice(0, 48))
    return this.changed('reply')
  }

  async tell(message) {
    if (!this.circle) {
      this.flash('No circle linked yet')
      return this.refresh('noop')
    }
    const id = await this.safely('circle', () => this.out.circle(`💬 ${this.settings.name}: ${message}`))
    this.flash(id ? `Sent to ${this.circle.name}` : 'Could not send · try again')
    return this.changed('tell')
  }

  // ---- clock --------------------------------------------------------------------

  async tick() {
    const s = this.session
    const now = this.now()
    if (s && !s.paused) {
      if (!s.prompted && now >= s.dueAt) {
        s.prompted = true
        this.card = 'main'
        const id = await this.safely('wearer', () => this.out.wearer(
          `⏰ Check-in due (${V.hhmm(s.dueAt, this.settings.tz)}). Are you OK? Your circle is alerted in ${V.span(this.settings.graceSec)}.`,
          { buttons: { inline_keyboard: [[{ text: "✅ I'm OK", callback_data: 'checkin' }]] } },
        ))
        s.promptMsgId = id ?? null
        this.emit('log', 'check-in due')
        this.changed('due')
      } else if (s.prompted && now >= s.dueAt + this.settings.graceSec * 1000) {
        const prompt = s.promptMsgId
        s.promptMsgId = null
        await this.raise('missed', { dueAt: s.dueAt, via: 'timer' })
        if (prompt) await this.safely('wearer', () => this.out.editWearer(prompt, '⚠️ No answer: your circle was alerted.'))
      }
    }
    for (const a of this.alerts) if (!a.resolvedAt && !a.msgId) await this.deliver(a)
    this.refresh('tick')
  }

  // ---- input from the glasses -------------------------------------------------

  async input(action) {
    const card = this.card
    if (card === 'sos') {
      if (action === 'tap') return this.raise('sos', { via: 'glasses' })
      this.card = 'main'
      return this.refresh('back')
    }
    if (card === 'end') {
      if (action === 'tap') return this.endSession('glasses')
      this.card = 'main'
      return this.refresh('back')
    }
    if (card === 'safe') {
      if (action === 'tap') return this.selfSafe('glasses')
      this.card = 'main'
      return this.refresh('back')
    }
    if (this.openAlert) {
      if (action === 'tap') { this.card = 'safe'; return this.refresh('confirm') }
      this.flash('Alert is open · tap if you are safe')
      return this.refresh('noop')
    }
    if (action === 'tap') return this.session ? this.checkIn('glasses') : this.startSession(this.settings.intervalMin, 'glasses')
    if (action === 'next') { this.card = 'sos'; return this.refresh('sos?') }
    if (action === 'prev' && this.session) { this.card = 'end'; return this.refresh('end?') }
    return this.refresh('noop')
  }

  async voice(text) {
    const i = intentOf(text, { codeword: this.settings.codeword, alertOpen: Boolean(this.openAlert), session: Boolean(this.session) })
    this.emit('log', `voice "${text}" -> ${i.kind}`)
    switch (i.kind) {
      case 'duress':
        return this.raise('duress', { heard: text, via: 'voice' })
      case 'sos':
        return this.raise('sos', { via: 'voice' })
      case 'ok':
        if (this.session) return this.checkIn('voice')
        this.flash('Heard you · say "check on me every 20 minutes"')
        return this.refresh('voice')
      case 'safe':
        return this.selfSafe('voice')
      case 'start':
        return this.startSession(i.minutes ?? this.settings.intervalMin, 'voice')
      case 'end':
        return this.endSession('voice')
      case 'tell':
        return this.tell(i.message)
      default:
        this.flash(text ? `Heard "${text.slice(0, 26)}" · try "I'm OK"` : 'Didn\'t catch that · hold and speak')
        return this.refresh('voice')
    }
  }
}
