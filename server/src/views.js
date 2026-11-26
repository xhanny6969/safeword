// Text for the G2 (576 x 288, monochrome green, one card at a time) and for
// the Telegram circle. Pure functions of engine state.

const LABEL = { sos: 'SOS', duress: 'SAFE WORD', missed: 'MISSED CHECK-IN', test: 'TEST' }

export function hhmm(ms, tz) {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(ms)
}

/** Coarse on purpose: the card only redraws when this string changes. */
export function countdown(ms) {
  if (ms <= 0) return 'now'
  if (ms >= 120_000) return `${Math.ceil(ms / 60_000)} min`
  return `${Math.ceil(ms / 10_000) * 10} s`
}

export function ago(ms) {
  if (ms < 60_000) return 'just now'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${m} min ago`
  const h = Math.floor(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function locLine(loc, now) {
  if (!loc) return 'Location: not shared yet'
  return `Location: ${loc.live ? 'live' : 'last shared'} · ${ago(now - loc.at)}`
}

/** The card on the glasses. */
export function card(e) {
  const now = e.now()
  const tz = e.settings.tz
  const circle = e.circle?.name ?? 'your circle'
  const a = e.openAlert
  const s = e.session

  if (e.card === 'sos') {
    return {
      kind: 'sos',
      header: 'SILENT SOS',
      body: [
        `Tap to alert ${circle} now.`,
        e.location ? 'They get your location too.' : 'No location shared yet.',
        'Nothing sounds or shows on your side.',
      ].join('\n'),
      footer: 'tap  send SOS      swipe  back',
    }
  }
  if (e.card === 'end') {
    return {
      kind: 'end',
      header: 'END CHECK-INS?',
      body: [`${circle} gets:`, `"${e.settings.name} is home safe."`].join('\n'),
      footer: 'tap  end      swipe  back',
    }
  }
  if (e.card === 'safe' && a) {
    return {
      kind: 'safe',
      header: 'CLOSE THE ALERT?',
      body: [`${circle} gets:`, `"${e.settings.name} is safe now."`, 'Only if you really are.'].join('\n'),
      footer: 'tap  I\'m safe      swipe  back',
    }
  }

  if (a) {
    const lines = []
    if (!e.circle) lines.push('No circle linked: alert NOT sent.')
    else if (!a.msgId) lines.push(`Sending to ${circle}… retrying`)
    else lines.push(`${circle} has it${e.location ? ' + your location' : ''}.`)
    const on = a.responders.slice(-2)
    if (on.length) for (const r of on) lines.push(`${r.name} is on it · ${hhmm(r.at, tz)}`)
    else lines.push('Waiting for someone to answer…')
    const msg = [...e.inbox].reverse().find((m) => m.at >= a.at)
    if (msg) lines.push(clip(`${msg.who}: "${msg.text}"`, 44))
    return {
      kind: 'alert',
      header: `ALERT SENT ${hhmm(a.at, tz)} · ${LABEL[a.kind] ?? a.kind.toUpperCase()}`,
      body: lines.join('\n'),
      footer: 'tap  I\'m safe now      hold  speak',
    }
  }

  if (s && s.prompted) {
    const left = s.dueAt + e.settings.graceSec * 1000 - now
    return {
      kind: 'due',
      header: `CHECK-IN DUE · ${hhmm(s.dueAt, tz)}`,
      body: [
        'Are you OK?',
        'Tap, or hold and say "I\'m fine".',
        `${circle} is alerted in ${countdown(left)}.`,
      ].join('\n'),
      footer: 'tap  I\'m OK      hold  speak      swipe  SOS',
    }
  }

  if (s) {
    return {
      kind: 'session',
      header: `CHECK-INS ON · every ${Math.round(s.intervalMs / 60_000)} min`,
      body: [
        `Next check-in ${hhmm(s.dueAt, tz)} · in ${countdown(s.dueAt - now)}`,
        `${s.checkins} done since ${hhmm(s.startedAt, tz)}`,
        locLine(e.location, now),
        'Say "I\'m home" to end.',
      ].join('\n'),
      footer: 'tap  I\'m OK      hold  speak      swipe  SOS',
    }
  }

  return {
    kind: 'idle',
    header: `SAFEWORD · ${e.circle?.name ?? 'no circle yet'}`,
    body: [
      'Check-ins are off.',
      `Tap to start: every ${e.settings.intervalMin} min.`,
      locLine(e.location, now),
      e.circle ? `Alerts go to ${circle}.` : 'Link a circle: /circle in a Telegram group.',
    ].join('\n'),
    footer: 'tap  start      hold  speak      swipe  SOS',
  }
}

/** The alert message in the circle group; edited as people respond. */
export function alertText(a, { name, location, now, tz, graceSec }) {
  const head = {
    sos: `🚨 SILENT SOS from ${name}`,
    duress: `🚨 ${name} said their safe word`,
    missed: `⚠️ ${name} missed a check-in`,
    test: `🧪 TEST alert from ${name}`,
  }[a.kind]
  const what = {
    sos: 'Sent from their glasses without a sound. They may not be able to talk: text first, call if there is no answer.',
    duress: `They sounded fine on purpose, so someone may be listening. If you call, keep it casual and don't mention SafeWord.${a.heard ? `\nThey said: "${clip(a.heard, 120)}"` : ''}`,
    missed: `The ${a.dueAt ? hhmm(a.dueAt, tz) : ''} check-in got no answer for ${Math.round(graceSec / 60) || 1} min. Text or call them.`,
    test: 'Nothing is wrong. This is what an alert looks like: try the buttons.',
  }[a.kind]
  const lines = [`${head} · ${hhmm(a.at, tz)}`, '', what, '']
  lines.push(location ? `📍 Location (${location.live ? 'live' : 'last shared'}, ${ago(now - location.at)}): pin below.` : '📍 No location shared yet.')
  if (a.responders.length) {
    lines.push('')
    for (const r of a.responders) lines.push(`🙋 ${r.name} is on it (${hhmm(r.at, tz)})`)
  }
  if (a.resolvedAt) {
    lines.push('')
    lines.push(a.resolvedBy === 'self'
      ? `🟢 Closed ${hhmm(a.resolvedAt, tz)}: ${name} says they are safe.`
      : `🟢 Closed ${hhmm(a.resolvedAt, tz)}: ${a.resolvedBy} reached them, all OK.`)
  }
  return lines.join('\n')
}

export function alertButtons(a) {
  if (a.resolvedAt) return { inline_keyboard: [] }
  return {
    inline_keyboard: [
      [{ text: "🙋 I'm on it", callback_data: `on:${a.id}` }],
      [{ text: '✅ Reached them: all OK', callback_data: `ok:${a.id}` }],
    ],
  }
}
