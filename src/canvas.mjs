// A tiny RGB software canvas with anti-aliased primitives, plus YUV420
// conversion for writing y4m frames. Pure Node — no native deps.

export class Canvas {
  constructor(width, height) {
    this.width = width
    this.height = height
    this.rgb = new Uint8ClampedArray(width * height * 3)
  }

  // --- painting ------------------------------------------------------------

  clear([r, g, b]) {
    for (let i = 0; i < this.rgb.length; i += 3) {
      this.rgb[i] = r
      this.rgb[i + 1] = g
      this.rgb[i + 2] = b
    }
  }

  // Vertical gradient, optionally shifted so the loop breathes.
  gradient(top, bottom) {
    const { width, height } = this
    for (let y = 0; y < height; y += 1) {
      const t = y / (height - 1)
      const r = top[0] + (bottom[0] - top[0]) * t
      const g = top[1] + (bottom[1] - top[1]) * t
      const b = top[2] + (bottom[2] - top[2]) * t
      let i = y * width * 3
      for (let x = 0; x < width; x += 1) {
        this.rgb[i] = r
        this.rgb[i + 1] = g
        this.rgb[i + 2] = b
        i += 3
      }
    }
  }

  blend(x, y, [r, g, b], alpha) {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.width || y >= this.height) return
    const i = (y * this.width + x) * 3
    if (alpha >= 1) {
      this.rgb[i] = r
      this.rgb[i + 1] = g
      this.rgb[i + 2] = b
      return
    }
    const inv = 1 - alpha
    this.rgb[i] = this.rgb[i] * inv + r * alpha
    this.rgb[i + 1] = this.rgb[i + 1] * inv + g * alpha
    this.rgb[i + 2] = this.rgb[i + 2] * inv + b * alpha
  }

  rect(x0, y0, w, h, color, alpha = 1) {
    const xs = Math.max(0, Math.round(x0))
    const ys = Math.max(0, Math.round(y0))
    const xe = Math.min(this.width, Math.round(x0 + w))
    const ye = Math.min(this.height, Math.round(y0 + h))
    for (let y = ys; y < ye; y += 1) {
      for (let x = xs; x < xe; x += 1) this.blend(x, y, color, alpha)
    }
  }

  roundRect(x0, y0, w, h, radius, color, alpha = 1) {
    const r = Math.min(radius, w / 2, h / 2)
    const xs = Math.max(0, Math.floor(x0))
    const ys = Math.max(0, Math.floor(y0))
    const xe = Math.min(this.width, Math.ceil(x0 + w))
    const ye = Math.min(this.height, Math.ceil(y0 + h))
    for (let y = ys; y < ye; y += 1) {
      for (let x = xs; x < xe; x += 1) {
        // distance into the nearest corner circle, else fully inside
        const dx = Math.max(x0 + r - x, 0, x - (x0 + w - r - 1))
        const dy = Math.max(y0 + r - y, 0, y - (y0 + h - r - 1))
        const d = Math.hypot(dx, dy)
        const cover = d <= r - 1 ? 1 : d >= r ? 0 : r - d
        if (cover > 0) this.blend(x, y, color, alpha * cover)
      }
    }
  }

  // Anti-aliased filled ellipse (a circle when rx === ry).
  ellipse(cx, cy, rx, ry, color, alpha = 1) {
    if (rx <= 0 || ry <= 0) return
    const xs = Math.max(0, Math.floor(cx - rx - 1))
    const xe = Math.min(this.width, Math.ceil(cx + rx + 1))
    const ys = Math.max(0, Math.floor(cy - ry - 1))
    const ye = Math.min(this.height, Math.ceil(cy + ry + 1))
    for (let y = ys; y < ye; y += 1) {
      const ny = (y + 0.5 - cy) / ry
      for (let x = xs; x < xe; x += 1) {
        const nx = (x + 0.5 - cx) / rx
        const d = Math.hypot(nx, ny)
        // fade over roughly one pixel at the edge
        const feather = 1 / Math.min(rx, ry)
        const cover = d <= 1 - feather ? 1 : d >= 1 ? 0 : (1 - d) / feather
        if (cover > 0) this.blend(x, y, color, alpha * cover)
      }
    }
  }

  circle(cx, cy, r, color, alpha = 1) {
    this.ellipse(cx, cy, r, r, color, alpha)
  }

  // Anti-aliased ring outline (a filled circle at low alpha reads as a disc).
  ring(cx, cy, r, thickness, color, alpha = 1) {
    const outer = r + thickness
    const xs = Math.max(0, Math.floor(cx - outer))
    const xe = Math.min(this.width, Math.ceil(cx + outer))
    const ys = Math.max(0, Math.floor(cy - outer))
    const ye = Math.min(this.height, Math.ceil(cy + outer))
    for (let y = ys; y < ye; y += 1) {
      for (let x = xs; x < xe; x += 1) {
        const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - r)
        if (d >= thickness) continue
        this.blend(x, y, color, alpha * (1 - d / thickness))
      }
    }
  }

  // Soft radial light with a smooth falloff — a flat ellipse at low alpha shows
  // its edge, which reads as a drawn shape rather than light.
  glow(cx, cy, rx, ry, color, maxAlpha) {
    const xs = Math.max(0, Math.floor(cx - rx))
    const xe = Math.min(this.width, Math.ceil(cx + rx))
    const ys = Math.max(0, Math.floor(cy - ry))
    const ye = Math.min(this.height, Math.ceil(cy + ry))
    for (let y = ys; y < ye; y += 1) {
      const ny = (y + 0.5 - cy) / ry
      for (let x = xs; x < xe; x += 1) {
        const nx = (x + 0.5 - cx) / rx
        const d = Math.hypot(nx, ny)
        if (d >= 1) continue
        const falloff = (1 - d) * (1 - d)
        this.blend(x, y, color, maxAlpha * falloff)
      }
    }
  }

  // --- output --------------------------------------------------------------

  // BT.601 studio-swing YUV420 planar, the format y4m C420 expects.
  toYuv420(out) {
    const { width, height, rgb } = this
    const ySize = width * height
    const cW = width >> 1
    const cSize = cW * (height >> 1)
    const buf = out ?? Buffer.alloc(ySize + 2 * cSize)
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const i = (y * width + x) * 3
        const r = rgb[i]
        const g = rgb[i + 1]
        const b = rgb[i + 2]
        buf[y * width + x] = 16 + (65.738 * r + 129.057 * g + 25.064 * b) / 256
        // chroma is sampled from the even pixel of each 2x2 block
        if ((x & 1) === 0 && (y & 1) === 0) {
          const c = ySize + (y >> 1) * cW + (x >> 1)
          buf[c] = 128 + (-37.945 * r - 74.494 * g + 112.439 * b) / 256
          buf[c + cSize] = 128 + (112.439 * r - 94.154 * g - 18.285 * b) / 256
        }
      }
    }
    return buf
  }
}

export const hsl = (h, s, l) => {
  const a = s * Math.min(l, 1 - l)
  const f = (n) => {
    const k = (n + h / 30) % 12
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))))
  }
  return [f(0), f(8), f(4)]
}
