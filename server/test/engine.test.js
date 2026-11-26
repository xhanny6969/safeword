import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Engine } from '../src/engine.js'

const MIN = 60_000
const T0 = Date.UTC(2026, 10, 26, 15, 0) // 15:00 UTC

function rig({ circle = true, failCircle = 0 } = {}) {
  let now = T0
  const sent = { circle: [], edits: [], pins: [], wearer: [], wearerEdits: [] }
  let id = 100
  let failures = failCircle
  const out = {
    circle: async (text, o = {}) => {
      if (failures > 0) { failures--; throw new Error('network down') }
      sent.circle.push({ id: ++id, text, ...o })
      return id
    },
    editCircle: async (msgId, text, o = {}) => { sent.edits.push({ msgId, text, ...o }) },
    circleLocation: async (loc) => { sent.pins.push(loc) },
    wearer: async (text, o = {}) => { sent.wearer.push({ id: ++id, text, ...o }); return id },
    editWearer: async (msgId, text) => { sent.wearerEdits.push({ msgId, text }) },
  }
  const e = new Engine({ out, now: () => now }, { settings: { name: 'Dwi', tz: 'UTC', codeword: 'pineapple', graceSec: 120 } })
  e.on('warn', () => {})
  if (circle) e.setCircle({ name: 'Family' })
  return { e, sent, advance: (ms) => { now += ms }, get now() { return now } }
}

test('tap on the idle card starts check-ins and tells the circle quietly', async () => {
  const { e, sent } = rig()
  assert.equal(e.view().kind, 'idle')
  const v = await e.input('tap')
  assert.equal(v.kind, 'session')
  assert.match(v.body, /Next check-in 15:30/)
  assert.equal(sent.circle.length, 1)
  assert.match(sent.circle[0].text, /every 30 min, next at 15:30/)
  assert.equal(sent.circle[0].silent, true)
})

test('a due check-in prompts the glasses and the phone; tapping OK resets the timer', async () => {
  const { e, sent, advance } = rig()
  await e.startSession(20)
  advance(20 * MIN)
  await e.tick()
  assert.equal(e.view().kind, 'due')
  assert.match(e.view().body, /Family is alerted in 2 min/)
  assert.equal(sent.wearer.length, 1)
  assert.equal(sent.wearer[0].buttons.inline_keyboard[0][0].callback_data, 'checkin')
  advance(30_000)
  const v = await e.input('tap')
  assert.equal(v.kind, 'session')
  assert.equal(e.session.checkins, 1)
  assert.equal(e.session.dueAt, T0 + 20 * MIN + 30_000 + 20 * MIN)
  assert.match(sent.wearerEdits[0].text, /Checked in/)
})

test('no answer within the grace period raises a missed-check-in alert with buttons and the location pin', async () => {
  const { e, sent, advance } = rig()
  e.setLocation({ lat: -6.2, lon: 106.8, live: true })
  await e.startSession(10)
  advance(10 * MIN); await e.tick()
  advance(119_000); await e.tick()
  assert.equal(e.openAlert, null)
  advance(1_000); await e.tick()
  const a = e.openAlert
  assert.equal(a.kind, 'missed')
  const msg = sent.circle.at(-1)
  assert.match(msg.text, /Dwi missed a check-in/)
  assert.match(msg.text, /15:10 check-in got no answer for 2 min/)
  assert.deepEqual(msg.buttons.inline_keyboard.map((r) => r[0].callback_data), [`on:${a.id}`, `ok:${a.id}`])
  assert.equal(sent.pins.length, 1)
  assert.equal(e.view().kind, 'alert')
  assert.equal(e.session.paused, true)
  assert.match(sent.wearerEdits.at(-1).text, /circle was alerted/)
})

