// Push-to-talk transcript -> one SafeWord action.
//
// The duress check runs first and wins over everything else: the wearer says
// an ordinary sentence ("I'm fine, we're getting pineapple pizza") and the
// circle is alerted silently. Whisper sometimes mishears a word by a letter,
// so codewords of 5+ letters also match at edit distance 1.

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty five': 45, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90,
}

export function normalise(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[’`]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1))
      diag = tmp
    }
  }
  return prev[b.length]
}

/** True when the (normalised) codeword appears in the transcript. */
export function saysCodeword(text, codeword) {
  const cw = normalise(codeword).replace(/'/g, '')
  if (!cw) return false
  const t = normalise(text).replace(/'/g, '')
  const padded = ` ${t} `
  if (padded.includes(` ${cw} `)) return true
  const cwWords = cw.split(' ')
  const words = t.split(' ')
  // Whisper may split or join a compound word: "pine apple", "pineapples".
  if (t.replace(/ /g, '').includes(cw.replace(/ /g, '')) && cw.replace(/ /g, '').length >= 6) return true
  if (cwWords.length === 1 && cw.length >= 5) {
    return words.some((w) => w.length >= 4 && (lev(w, cw) <= 1 || (w.endsWith('s') && lev(w.slice(0, -1), cw) <= 1)))
  }
  return false
}

/** "every 20 minutes", "every half an hour", "every hour" -> minutes */
export function parseInterval(text) {
  const t = normalise(text)
  if (/\b(half an hour|half hour)\b/.test(t)) return 30
  if (/\b(an|one) hour\b|\bevery hour\b|\bhourly\b/.test(t)) return 60
  const m = /\b(\d{1,3}|[a-z]+(?:[ -]five)?) ?(min|mins|minute|minutes|hour|hours)\b/.exec(t)
  if (!m) return null
  const n = /^\d+$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1]] ?? null
  if (!n) return null
  return m[2].startsWith('hour') ? n * 60 : n
}

/**
 * @param {string} text  transcript
 * @param {{ codeword?: string, alertOpen?: boolean, session?: boolean }} ctx
 * @returns {{ kind: 'duress'|'sos'|'ok'|'safe'|'start'|'end'|'tell'|'unknown', minutes?: number, message?: string }}
 */
export function intentOf(text, ctx = {}) {
  const t = normalise(text)
  if (!t) return { kind: 'unknown' }
  if (ctx.codeword && saysCodeword(text, ctx.codeword)) return { kind: 'duress' }

  if (/\b(sos|help me|emergency|send help|call for help)\b/.test(t)) return { kind: 'sos' }

  const tell = /^(?:please )?(?:tell|text|message|let) (?:them|the group|the circle|my circle|everyone|everybody|my family|family|\w+)(?: know)?(?: that)? (.+)$/.exec(t)
  if (tell && !/^(?:please )?(?:tell|text|message|let) me\b/.test(t)) return { kind: 'tell', message: tell[1].replace(/^that /, '') }

  if (/\b(i'?m|i am|im) (home|back home|back)\b|\b(made it|got home|i'?m here safe)\b|\b(end|stop|finish|cancel) (the )?(check ?ins?|checking|session|tracking)\b|\bstop checking on me\b/.test(t)) {
    return { kind: 'end' }
  }

  const minutes = parseInterval(t)
  if (/\b(start|begin|turn on)\b.*\b(check ?ins?|checking|session)\b|\bcheck on me\b|\bwalk me home\b|\bcheck in every\b/.test(t)) {
    return { kind: 'start', minutes: minutes ?? undefined }
  }

  if (/\b(i'?m|i am|im) (safe|okay now|ok now|alright now)\b|\bfalse alarm\b|\ball clear\b/.test(t) && ctx.alertOpen) return { kind: 'safe' }
  if (/\b(i'?m|i am|im|all) (ok|okay|fine|good|alright|all right|safe)\b|\b(all good|checking in|check in)\b|^(ok|okay|yes|yep|fine)$/.test(t)) {
    return { kind: ctx.alertOpen ? 'safe' : 'ok' }
  }
  return { kind: 'unknown' }
}
