// Speech-to-text for push-to-talk on the glasses.
//
// The G2 sends 16 kHz signed 16-bit little-endian mono PCM. We run Whisper
// locally (transformers.js, ONNX on CPU): no audio leaves the machine and no
// API key is needed. The model downloads once (~40 MB) into the HF cache.

let pipePromise = null
const MODEL = process.env.STT_MODEL || 'Xenova/whisper-tiny.en'
const MODELS_DIR = new URL('../models/', import.meta.url)

async function pipe() {
  if (!pipePromise) {
    pipePromise = (async () => {
      const { pipeline, env } = await import('@huggingface/transformers')
      // Files come from `npm run fetch-model`; never fetched at request time.
      env.localModelPath = decodeURIComponent(MODELS_DIR.pathname).replace(/^\/([A-Za-z]:)/, '$1')
      env.allowRemoteModels = false
      return pipeline('automatic-speech-recognition', MODEL, { dtype: 'q8' })
    })().catch((err) => {
      pipePromise = null
      throw err
    })
  }
  return pipePromise
}

/** Loads the model in the background so the first press is not slow. */
export function warmUp() {
  return pipe().then(() => true, () => false)
}

export function pcm16ToFloat32(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  const n = Math.floor(buf.byteLength / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 32768
  return out
}

/** Strips a RIFF/WAVE header if present (test fixtures, recorded clips). */
export function wavToPcm(buf) {
  if (buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WAVE') {
    let off = 12
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4)
      const size = buf.readUInt32LE(off + 4)
      if (id === 'data') return buf.subarray(off + 8, off + 8 + size)
      off += 8 + size
    }
  }
  return buf
}

/** @param {Buffer} pcm 16 kHz s16le mono (a WAV is accepted too) */
export async function transcribe(pcm) {
  const samples = pcm16ToFloat32(wavToPcm(pcm))
  if (samples.length < 1600) return '' // under 0.1 s: a tap, not speech
  const asr = await pipe()
  const out = await asr(samples)
  return String(out?.text ?? '').trim()
}
