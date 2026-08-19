import { execFile } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { decodeWav } from './wav.mjs'

const run = promisify(execFile)

// Which system TTS is available? Resolved once; 'tones' means none.
let cachedEngine = null
export const detectTtsEngine = async () => {
  if (cachedEngine) return cachedEngine
  if (process.platform === 'darwin') {
    cachedEngine = 'say'
  } else if (process.platform === 'win32') {
    cachedEngine = 'powershell'
  } else {
    for (const bin of ['espeak-ng', 'espeak']) {
      try {
        await run(bin, ['--version'])
        cachedEngine = bin
        break
      } catch {
        /* try next */
      }
    }
    cachedEngine ??= 'tones'
  }
  return cachedEngine
}

// Distinct voices make a roster sound like different people. Only macOS `say`
// exposes a usable set; elsewhere everyone shares the default voice.
let cachedVoices = null
export const listVoices = async () => {
  if (cachedVoices) return cachedVoices
  const engine = await detectTtsEngine()
  if (engine !== 'say') {
    cachedVoices = []
    return cachedVoices
  }
  try {
    const { stdout } = await run('say', ['-v', '?'])
    const all = stdout
      .split('\n')
      .filter((line) => /\ben_/u.test(line))
      .map((line) => line.trim().split(/\s{2,}|\s(?=[a-z]{2}_)/u)[0].trim())
      .filter(Boolean)
    // Male voices only: the footage is five men, and a man on screen speaking
    // with a woman's voice is the first thing anyone notices. Ordered by how
    // much each one sounds like a person — everything outside this list (Fred,
    // Junior, Zarvox and friends) reads as a robot.
    const natural = ['Alex', 'Tom', 'Daniel', 'Rishi', 'Aman', 'Reed', 'Rocko', 'Eddy', 'Grandpa']
    const baseName = (voice) => voice.replace(/\s*\(.*\)$/u, '').trim()
    // Apple ships a compact version of each voice and downloads a far better
    // one on request, named "(Enhanced)" or "(Premium)". Prefer those when the
    // machine has them.
    const quality = (voice) => (/premium/iu.test(voice) ? 0 : /enhanced/iu.test(voice) ? 1 : 2)

    const best = new Map()
    for (const voice of all) {
      const base = baseName(voice)
      if (!natural.includes(base)) continue
      const held = best.get(base)
      if (!held || quality(voice) < quality(held)) best.set(base, voice)
    }
    const ranked = [...best.entries()]
      .sort((a, b) => natural.indexOf(a[0]) - natural.indexOf(b[0]))
      .map(([, voice]) => voice)
    cachedVoices = ranked.length ? ranked : all
  } catch {
    cachedVoices = []
  }
  return cachedVoices
}

// Returns 48k mono float samples for the phrase, or null when no system TTS
// exists (caller falls back to tone bursts). All engines write PCM16 WAV.
export const synthesizeSpeech = async (phrase, voice = null) => {
  const engine = await detectTtsEngine()
  if (engine === 'tones') return null
  const tmpFile = join(tmpdir(), `calls-sim-tts-${process.pid}-${Date.now()}.wav`)
  try {
    if (engine === 'say') {
      // Default delivery is faster than anyone talks on a call and runs
      // sentences together. Slowing it slightly and letting it breathe at the
      // punctuation is most of the difference between "a person" and "a
      // computer reading".
      const spoken = phrase
        .replace(/([.!?])\s+/gu, '$1 [[slnc 320]] ')
        .replace(/,\s+/gu, ', [[slnc 90]] ')
      const args = ['-o', tmpFile, '--data-format=LEI16@48000', '-r', '158']
      if (voice) args.push('-v', voice)
      await run('say', [...args, spoken])
    } else if (engine === 'powershell') {
      const script =
        "Add-Type -AssemblyName System.Speech; " +
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
        `$s.SetOutputToWaveFile('${tmpFile.replace(/'/gu, "''")}'); ` +
        `$s.Speak('${phrase.replace(/'/gu, "''")}'); $s.Dispose()`
      await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
    } else {
      await run(engine, ['-w', tmpFile, '-s', '150', phrase])
    }
    return decodeWav(readFileSync(tmpFile))
  } finally {
    rmSync(tmpFile, { force: true })
  }
}
