import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { fixturesDir } from './config.mjs'
import { plain as log } from './log.mjs'
import { synthesizeSpeech } from './tts.mjs'
import { assembleCycle, encodeWav, synthesizeToneBurst } from './wav.mjs'

// Distinct background colors (RGB) so tiles are tellable at a glance.
const BG_COLORS = [
  [0x1f, 0x6f, 0x8b], [0x8b, 0x1f, 0x4f], [0x3a, 0x7d, 0x2c], [0x6b, 0x4f, 0xa0],
  [0xb0, 0x65, 0x1a], [0x21, 0x86, 0x7a], [0x9c, 0x2b, 0x2b], [0x2b, 0x4c, 0x9c],
  [0x77, 0x71, 0x24], [0x54, 0x34, 0x5c],
]

// The dashboard reuses each user's fixture background color as their accent.
export const userColorHex = (index) => {
  const [r, g, b] = BG_COLORS[index % BG_COLORS.length]
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

// Audio timing: each user speaks for up to SPEECH_S inside their own SLOT_S
// window of a shared N-slot cycle, so looped playback rotates the active
// speaker. Browser processes start at different moments, so rotation is
// approximate, not phase-locked — SPEECH_S < SLOT_S keeps overlap unlikely.
const SLOT_S = 10
const SPEECH_S = 8

// --- pure-Node y4m rendering (the local ffmpeg lacks drawtext) --------------

const FONT = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  C: ['01110', '10001', '10000', '10000', '10000', '10001', '01110'],
  D: ['11100', '10010', '10001', '10001', '10001', '10010', '11100'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  G: ['01110', '10001', '10000', '10111', '10001', '10001', '01111'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  I: ['01110', '00100', '00100', '00100', '00100', '00100', '01110'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  L: ['10000', '10000', '10000', '10000', '10000', '10000', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  U: ['10001', '10001', '10001', '10001', '10001', '10001', '01110'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  X: ['10001', '10001', '01010', '00100', '01010', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  Z: ['11111', '00001', '00010', '00100', '01000', '10000', '11111'],
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  '-': ['00000', '00000', '00000', '01110', '00000', '00000', '00000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
}

const rgbToYuv = ([r, g, b]) => [
  Math.round(16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256),
  Math.round(128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256),
  Math.round(128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256),
]

class Frame {
  constructor(width, height, yuv) {
    this.width = width
    this.height = height
    this.ySize = width * height
    this.cWidth = width / 2
    this.cSize = (width / 2) * (height / 2)
    this.data = Buffer.alloc(this.ySize + 2 * this.cSize)
    this.data.fill(yuv[0], 0, this.ySize)
    this.data.fill(yuv[1], this.ySize, this.ySize + this.cSize)
    this.data.fill(yuv[2], this.ySize + this.cSize)
  }

  setPixel(x, y, lumaValue) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return
    this.data[y * this.width + x] = lumaValue
    const cIndex = (y >> 1) * this.cWidth + (x >> 1)
    this.data[this.ySize + cIndex] = 128
    this.data[this.ySize + this.cSize + cIndex] = 128
  }

  fillRect(x0, y0, w, h, lumaValue) {
    for (let y = y0; y < y0 + h; y += 1) {
      for (let x = x0; x < x0 + w; x += 1) this.setPixel(x, y, lumaValue)
    }
  }

  drawText(text, centerX, topY, scale) {
    const glyphW = 6 * scale
    let x = Math.round(centerX - (text.length * glyphW - scale) / 2)
    for (const char of text.toUpperCase()) {
      const glyph = FONT[char] ?? FONT[' ']
      for (let row = 0; row < 7; row += 1) {
        for (let col = 0; col < 5; col += 1) {
          if (glyph[row][col] === '1') {
            this.fillRect(x + col * scale, topY + row * scale, scale, scale, 235)
          }
        }
      }
      x += glyphW
    }
  }

  clone() {
    const copy = Object.create(Frame.prototype)
    Object.assign(copy, this, { data: Buffer.from(this.data) })
    return copy
  }
}

const generateVideo = (user, { width, height, fps, seconds }) => {
  const out = join(fixturesDir, `${user.slug}-${width}x${height}-${fps}.y4m`)
  if (existsSync(out)) return out

  const label = user.label.toUpperCase().replace(/[^A-Z0-9 -]/gu, '') || 'USER'
  const base = new Frame(width, height, rgbToYuv(BG_COLORS[user.index % BG_COLORS.length]))
  base.drawText(`SIM ${user.index + 1}`, width / 2, 20, 3)
  const labelScale = Math.max(4, Math.min(10, Math.floor((width * 0.8) / (label.length * 6))))
  base.drawText(label, width / 2, Math.round(height / 2 - 3.5 * labelScale), labelScale)

  const totalFrames = fps * seconds
  const chunks = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420\n`)]
  const frameHeader = Buffer.from('FRAME\n')
  const barWidth = 48
  for (let n = 0; n < totalFrames; n += 1) {
    const frame = base.clone()
    // running counter + sweeping bar prove the tile is live, not frozen
    frame.drawText(String(n).padStart(3, '0'), width / 2, height - 90, 4)
    const barX = Math.round((n / (totalFrames - 1)) * (width - barWidth))
    frame.fillRect(barX, height - 28, barWidth, 16, 235)
    chunks.push(frameHeader, frame.data)
  }
  writeFileSync(out, Buffer.concat(chunks))
  log.info(`fixture video ${out}`)
  return out
}

// --- audio (pure Node assembly; system TTS with tone fallback) --------------

const generateAudio = async (user, total) => {
  const out = join(fixturesDir, `${user.slug}-${user.index + 1}of${total}.wav`)
  if (existsSync(out)) return out
  const phrase =
    `Hello! I am ${user.label.replace(/[^A-Za-z0-9 -]/gu, '')}, simulated participant ` +
    `number ${user.index + 1} of ${total}. I am publishing real audio and video ` +
    `from a synthetic device.`
  let speech = null
  try {
    speech = await synthesizeSpeech(phrase)
  } catch (error) {
    log.warn(`speech synthesis failed for ${user.label} (${error.message})`)
  }
  if (!speech) {
    log.info(`no system text-to-speech — using tone melody for ${user.label}`)
    speech = synthesizeToneBurst(user.index, SPEECH_S)
  }
  const cycle = assembleCycle(speech, user.index * SLOT_S, total * SLOT_S, SPEECH_S)
  writeFileSync(out, encodeWav(cycle))
  log.info(`fixture audio ${out}`)
  return out
}

// Guests get their own slate-toned palette so they read as a distinct class in
// the call grid, and a fixed 60s audio cycle (their count is open-ended, so the
// cycle cannot depend on a roster size).
const GUEST_COLORS = [
  [0x3d, 0x4a, 0x5c], [0x4a, 0x3d, 0x5c], [0x3d, 0x5c, 0x55], [0x5c, 0x4a, 0x3d],
  [0x45, 0x52, 0x6b], [0x52, 0x45, 0x6b], [0x35, 0x4f, 0x4a], [0x6b, 0x52, 0x45],
]
const GUEST_CYCLE_S = 60

export const guestColorHex = (index) => {
  const [r, g, b] = GUEST_COLORS[index % GUEST_COLORS.length]
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
}

const generateGuestVideo = (guest, { width, height, fps, seconds }) => {
  const out = join(fixturesDir, `guest-${guest.n}-${width}x${height}-${fps}.y4m`)
  if (existsSync(out)) return out
  const base = new Frame(width, height, rgbToYuv(GUEST_COLORS[(guest.n - 1) % GUEST_COLORS.length]))
  base.drawText('GUEST', width / 2, 20, 3)
  const label = String(guest.n)
  const scale = Math.max(6, Math.min(12, Math.floor((width * 0.5) / (label.length * 6))))
  base.drawText(label, width / 2, Math.round(height / 2 - 3.5 * scale), scale)

  const totalFrames = fps * seconds
  const chunks = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420\n`)]
  const frameHeader = Buffer.from('FRAME\n')
  const barWidth = 48
  for (let n = 0; n < totalFrames; n += 1) {
    const frame = base.clone()
    frame.drawText(String(n).padStart(3, '0'), width / 2, height - 90, 4)
    const barX = Math.round((n / (totalFrames - 1)) * (width - barWidth))
    frame.fillRect(barX, height - 28, barWidth, 16, 235)
    chunks.push(frameHeader, frame.data)
  }
  writeFileSync(out, Buffer.concat(chunks))
  log.info(`fixture video ${out}`)
  return out
}

const generateGuestAudio = async (guest) => {
  const out = join(fixturesDir, `guest-${guest.n}.wav`)
  if (existsSync(out)) return out
  let speech = null
  try {
    speech = await synthesizeSpeech(`Hello, I am guest number ${guest.n}.`)
  } catch {
    /* fall through to tones */
  }
  if (!speech) speech = synthesizeToneBurst(guest.n + 3, SPEECH_S)
  // slots wrap inside a fixed cycle: guests are unbounded in number
  const offset = ((guest.n - 1) * SLOT_S) % GUEST_CYCLE_S
  writeFileSync(out, encodeWav(assembleCycle(speech, offset, GUEST_CYCLE_S, SPEECH_S)))
  log.info(`fixture audio ${out}`)
  return out
}

export const ensureGuestFixtures = async (guests, options = {}) => {
  const { size = '640x360', fps = 12, seconds = 8 } = options
  const [width, height] = size.split('x').map(Number)
  mkdirSync(fixturesDir, { recursive: true })
  const result = new Map()
  for (const guest of guests) {
    result.set(guest.slug, {
      video: generateGuestVideo(guest, { width, height, fps, seconds }),
      audio: await generateGuestAudio(guest),
    })
  }
  return result
}

// Returns Map<slug, {video, audio}>. Cached by file name; --regen wipes first.
export const ensureFixtures = async (users, options = {}) => {
  const { size = '640x360', fps = 12, seconds = 8, regen = false } = options
  const [width, height] = size.split('x').map(Number)
  if (!width || !height || width % 2 || height % 2) {
    throw new Error(`--size must be even WxH dimensions, got "${size}" (Chrome requires C420)`)
  }
  if (regen) rmSync(fixturesDir, { recursive: true, force: true })
  mkdirSync(fixturesDir, { recursive: true })

  const result = new Map()
  for (const user of users) {
    const video = generateVideo(user, { width, height, fps, seconds })
    const audio = await generateAudio(user, users.length)
    result.set(user.slug, { video, audio })
  }
  return result
}
