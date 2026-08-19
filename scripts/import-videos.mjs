// Turns real video files into camera clips the bots publish.
//
// Chrome's fake camera reads Y4M or MJPEG. Y4M at 1080p30 is about 93 MB per
// second of footage, so clips are written as MJPEG: same resolution and frame
// rate, roughly a twentieth of the size. Needs ffmpeg on PATH.
//
//   node scripts/import-videos.mjs ~/Downloads/meeting-clips
//
// Every video in that folder becomes clip-1, clip-2 … in fixture order. Bots
// cycle through whatever clips exist; anything missing falls back to a drawn
// clip, so a partial set is fine.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const { fixturesDir } = await import('../src/config.mjs')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const source = process.argv[2] && !process.argv[2].startsWith('--') ? resolve(process.argv[2]) : null
const SECONDS = Number(arg('seconds', '8'))
const FPS = Number(arg('fps', '30'))
const SIZE = arg('size', '1920x1080')
const START = Number(arg('start', '0'))
const QUALITY = arg('quality', '3') // ffmpeg -q:v, lower is better
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.ogv'])

if (!source || !existsSync(source)) {
  console.error(`usage: node scripts/import-videos.mjs <folder-with-videos> [--seconds 8] [--fps 30] [--size 1920x1080] [--start 0]

Put a handful of clips in a folder — people talking to camera works best —
and they become the faces the bots publish.`)
  process.exit(1)
}

try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'pipe' })
} catch {
  console.error('ffmpeg is required: brew install ffmpeg')
  process.exit(1)
}

const files = readdirSync(source)
  .filter((name) => VIDEO_EXT.has(extname(name).toLowerCase()))
  .sort()
if (files.length === 0) {
  console.error(`no video files in ${source}`)
  process.exit(1)
}

const [width, height] = SIZE.split('x').map(Number)
mkdirSync(fixturesDir, { recursive: true })

for (const [index, name] of files.entries()) {
  const out = join(fixturesDir, `clip-${index + 1}-${width}x${height}-${FPS}fps-${SECONDS}s.mjpeg`)
  const tmp = `${out}.part`
  process.stdout.write(`${index + 1}/${files.length} ${name} … `)
  const started = Date.now()
  try {
    await run('ffmpeg', [
      '-y', '-loglevel', 'error',
      '-ss', String(START),
      '-i', join(source, name),
      '-t', String(SECONDS),
      '-an',
      // fill the frame without distorting the source
      '-vf', `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${FPS}`,
      '-c:v', 'mjpeg', '-q:v', QUALITY, '-pix_fmt', 'yuvj420p',
      '-f', 'mjpeg', tmp,
    ], { maxBuffer: 32 * 1024 * 1024 })
    renameSync(tmp, out)
    console.log(`ok (${((Date.now() - started) / 1000).toFixed(0)}s)`)
  } catch (error) {
    rmSync(tmp, { force: true })
    console.log(`failed: ${String(error.stderr ?? error.message).trim().split('\n').pop()}`)
  }
}
console.log(`\nclips written to ${fixturesDir}`)
console.log('bots use clip-1 … clip-5 in order; restart a session to pick them up')