test('the circle answers: "on it" shows on the glasses, "all OK" closes the alert and resumes check-ins', async () => {
  const { e, sent, advance } = rig()
  await e.startSession(10)
  await e.input('next')
  assert.equal(e.view().kind, 'sos')
  await e.input('tap')
  const a = e.openAlert
  assert.equal(a.kind, 'sos')
  advance(MIN)
  const r1 = await e.respond({ alertId: a.id, who: 'Budi', action: 'on' })
  assert.match(r1.answer, /on it/)
  assert.match(e.view().body, /Budi is on it · 15:01/)
  assert.match(sent.edits.at(-1).text, /Budi is on it \(15:01\)/)
  e.circleReply({ who: 'Budi', text: 'calling you now' })
  assert.match(e.view().body, /Budi: "calling you now"/)
  advance(4 * MIN)
  await e.respond({ alertId: a.id, who: 'Budi', action: 'ok' })
  assert.equal(e.openAlert, null)
  assert.match(sent.edits.at(-1).text, /Closed 15:05: Budi reached them, all OK/)
  assert.deepEqual(sent.edits.at(-1).buttons, { inline_keyboard: [] })
  assert.equal(e.session.paused, false)
  assert.equal(e.session.dueAt, T0 + 5 * MIN + 10 * MIN)
  assert.equal(e.view().kind, 'session')
})

test('saying the safe word inside an ordinary sentence raises a silent duress alert', async () => {
  const { e, sent } = rig()
  await e.startSession(30)
  const v = await e.voice("Yeah I'm fine, we're just getting pineapple pizza.")
  assert.equal(v.kind, 'alert')
  assert.equal(e.openAlert.kind, 'duress')
  const msg = sent.circle.at(-1).text
  assert.match(msg, /Dwi said their safe word/)
  assert.match(msg, /don't mention SafeWord/)
  assert.match(msg, /pineapple pizza/)
})

test('"I\'m fine" without the safe word is a normal check-in, and a misheard safe word still counts', async () => {
  const { e } = rig()
  await e.startSession(30)
  await e.voice("I'm fine.")
  assert.equal(e.session.checkins, 1)
  assert.equal(e.openAlert, null)
  await e.voice('We had pineaple pizza')
  assert.equal(e.openAlert?.kind, 'duress')
})

test('the wearer can close an alert from the glasses with a confirm step', async () => {
  const { e, sent } = rig()
  await e.raise('sos')
  let v = await e.input('tap')
  assert.equal(v.kind, 'safe')
  v = await e.input('next')
  assert.equal(v.kind, 'alert')
  await e.input('tap')
  v = await e.input('tap')
  assert.equal(e.openAlert, null)
  assert.match(sent.circle.at(-1).text, /Dwi says they are safe now/)
})

test('voice controls: start with an interval, tell the circle something, end at home', async () => {
  const { e, sent } = rig()
  await e.voice('Check on me every 15 minutes')
  assert.equal(e.session.intervalMs, 15 * MIN)
  await e.voice('Tell them I am walking past the station now')
  assert.equal(sent.circle.at(-1).text, '💬 Dwi: i am walking past the station now')
  await e.voice("I'm home.")
  assert.equal(e.session, null)
  assert.match(sent.circle.at(-1).text, /Dwi is home safe/)
})

test('an alert that fails to send is retried on the next tick, and the glasses say so meanwhile', async () => {
  const { e, sent } = rig({ failCircle: 1 })
  await e.raise('sos')
  assert.equal(e.openAlert.msgId, null)
  assert.match(e.view().body, /Sending to Family… retrying/)
  await e.tick()
  assert.ok(e.openAlert.msgId)
  assert.match(sent.circle.at(-1).text, /SILENT SOS from Dwi/)
  assert.match(e.view().body, /Family has it/)
})

test('without a linked circle the glasses say plainly that the alert was not sent', async () => {
  const { e, sent } = rig({ circle: false })
  await e.raise('sos')
  assert.equal(sent.circle.length, 0)
  assert.match(e.view().body, /No circle linked: alert NOT sent/)
})

test('state survives a restart', async () => {
  const { e, advance } = rig()
  await e.startSession(10)
  await e.raise('sos')
  const copy = new Engine({ out: e.out, now: e.now }, JSON.parse(JSON.stringify(e.toJSON())))
  assert.equal(copy.openAlert.kind, 'sos')
  assert.equal(copy.session.paused, true)
  assert.equal(copy.view().kind, 'alert')
  advance(1)
})
