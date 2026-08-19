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
    // Prefer the voices that actually sound like a person. Anything outside
    // this list (Fred, Junior, Zarvox and friends) reads as a robot, which is
    // the opposite of what a call full of bots should sound like.
    const natural = [
      'Samantha', 'Daniel', 'Karen', 'Moira', 'Tessa', 'Rishi', 'Tara', 'Aman',
      'Sandy', 'Shelley', 'Reed', 'Flo', 'Eddy', 'Nicky', 'Aaron', 'Serena',
    ]
    const score = (voice) => {
      const base = voice.replace(/\s*\(.*\)$/u, '')
      const rank = natural.indexOf(base)
      return rank === -1 ? Infinity : rank
    }
    const ranked = all.filter((voice) => score(voice) !== Infinity).sort((a, b) => score(a) - score(b))
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
      const args = ['-o', tmpFile, '--data-format=LEI16@48000']
      if (voice) args.push('-v', voice)
      await run('say', [...args, phrase])
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
