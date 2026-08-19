// Rebuilds the voices that ship with the app, one per clip, from the passages
// in src/fixtures.mjs using the best male voices this machine has.
//
//   node scripts/make-voices.mjs
//
// macOS ships a compact version of each voice and downloads a much better one
// on request. If you install those — System Settings › Accessibility › Spoken
// Content › System Voice › Manage Voices, look for "Enhanced" or "Premium" —
// rerun this and the bots pick them up automatically.
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Set the home before importing config: it reads the variable once, at import,
// and everything downstream resolves against whatever it saw then.
const scratch = join(tmpdir(), `call-bots-voices-${process.pid}`)
process.env.CALL_BOTS_HOME = scratch

const { bundledMediaDir } = await import('../src/config.mjs')

const { listVoices } = await import('../src/tts.mjs')
const { ensureGuestFixtures, THEME_COUNT } = await import('../src/fixtures.mjs')

const voices = await listVoices()
if (voices.length === 0) {
  console.error('no system voices found — nothing to build')
  process.exit(1)
}
console.log('using:')
for (let i = 0; i < THEME_COUNT; i += 1) {
  console.log(`  voice-${i + 1}  ${voices[i % voices.length]}`)
}

mkdirSync(bundledMediaDir, { recursive: true })
for (let i = 1; i <= THEME_COUNT; i += 1) rmSync(join(bundledMediaDir, `voice-${i}.wav`), { force: true })

const bots = Array.from({ length: THEME_COUNT }, (_, i) => ({ n: i + 1, slug: `bot-${i + 1}` }))
await ensureGuestFixtures(bots, {})

for (let i = 1; i <= THEME_COUNT; i += 1) {
  copyFileSync(join(scratch, 'fixtures', `bot-${i}.wav`), join(bundledMediaDir, `voice-${i}.wav`))
}
rmSync(scratch, { recursive: true, force: true })

const built = readdirSync(bundledMediaDir).filter((n) => /^voice-\d+\.wav$/u.test(n)).sort()
console.log(`\nwrote ${built.length} voice(s) to ${bundledMediaDir}`)
