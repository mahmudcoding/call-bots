// Minimal pure-Node WAV toolkit — keeps fixture generation free of ffmpeg.
// Everything works in 48 kHz mono signed 16-bit PCM.

export const SAMPLE_RATE = 48_000

// Parses a RIFF/WAVE buffer (PCM16, any channel count / sample rate — e.g.
// macOS `say`, Windows System.Speech, espeak) into 48k mono samples.
// Skips unknown chunks (`say` emits a JUNK chunk before fmt).
export const decodeWav = (buffer) => {
  if (buffer.length < 44 || buffer.toString('latin1', 0, 4) !== 'RIFF' ||
      buffer.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let offset = 12
  let format = null
  let data = null
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4)
    const size = buffer.readUInt32LE(offset + 4)
    const body = offset + 8
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buffer.subarray(body, Math.min(body + size, buffer.length))
    }
    offset = body + size + (size % 2) // chunks are word-aligned
  }
  if (!format || !data) throw new Error('WAV missing fmt/data chunk')
  // 1 = PCM; 0xFFFE = extensible, whose first subformat bytes still mean PCM here
  if (![1, 0xfffe].includes(format.audioFormat) || format.bitsPerSample !== 16) {
    throw new Error(`unsupported WAV encoding (format ${format.audioFormat}, ${format.bitsPerSample}-bit)`)
  }

  const frameCount = Math.floor(data.length / 2 / format.channels)
  const mono = new Float32Array(frameCount)
  for (let i = 0; i < frameCount; i += 1) {
    let sum = 0
    for (let ch = 0; ch < format.channels; ch += 1) {
      sum += data.readInt16LE((i * format.channels + ch) * 2)
    }
    mono[i] = sum / format.channels / 32768
  }
  return resample(mono, format.sampleRate, SAMPLE_RATE)
}

export const resample = (samples, fromRate, toRate) => {
  if (fromRate === toRate) return samples
  const outLength = Math.floor((samples.length * toRate) / fromRate)
  const out = new Float32Array(outLength)
  const ratio = fromRate / toRate
  for (let i = 0; i < outLength; i += 1) {
    const src = i * ratio
    const lo = Math.floor(src)
    const hi = Math.min(lo + 1, samples.length - 1)
    const frac = src - lo
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac
  }
  return out
}

// float [-1,1] samples -> RIFF/WAVE PCM16 mono buffer
export const encodeWav = (samples, sampleRate = SAMPLE_RATE) => {
  const dataSize = samples.length * 2
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'latin1')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'latin1')
  buffer.write('fmt ', 12, 'latin1')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20) // PCM
  buffer.writeUInt16LE(1, 22) // mono
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'latin1')
  buffer.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.max(-1, Math.min(1, samples[i]))
    buffer.writeInt16LE(Math.round(v * 32767), 44 + i * 2)
  }
  return buffer
}

// Speech-like fallback when no system TTS exists: a per-user three-note
// arpeggio with tremolo — enough energy variation to drive active-speaker
// detection and be tellable apart by ear.
export const synthesizeToneBurst = (userIndex, seconds) => {
  const total = Math.floor(seconds * SAMPLE_RATE)
  const out = new Float32Array(total)
  const base = 220 * 2 ** (userIndex / 4)
  const notes = [1, 5 / 4, 3 / 2, 2]
  const noteLength = Math.floor(0.4 * SAMPLE_RATE)
  for (let i = 0; i < total; i += 1) {
    const note = Math.floor(i / noteLength) % notes.length
    const inNote = (i % noteLength) / noteLength
    if (inNote > 0.85) continue // gap between notes
    const t = i / SAMPLE_RATE
    const freq = base * notes[note]
    const envelope = Math.min(1, inNote * 12) * (1 - inNote * 0.35)
    const tremolo = 1 - 0.3 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 4 * t))
    out[i] = 0.45 * envelope * tremolo * Math.sin(2 * Math.PI * freq * t)
  }
  return out
}

// Fraction of one-second windows that carry sound. A bot whose voice file is
// mostly silence looks perfectly connected and says nothing, which is invisible
// from the outside — so every voice is checked before it is used or shipped.
export const speechCoverage = (buffer) => {
  const samples = decodeWav(buffer)
  let loud = 0
  let windows = 0
  for (let start = 0; start + SAMPLE_RATE <= samples.length; start += SAMPLE_RATE) {
    let peak = 0
    for (let i = start; i < start + SAMPLE_RATE; i += 1) peak = Math.max(peak, Math.abs(samples[i]))
    if (peak > 0.02) loud += 1
    windows += 1
  }
  return windows === 0 ? 0 : loud / windows
}

// Below this a file is silence with a little sound in it, not a speaking bot.
export const MIN_SPEECH_COVERAGE = 0.25

export const hasSpeech = (buffer) => speechCoverage(buffer) >= MIN_SPEECH_COVERAGE
