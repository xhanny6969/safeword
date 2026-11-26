// Downloads the Whisper model once into server/models so speech-to-text runs
// offline. Usage: npm run fetch-model
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MODEL = process.env.STT_MODEL || 'Xenova/whisper-tiny.en'
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'models', MODEL)
const FILES = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
]

for (const f of FILES) {
  const dest = join(ROOT, f)
  try {
    if ((await stat(dest)).size > 0) { console.log('have', f); continue }
  } catch {}
  const url = `https://huggingface.co/${MODEL}/resolve/main/${f}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await mkdir(dirname(dest), { recursive: true })
  await writeFile(dest, buf)
  console.log('got ', f, buf.length, 'bytes')
}
console.log('model ready in', ROOT)
