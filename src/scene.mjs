// The shared fake-camera scene. One clip is reused by every simulated
// participant, so it is worth drawing properly: flowing aurora ribbons behind a
// circular audio visualiser, with a small broadcast HUD. Modern and calm — it
// should look like a real feed in a tile, not a cartoon.
import { Canvas, hsl } from './canvas.mjs'
import { FONT } from './font.mjs'

const TAU = Math.PI * 2

// Matches the dashboard: violet primary, teal secondary.
const VIOLET = [109, 94, 252]
const VIOLET_LIGHT = [139, 124, 255]
const TEAL = [34, 211, 165]
const WHITE = [255, 255, 255]

const drawText = (canvas, text, x, topY, scale, color, alpha = 1) => {
  let cursor = x
  for (const char of text.toUpperCase()) {
    const glyph = FONT[char] ?? FONT[' ']
    for (let row = 0; row < 7; row += 1) {
      for (let col = 0; col < 5; col += 1) {
        if (glyph[row][col] === '1') {
          canvas.rect(cursor + col * scale, topY + row * scale, scale, scale, color, alpha)
        }
      }
    }
    cursor += 6 * scale
  }
}

const textWidth = (text, scale) => text.length * 6 * scale - scale

const mix = (a, b, t) => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

// A ribbon of colour that undulates across the frame.
const ribbon = (canvas, { t, yBase, amp, freq, phase, thickness, color, alpha }) => {
  const { width: W } = canvas
  for (let x = 0; x < W; x += 1) {
    const nx = x / W
    const y =
      yBase +
      Math.sin(nx * TAU * freq + phase + t * TAU) * amp +
      Math.sin(nx * TAU * freq * 0.5 + phase * 1.7 - t * TAU * 0.6) * amp * 0.45
    // soft vertical falloff instead of a hard band
    for (let dy = -thickness; dy <= thickness; dy += 1) {
      const fade = 1 - Math.abs(dy) / thickness
      canvas.blend(x, Math.round(y + dy), color, alpha * fade * fade)
    }
  }
}

