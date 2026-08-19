import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fixturesDir } from './config.mjs'
import { plain as log } from './log.mjs'
import { renderScene } from './scene.mjs'
import { listVoices, synthesizeSpeech } from './tts.mjs'
import { assembleCycle, encodeWav, synthesizeToneBurst } from './wav.mjs'

// Dashboard accent colors (the video itself is shared, so these are what tell
// participants apart in the UI).
const BG_COLORS = [
  [0x1f, 0x6f, 0x8b], [0x8b, 0x1f, 0x4f], [0x3a, 0x7d, 0x2c], [0x6b, 0x4f, 0xa0],
  [0xb0, 0x65, 0x1a], [0x21, 0x86, 0x7a], [0x9c, 0x2b, 0x2b], [0x2b, 0x4c, 0x9c],
  [0x77, 0x71, 0x24], [0x54, 0x34, 0x5c],
]
const GUEST_COLORS = [
  [0x3d, 0x4a, 0x5c], [0x4a, 0x3d, 0x5c], [0x3d, 0x5c, 0x55], [0x5c, 0x4a, 0x3d],
  [0x45, 0x52, 0x6b], [0x52, 0x45, 0x6b], [0x35, 0x4f, 0x4a], [0x6b, 0x52, 0x45],
]
const hex = (rgb) => `#${rgb.map((v) => v.toString(16).padStart(2, '0')).join('')}`
export const userColorHex = (index) => hex(BG_COLORS[index % BG_COLORS.length])
export const guestColorHex = (index) => hex(GUEST_COLORS[index % GUEST_COLORS.length])

// Audio timing: each participant speaks inside their own slot of a shared
// cycle, so looped playback rotates the active speaker.
const SLOT_S = 10
const SPEECH_S = 8
const GUEST_CYCLE_S = 60

// Lines worth overhearing. Index picks one, so a roster sounds like a real
// (bad) meeting rather than a hundred clones.
const LINES = [
  'Sorry, I was on mute. What I said was, brilliant. Truly brilliant.',
  'Can everyone see my screen? No? How about now? How about now?',
  'I think we should take this one offline and circle back.',
  'Quick question, and then I promise I will let you all go.',
  'You are breaking up. I only caught the part where you volunteered me.',
  'My camera is on, which is why I am wearing a shirt today.',
  'Let me just share my screen. Ignore the seventy open tabs.',
  'I have a hard stop at the top of the hour, so let us speed run this.',
  'That is a great point. I am going to pretend I thought of it.',
  'The dog has opinions about this agenda item.',
  'To be honest, this meeting could have been an email. A short one.',
  'I will drop a link in the chat that nobody will click.',
]
const GUEST_LINES = [
  'Hi, I am a guest. I have no idea what this meeting is about.',
  'I clicked a link and now I am here. Hello, everyone.',
  'I joined as a guest, so please do not ask me any questions.',
  'Sorry, wrong meeting. I am staying anyway. This looks fun.',
]

// --- video: ONE shared clip for every participant ---------------------------

export const ensureSharedVideo = ({ size = '1920x1080', fps = 12, seconds = 6 } = {}) => {
  const [width, height] = size.split('x').map(Number)
  if (!width || !height || width % 2 || height % 2) {
    throw new Error(`--size must be even WxH dimensions, got "${size}" (Chrome requires C420)`)
  }
  const out = join(fixturesDir, `scene-${width}x${height}-${fps}fps-${seconds}s.y4m`)
  if (existsSync(out)) return out
  mkdirSync(fixturesDir, { recursive: true })
  log.info(`rendering shared ${width}x${height} camera scene (${seconds}s @ ${fps}fps)…`)
  const started = Date.now()
  const buffer = renderScene({
    width,
    height,
    fps,
    seconds,
    onProgress: (n, total) => {
      if (n > 0) log.info(`  frame ${n}/${total}`)
    },
  })
  writeFileSync(out, buffer)
  log.info(
    `shared scene ready: ${out} (${(buffer.length / 1024 / 1024).toFixed(0)} MB, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s)`,
  )
  return out
}

// --- audio: per participant, distinct voice + distinct line -----------------

const buildAudio = async ({ file, line, voice, offset, cycle, fallbackIndex }) => {
  if (existsSync(file)) return file
  let speech = null
  try {
    speech = await synthesizeSpeech(line, voice)
  } catch (error) {
    log.warn(`speech synthesis failed (${error.message})`)
  }
  if (!speech) speech = synthesizeToneBurst(fallbackIndex, SPEECH_S)
  writeFileSync(file, encodeWav(assembleCycle(speech, offset, cycle, SPEECH_S)))
  return file
}

const voiceFor = (voices, index) => (voices.length ? voices[index % voices.length] : null)

export const ensureFixtures = async (users, options = {}) => {
  if (options.regen) rmSync(fixturesDir, { recursive: true, force: true })
  mkdirSync(fixturesDir, { recursive: true })
  const video = ensureSharedVideo(options)
  const voices = await listVoices()
  const cycle = Math.max(users.length, 1) * SLOT_S

  const result = new Map()
  for (const user of users) {
    const voice = voiceFor(voices, user.index)
    const audio = await buildAudio({
      file: join(fixturesDir, `${user.slug}-${user.index + 1}of${users.length}.wav`),
      line: LINES[user.index % LINES.length],
      voice,
      offset: user.index * SLOT_S,
      cycle,
      fallbackIndex: user.index,
    })
    result.set(user.slug, { video, audio })
  }
  log.info(`fixtures ready for ${users.length} user(s)${voices.length ? ` (${Math.min(users.length, voices.length)} distinct voices)` : ''}`)
  return result
}

export const ensureGuestFixtures = async (guests, options = {}) => {
  mkdirSync(fixturesDir, { recursive: true })
  const video = ensureSharedVideo(options)
  const voices = await listVoices()

  const result = new Map()
  for (const guest of guests) {
    const audio = await buildAudio({
      file: join(fixturesDir, `guest-${guest.n}.wav`),
      line: GUEST_LINES[(guest.n - 1) % GUEST_LINES.length],
      // offset guests into the voice list so they do not echo user 1
      voice: voiceFor(voices, guest.n + 5),
      offset: ((guest.n - 1) * SLOT_S) % GUEST_CYCLE_S,
      cycle: GUEST_CYCLE_S,
      fallbackIndex: guest.n + 3,
    })
    result.set(guest.slug, { video, audio })
  }
  return result
}
