// Unit checks for the parts of a bot's behaviour that decide things rather
// than drive a browser — the logic worth being sure about without a call in
// front of it.
//
// The one rule this file exists to pin: a bot whose camera has gone quiet gets
// healed, and a bot that is merely idle, muted, or unmeasured never does. A
// watchdog that fires on a healthy bot is worse than no watchdog: it would
// republish working cameras every few seconds for the whole call.
//
//   node scripts/test-guest.mjs
import { DARK_NOTE, videoHealthStep } from '../src/guest.mjs'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const T0 = 1_000_000
const DARK_MS = 12_000
// A bot in the call, camera on, publishing nothing — the shape under test.
const dark = (over = {}) => ({
  inCall: true, camOn: true, upV: 0, darkSince: null, attempts: 0, now: T0, ...over,
})

console.log('\nnothing to judge')
for (const [name, over] of [
  ['a bot that is not in the call yet', { inCall: false }],
  ['a camera that was deliberately left off', { camOn: false }],
  ['a bot with no stats yet — unmeasured is not failing', { upV: null }],
  ['a bot whose stats went away entirely', { upV: undefined }],
]) {
  const step = videoHealthStep(dark(over))
  check(name, step.action === 'none' && step.darkSince === null, JSON.stringify(step))
}

console.log('\na healthy camera')
const healthy = videoHealthStep(dark({ upV: 420, darkSince: T0 - 60_000, attempts: 2 }))
check('carrying video clears the clock and the attempts',
  healthy.action === 'none' && healthy.darkSince === null && healthy.attempts === 0,
  JSON.stringify(healthy))

console.log('\na camera going quiet')
const first = videoHealthStep(dark())
check('the first quiet tick only starts the clock',
  first.action === 'none' && first.darkSince === T0, JSON.stringify(first))
const brief = videoHealthStep(dark({ darkSince: T0, now: T0 + DARK_MS - 1 }))
check('a blip shorter than the window is left alone',
  brief.action === 'none' && brief.darkSince === T0, JSON.stringify(brief))

console.log('\nescalation, one step per window')
const step1 = videoHealthStep(dark({ darkSince: T0, now: T0 + DARK_MS }))
check('the window closing recycles the camera — the step that actually heals',
  step1.action === 'recycle' && step1.attempts === 1 && step1.darkSince === T0 + DARK_MS,
  JSON.stringify(step1))
const between = videoHealthStep(dark({ darkSince: step1.darkSince, attempts: 1, now: T0 + DARK_MS + 5 }))
check('the next step waits a full window for the last one to work',
  between.action === 'none' && between.attempts === 1, JSON.stringify(between))
const step2 = videoHealthStep(dark({ darkSince: step1.darkSince, attempts: 1, now: T0 + 2 * DARK_MS }))
check('still quiet, so it rejoins — the only step that rebuilds the connection',
  step2.action === 'rejoin' && step2.attempts === 2, JSON.stringify(step2))
const step3 = videoHealthStep(dark({ darkSince: step2.darkSince, attempts: 2, now: T0 + 3 * DARK_MS }))
check('out of moves, it says so once',
  step3.action === 'giveup' && step3.attempts === 3, JSON.stringify(step3))
const step4 = step3

console.log('\nafter giving up')
const after = videoHealthStep(dark({ darkSince: step4.darkSince, attempts: 4, now: T0 + 9 * DARK_MS }))
check('a bot that is never coming back is not thrashed forever',
  after.action === 'none' && after.attempts === 4, JSON.stringify(after))
const back = videoHealthStep(dark({ upV: 300, darkSince: step4.darkSince, attempts: 4 }))
check('and recovering rearms the whole thing',
  back.action === 'none' && back.darkSince === null && back.attempts === 0, JSON.stringify(back))

console.log('\nthe notice')
check('the give-up notice names the consequence, not the mechanism',
  /cannot see this bot/u.test(DARK_NOTE) && !/kbps|encoder|rtp/iu.test(DARK_NOTE), DARK_NOTE)

const passed = results.filter((r) => r.pass).length
console.log(`\n${passed}/${results.length} checks passed`)
process.exit(passed === results.length ? 0 : 1)