export const drawFrame = (canvas, t) => {
  const { width: W, height: H } = canvas
  const s = H / 1080 // authored at 1080p, scales to any size

  // --- backdrop -------------------------------------------------------------
  canvas.gradient([14, 15, 24], [7, 8, 12])

  // drifting glow, low and wide
  const glowX = W * (0.5 + 0.22 * Math.sin(t * TAU))
  const glowY = H * (0.45 + 0.12 * Math.cos(t * TAU * 0.8))
  canvas.glow(glowX, glowY, W * 0.55, H * 0.62, VIOLET, 0.30)
  canvas.glow(W - glowX, H - glowY * 0.6, W * 0.4, H * 0.45, TEAL, 0.16)

  // --- aurora ribbons -------------------------------------------------------
  const bands = [
    { yBase: H * 0.30, amp: 58, freq: 1.4, phase: 0.0, thickness: 46, color: VIOLET, alpha: 0.5 },
    { yBase: H * 0.44, amp: 74, freq: 1.1, phase: 1.9, thickness: 34, color: VIOLET_LIGHT, alpha: 0.42 },
    { yBase: H * 0.68, amp: 66, freq: 1.7, phase: 3.4, thickness: 40, color: TEAL, alpha: 0.32 },
    { yBase: H * 0.80, amp: 46, freq: 2.1, phase: 5.1, thickness: 26, color: VIOLET, alpha: 0.3 },
  ]
  for (const band of bands) {
    ribbon(canvas, {
      t,
      yBase: band.yBase,
      amp: band.amp * s,
      freq: band.freq,
      phase: band.phase,
      thickness: Math.max(2, Math.round(band.thickness * s)),
      color: band.color,
      alpha: band.alpha,
    })
  }

  // --- drifting particles ---------------------------------------------------
  for (let i = 0; i < 46; i += 1) {
    const seed = i * 0.6180339887
    const speed = 0.18 + (i % 7) * 0.06
    const y = H * (1.1 - ((t * speed + seed) % 1) * 1.25)
    const x = W * ((seed * 2.7) % 1)
    const r = (1.4 + (i % 4) * 1.6) * s
    canvas.circle(x, y, r, i % 3 === 0 ? TEAL : WHITE, 0.32)
  }

  // --- circular visualiser --------------------------------------------------
  const cx = W / 2
  const cy = H * 0.5
  const inner = 168 * s
  const bars = 64
  for (let i = 0; i < bars; i += 1) {
    const angle = (i / bars) * TAU - Math.PI / 2
    // layered sines give an organic, never-repeating-looking pulse
    const level =
      0.34 +
      0.34 * Math.sin(i * 0.55 + t * TAU * 2) +
      0.22 * Math.sin(i * 1.31 - t * TAU * 3) +
      0.14 * Math.sin(i * 2.7 + t * TAU * 1.4)
    const length = Math.max(12 * s, level * 128 * s)
    const color = mix(VIOLET_LIGHT, TEAL, (i / bars + t) % 1)
    const barW = Math.max(1.6, 5 * s)
    const steps = Math.max(2, Math.round(length / (barW * 0.9)))
    for (let step = 0; step <= steps; step += 1) {
      const r = inner + (length * step) / steps
      canvas.circle(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r, barW, color, 0.85)
    }
  }

  // core: soft halo, ring, and a slow breathing centre
  const breathe = 0.5 + 0.5 * Math.sin(t * TAU * 2)
  canvas.glow(cx, cy, inner * 2.1, inner * 2.1, VIOLET_LIGHT, 0.3 + 0.08 * breathe)
  canvas.ring(cx, cy, inner, 2 * s, VIOLET_LIGHT, 0.6)
  canvas.circle(cx, cy, (54 + breathe * 10) * s, WHITE, 0.9)
  canvas.circle(cx, cy, (78 + breathe * 14) * s, VIOLET_LIGHT, 0.28)

  // expanding pulse ring, once per second-ish
  const pulse = (t * 4) % 1
  canvas.ring(cx, cy, inner + pulse * 300 * s, 3 * s, TEAL, 0.5 * (1 - pulse))

  // --- HUD ------------------------------------------------------------------
  const scale = Math.max(2, Math.round(4 * s))
  const pad = 52 * s

  // live dot + label, top left
  const blink = 0.55 + 0.45 * Math.sin(t * TAU * 4)
  canvas.circle(pad + 8 * s, pad + 12 * s, 9 * s, [255, 92, 92], blink)
  drawText(canvas, 'LIVE', pad + 30 * s, pad + 5 * s, scale, WHITE, 0.92)

  // timecode, top right — proves the stream is moving
  const totalMs = Math.round(t * 6000)
  const secs = String(Math.floor(totalMs / 1000)).padStart(2, '0')
  const frames = String(Math.floor((totalMs % 1000) / 40)).padStart(2, '0')
  const tc = `00:${secs}:${frames}`
  drawText(canvas, tc, W - pad - textWidth(tc, scale), pad + 5 * s, scale, WHITE, 0.75)

  // caption strip, bottom
  const label = 'CALL BOTS'
  const labelScale = Math.max(2, Math.round(5 * s))
  const lw = textWidth(label, labelScale)
  canvas.roundRect(
    (W - lw) / 2 - 30 * s,
    H - pad - 30 * s,
    lw + 60 * s,
    7 * labelScale + 30 * s,
    (7 * labelScale + 30 * s) / 2,
    [255, 255, 255],
    0.08,
  )
  drawText(canvas, label, (W - lw) / 2, H - pad - 15 * s, labelScale, WHITE, 0.82)
}

export const renderScene = ({ width, height, fps, seconds, onProgress }) => {
  const canvas = new Canvas(width, height)
  const totalFrames = Math.round(fps * seconds)
  const frameHeader = Buffer.from('FRAME\n')
  const chunks = [Buffer.from(`YUV4MPEG2 W${width} H${height} F${fps}:1 Ip A1:1 C420\n`)]
  for (let n = 0; n < totalFrames; n += 1) {
    drawFrame(canvas, n / totalFrames)
    chunks.push(frameHeader, canvas.toYuv420())
    if (onProgress && n % 10 === 0) onProgress(n, totalFrames)
  }
  return Buffer.concat(chunks)
}
