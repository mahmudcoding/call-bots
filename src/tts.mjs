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
    // novelty voices are unintelligible; keep them out of the rotation
    const novelty = new Set([
      'Albert', 'Bad News', 'Bahh', 'Bells', 'Boing', 'Bubbles', 'Cellos', 'Good News',
      'Jester', 'Organ', 'Superstar', 'Trinoids', 'Whisper', 'Wobble', 'Zarvox',
    ])
    cachedVoices = all.filter((v) => !novelty.has(v))
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
