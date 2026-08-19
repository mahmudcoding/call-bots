import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fixturesDir } from './config.mjs'
import { plain as log } from './log.mjs'
import { renderScene } from './scene.mjs'
import { listVoices, synthesizeSpeech } from './tts.mjs'
import { assembleCycle, encodeWav, synthesizeToneBurst } from './wav.mjs'

// Accent colours for the dashboard cards (the video itself is shared).
const COLORS = [
  [0x6d, 0x5e, 0xfc], [0x22, 0xd3, 0xa5], [0xff, 0xb2, 0x24], [0xf4, 0x72, 0xb6],
  [0x38, 0xbd, 0xf8], [0xa7, 0x8b, 0xfa], [0xfb, 0x92, 0x3c], [0x4a, 0xde, 0x80],
]
export const guestColorHex = (index) =>
  `#${COLORS[index % COLORS.length].map((v) => v.toString(16).padStart(2, '0')).join('')}`

// Each guest speaks inside its own slot of a shared cycle, so looped playback
// rotates the active speaker. Guest count is open-ended, hence a fixed cycle.
const SLOT_S = 10
const SPEECH_S = 8
const CYCLE_S = 60

const LINES = [
  'Hello, can everyone hear me? I will keep this brief.',
  'Sorry I am late, my calendar did not remind me.',
  'That makes sense to me. Happy to help with the next step.',
  'Quick question before we move on, and then I will hand it back.',
  'I can take that one. I will follow up after this call.',
  'Agreed. Let us keep it simple and review it next week.',
  'I am seeing the shared screen clearly on my side.',
  'Good point. I had not thought about it that way.',
]

export const ensureSharedVideo = ({ size = '1920x1080', fps = 12, seconds = 6 } = {}) => {
  const [width, height] = size.split('x').map(Number)
  if (!width || !height || width % 2 || height % 2) {
    throw new Error(`--size must be even WxH dimensions, got "${size}" (Chrome requires C420)`)
  }
  const out = join(fixturesDir, `scene-${width}x${height}-${fps}fps-${seconds}s.y4m`)
  if (existsSync(out)) return out
  mkdirSync(fixturesDir, { recursive: true })
  log.info(`rendering the shared ${width}x${height} camera video…`)
  const started = Date.now()
  const buffer = renderScene({ width, height, fps, seconds })
  writeFileSync(out, buffer)
  log.info(
    `camera video ready (${(buffer.length / 1024 / 1024).toFixed(0)} MB, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s)`,
  )
  return out
}

// Returns Map<slug, {video, audio}>: one shared clip, one voice per guest.
export const ensureGuestFixtures = async (guests, options = {}) => {
  if (options.regen) rmSync(fixturesDir, { recursive: true, force: true })
  mkdirSync(fixturesDir, { recursive: true })
  const video = ensureSharedVideo(options)
  const voices = await listVoices()

  const result = new Map()
  for (const guest of guests) {
    const audio = join(fixturesDir, `bot-${guest.n}.wav`)
    if (!existsSync(audio)) {
      const line = LINES[(guest.n - 1) % LINES.length]
      const voice = voices.length ? voices[(guest.n - 1) % voices.length] : null
      let speech = null
      try {
        speech = await synthesizeSpeech(line, voice)
      } catch (error) {
        log.warn(`speech synthesis failed for ${guest.label}: ${error.message}`)
      }
      if (!speech) speech = synthesizeToneBurst(guest.n, SPEECH_S)
      const offset = ((guest.n - 1) * SLOT_S) % CYCLE_S
      writeFileSync(audio, encodeWav(assembleCycle(speech, offset, CYCLE_S, SPEECH_S)))
    }
    result.set(guest.slug, { video, audio })
  }
  return result
}
