import { inflateSync } from 'node:zlib'

// Minimal PNG decoder for what Chromium screenshots produce: 8-bit,
// non-interlaced, RGB or RGBA. Returns { width, height, channels, data }.
export const decodePng = (buffer) => {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG')
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  const idat = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('latin1', offset + 4, offset + 8)
    const body = offset + 8
    if (type === 'IHDR') {
      width = buffer.readUInt32BE(body)
      height = buffer.readUInt32BE(body + 4)
      const depth = buffer[body + 8]
      const colorType = buffer[body + 9]
      const interlace = buffer[body + 12]
      if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`)
      if (interlace !== 0) throw new Error('interlaced PNG is not supported')
      channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType]
      if (!channels) throw new Error(`unsupported colour type ${colorType}`)
    } else if (type === 'IDAT') {
      idat.push(buffer.subarray(body, body + length))
    } else if (type === 'IEND') {
      break
    }
    offset = body + length + 4 // skip CRC
  }

  const raw = inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const out = Buffer.alloc(height * stride)

  // undo the per-scanline filters (PNG spec 9.2)
  let pos = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos]
    pos += 1
    const line = raw.subarray(pos, pos + stride)
    pos += stride
    const target = y * stride
    const above = target - stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? out[target + x - channels] : 0
      const up = y > 0 ? out[above + x] : 0
      const upLeft = y > 0 && x >= channels ? out[above + x - channels] : 0
      let value = line[x]
      switch (filter) {
        case 1: value += left; break
        case 2: value += up; break
        case 3: value += (left + up) >> 1; break
        case 4: {
          const p = left + up - upLeft
          const pa = Math.abs(p - left)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - upLeft)
          value += pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft
          break
        }
        default: break
      }
      out[target + x] = value & 0xff
    }
  }
  return { width, height, channels, data: out }
}
