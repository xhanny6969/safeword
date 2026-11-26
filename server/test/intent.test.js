import { test } from 'node:test'
import assert from 'node:assert/strict'
import { intentOf, saysCodeword, parseInterval } from '../src/intent.js'

const ctx = { codeword: 'pineapple', session: true }

test('the safe word wins over everything, inside any sentence', () => {
  assert.equal(intentOf("I'm fine, we're getting pineapple pizza", ctx).kind, 'duress')
  assert.equal(intentOf('Tell them I had pineapple juice', ctx).kind, 'duress')
  assert.equal(intentOf('Pineapple.', ctx).kind, 'duress')
})

test('safe-word matching tolerates small Whisper slips but not unrelated words', () => {
  assert.ok(saysCodeword('pineaple pizza', 'pineapple'))
  assert.ok(saysCodeword('two pineapples please', 'pineapple'))
  assert.ok(saysCodeword('a pine apple', 'pineapple'))
  assert.ok(!saysCodeword('apple pie', 'pineapple'))
  assert.ok(!saysCodeword("I'm fine", 'pineapple'))
  assert.ok(saysCodeword('say hi to aunt rose', 'aunt rose'))
  assert.ok(!saysCodeword('anything', ''))
})

test('check-ins and alerts by voice', () => {
  assert.equal(intentOf("I'm fine.", ctx).kind, 'ok')
  assert.equal(intentOf('All good', ctx).kind, 'ok')
  assert.equal(intentOf("I'm okay", { ...ctx, alertOpen: true }).kind, 'safe')
  assert.equal(intentOf('False alarm', { ...ctx, alertOpen: true }).kind, 'safe')
  assert.equal(intentOf('Help me', ctx).kind, 'sos')
  assert.equal(intentOf("I'm home.", ctx).kind, 'end')
  assert.equal(intentOf('Stop check-ins', ctx).kind, 'end')
  assert.equal(intentOf('What time is it', ctx).kind, 'unknown')
})

test('start with an interval in words or digits', () => {
  assert.deepEqual(intentOf('Check on me every 20 minutes', ctx), { kind: 'start', minutes: 20 })
  assert.deepEqual(intentOf('Start check-ins every fifteen minutes', ctx), { kind: 'start', minutes: 15 })
  assert.deepEqual(intentOf('Walk me home', ctx), { kind: 'start', minutes: undefined })
  assert.equal(parseInterval('every half an hour'), 30)
  assert.equal(parseInterval('every hour'), 60)
  assert.equal(parseInterval('every 2 hours'), 120)
})

test('"tell them ..." sends a message to the circle, "tell me" does not', () => {
  assert.deepEqual(intentOf("Tell them I'm running late", ctx), { kind: 'tell', message: "i'm running late" })
  assert.deepEqual(intentOf('Let them know that I got the train', ctx), { kind: 'tell', message: 'i got the train' })
  assert.notEqual(intentOf('Tell me a joke', ctx).kind, 'tell')
})
