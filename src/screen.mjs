import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { SCREEN_TITLE } from './browser.mjs'
import { bundledMediaDir, fixturesDir } from './config.mjs'

// The footage a bot shares. Same rule as the camera clips: something imported
// on this machine wins over what ships with the app.
export const screenVideoPath = () => {
  for (const dir of [fixturesDir, bundledMediaDir]) {
    const file = join(dir, 'screen.webm')
    if (existsSync(file)) return file
  }
  return null
}

// What a bot puts on screen when it shares. It has no desktop, so it shares a
// page of its own: real footage filling the frame, the way a video wallpaper
// would, with a small caption naming the bot and a clock — enough to tell whose
// screen it is and that the feed is live, without covering the picture.
export const screenHtml = (label, accent, videoUrl) => `<!doctype html>
<meta charset="utf-8"><title>${SCREEN_TITLE}</title>
<style>
  html, body { margin: 0; height: 100%; background: #05070c; overflow: hidden; }
  video, .fallback { position: fixed; inset: 0; width: 100%; height: 100%; object-fit: cover; }
  .fallback { background:
    radial-gradient(1200px 600px at 20% 10%, ${accent}22, transparent 60%),
    linear-gradient(160deg, #0a1020, #05070c); }
  .caption {
    position: fixed; left: 28px; bottom: 24px; display: flex; align-items: center; gap: 14px;
    padding: 10px 18px; border-radius: 999px; background: rgba(6,9,15,.55);
    backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,.14);
    font: 600 20px/1 -apple-system, "Segoe UI", system-ui, sans-serif; color: #eef2ff;
  }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: ${accent}; }
  .clock { font: 600 20px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: #aab6d4; }
</style>
${videoUrl
    ? `<video autoplay muted loop playsinline src="${videoUrl}"></video>`
    : '<div class="fallback"></div>'}
<div class="caption"><span class="dot"></span><span>${label}</span><span class="clock" id="clock">--:--:--</span></div>
<script>
  // A moving clock is the cheapest proof the picture is live rather than frozen.
  setInterval(() => {
    document.getElementById('clock').textContent = new Date().toTimeString().slice(0, 8)
  }, 250)
</script>`
