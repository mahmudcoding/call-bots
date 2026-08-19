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

// Returns 48k mono float samples for the phrase, or null when no system TTS
// exists (caller falls back to tone bursts). All engines write PCM16 WAV.
export const synthesizeSpeech = async (phrase) => {
  const engine = await detectTtsEngine()
  if (engine === 'tones') return null
  const tmpFile = join(tmpdir(), `calls-sim-tts-${process.pid}-${Date.now()}.wav`)
  try {
    if (engine === 'say') {
      await run('say', ['-o', tmpFile, '--data-format=LEI16@48000', phrase])
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
