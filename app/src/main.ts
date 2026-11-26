// SafeWord on Even G2: a thin client.
//
// The glasses show one card: check-ins off, the next check-in, a check-in that
// is due, or an open alert with who is responding. The timer, Telegram and
// speech-to-text all live on the SafeWord server, so an alert still goes out
// if this app is closed, and no token ever ships inside it.
//
//   tap         do what the footer says (start / I'm OK / send SOS / I'm safe)
//   swipe down  silent SOS card (tap to send); swipe again to go back
//   swipe up    end check-ins (tap to confirm)
//   hold        push-to-talk: "I'm fine", "tell them I'm on the train",
//               "I'm home", or any sentence with your safe word
//   double-tap  exit (system dialog)

import {
  waitForEvenAppBridge,
  TextContainerProperty,
  CreateStartUpPageContainer,
  TextContainerUpgrade,
  OsEventTypeList,
  AudioInputSource,
} from '@evenrealities/even_hub_sdk'

const API = (new URLSearchParams(location.search).get('api') || import.meta.env.VITE_API_URL || 'http://127.0.0.1:8788').replace(/\/$/, '')

const DEBUG = new URLSearchParams(location.search).has('debug') || import.meta.env.DEV

type View = { version: number; header: string; body: string; footer: string; kind: string; mode: string; text?: string }

const bridge = await waitForEvenAppBridge()

// Three stacked text containers; only the body captures input.
const BLOCKS = {
  header: { id: 1, name: 'header', y: 0, h: 40, color: 2 },
  body: { id: 2, name: 'body', y: 40, h: 206, color: 4 },
  footer: { id: 3, name: 'footer', y: 248, h: 40, color: 2 },
} as const
type Block = keyof typeof BLOCKS

const shown: Record<Block, string> = { header: 'SAFEWORD', body: 'Connecting to the SafeWord server…', footer: API }

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 3,
    textObject: (Object.keys(BLOCKS) as Block[]).map(
      (k) =>
        new TextContainerProperty({
          xPosition: 0,
          yPosition: BLOCKS[k].y,
          width: 576,
          height: BLOCKS[k].h,
          borderWidth: 0,
          borderColor: 0,
          paddingLength: k === 'body' ? 8 : 4,
          containerID: BLOCKS[k].id,
          containerName: BLOCKS[k].name,
          content: shown[k],
          textColor: BLOCKS[k].color,
          isEventCapture: k === 'body' ? 1 : 0,
        }),
    ),
  }),
)
console.log(`[safeword] page ${result === 0 ? 'ready' : `failed (${result})`} api=${API}`)

async function put(k: Block, content: string) {
  if (shown[k] === content) return
  shown[k] = content
  await bridge.textContainerUpgrade(
    new TextContainerUpgrade({ containerID: BLOCKS[k].id, containerName: BLOCKS[k].name, content: content || ' ' }),
  )
}

let version = 0
async function render(v: View) {
  if (!v || typeof v.version !== 'number') return
  version = Math.max(version, v.version)
  await put('header', v.header)
  await put('body', v.body)
  await put('footer', v.footer)
}

// ---- server sync -------------------------------------------------------------

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(API + path, init)
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json() as Promise<T>
}

async function follow() {
  for (;;) {
    try {
      await render(await api<View>(`/api/view?since=${version}`))
    } catch (err) {
      await put('footer', `Server unreachable · retrying · ${API}`)
      console.warn('[safeword] view failed', err)
      await new Promise((r) => setTimeout(r, 2000))
    }
  }
}
follow()

let busy = false
async function act(action: 'tap' | 'next' | 'prev') {
  if (busy) return
  busy = true
  try {
    await render(await api<View>('/api/input', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action }) }))
  } catch (err) {
    await put('footer', 'Could not reach the server')
    console.warn('[safeword] input failed', err)
  } finally {
    busy = false
  }
}

// ---- push-to-talk --------------------------------------------------------------

let recording = false
let chunks: Uint8Array[] = []

async function startTalk() {
  if (recording) return
  recording = true
  chunks = []
  await put('footer', '● listening · release to send')
  await bridge.audioControl(true, AudioInputSource.Glasses)
}

async function stopTalk() {
  if (!recording) return
  recording = false
  await bridge.audioControl(false)
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const pcm = new Uint8Array(total)
  let off = 0
  for (const c of chunks) { pcm.set(c, off); off += c.byteLength }
  chunks = []
  await put('footer', '… transcribing')
  try {
    const v = await api<View>('/api/voice', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: pcm })
    console.log(`[safeword] heard "${v.text}" (${total} bytes)`)
    await render(v)
  } catch (err) {
    await put('footer', 'Voice failed · try again')
    console.warn('[safeword] voice failed', err)
  }
}

// ---- events --------------------------------------------------------------------

// CLICK_EVENT is 0 and protobuf drops zero values, so a tap arrives with
// eventType undefined. Resolve the default only inside an envelope that
// exists, or every audio frame would read as a tap.
function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

const unsubscribe = bridge.onEvenHubEvent((event) => {
  if (event.audioEvent) {
    if (recording) chunks.push(event.audioEvent.audioPcm)
    return
  }
  const sys = typeOf(event.sysEvent)
  const txt = typeOf(event.textEvent)
  const is = (t: OsEventTypeList) => sys === t || txt === t
  if (DEBUG) console.log(`[safeword] event sys=${sys} text=${txt} raw=${JSON.stringify(event)}`)

  if (sys === OsEventTypeList.SYSTEM_EXIT_EVENT || sys === OsEventTypeList.ABNORMAL_EXIT_EVENT) return void unsubscribe()
  // Long press always arrives on sysEvent, whichever container captures input.
  if (sys === OsEventTypeList.LONG_PRESS_EVENT) return void startTalk()
  if (sys === OsEventTypeList.LONG_PRESS_RELEASE_EVENT) return void stopTalk()
  if (is(OsEventTypeList.DOUBLE_CLICK_EVENT)) return void bridge.shutDownPageContainer(1)
  if (is(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return void act('next')
  if (is(OsEventTypeList.SCROLL_TOP_EVENT)) return void act('prev')
  if (is(OsEventTypeList.CLICK_EVENT)) return void act('tap')
})
