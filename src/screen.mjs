import { SCREEN_TITLE } from './browser.mjs'

// What a bot puts on screen when it shares. It has no desktop, so it shares a
// page of its own: something that plainly belongs to this bot, and that keeps
// moving, so anyone watching can tell the feed is live rather than a frozen
// frame — and can see quality drop when the network is squeezed.
export const screenHtml = (label, accent) => `<!doctype html>
<meta charset="utf-8"><title>${SCREEN_TITLE}</title>
<style>
  html, body { margin: 0; height: 100%; background: #0a0c12; color: #eef2ff;
    font: 600 16px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif; }
  .page { height: 100%; display: grid; grid-template-rows: auto 1fr auto; padding: 48px 56px; box-sizing: border-box; }
  .who { font-size: 44px; letter-spacing: -.5px; }
  .who b { color: ${accent}; }
  .clock { font: 700 92px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 4px; }
  .body { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center; }
  .bars { display: grid; gap: 14px; }
  .bar { height: 26px; border-radius: 6px; background: #161b26; overflow: hidden; }
  .bar i { display: block; height: 100%; background: ${accent}; }
  .fine { font: 400 13px/1.5 ui-monospace, Menlo, monospace; color: #93a0bd; }
  .fine span { display: block; }
  canvas { width: 100%; border-radius: 12px; background: #0f1320; }
  .foot { display: flex; justify-content: space-between; color: #6b7690; font-size: 14px; }
</style>
<div class="page">
  <div class="who"><b>${label}</b> is sharing a screen</div>
  <div class="body">
    <div>
      <div class="clock" id="clock">00:00:00</div>
      <div class="bars">
        <div class="bar"><i id="b1" style="width:20%"></i></div>
        <div class="bar"><i id="b2" style="width:55%"></i></div>
        <div class="bar"><i id="b3" style="width:35%"></i></div>
      </div>
    </div>
    <canvas id="c" width="640" height="360"></canvas>
  </div>
  <div class="foot"><span class="fine" id="fine"></span><span id="frames">frame 0</span></div>
</div>
<script>
  const g = document.getElementById('c').getContext('2d')
  const accent = '${accent}'
  let frame = 0
  // Fine text and thin lines are the first things to go when a video codec is
  // starved, which makes them the point of putting them here.
  const lines = ['the quick brown fox jumps over the lazy dog 0123456789',
                 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz',
                 'if this is unreadable, the shared screen is being squeezed']
  setInterval(() => {
    frame += 1
    const t = new Date()
    document.getElementById('clock').textContent = t.toTimeString().slice(0, 8)
    document.getElementById('frames').textContent = 'frame ' + frame
    document.getElementById('fine').innerHTML = lines.map((l) => '<span>' + l + '</span>').join('')
    for (const [id, speed] of [['b1', 0.7], ['b2', 1.3], ['b3', 2.1]]) {
      document.getElementById(id).style.width = (50 + 48 * Math.sin(frame / (20 * speed))) + '%'
    }
    g.fillStyle = '#0f1320'; g.fillRect(0, 0, 640, 360)
    g.strokeStyle = '#243049'; g.lineWidth = 1
    for (let x = 0; x <= 640; x += 20) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, 360); g.stroke() }
    for (let y = 0; y <= 360; y += 20) { g.beginPath(); g.moveTo(0, y); g.lineTo(640, y); g.stroke() }
    g.fillStyle = accent
    const x = 320 + 220 * Math.cos(frame / 24), y = 180 + 120 * Math.sin(frame / 17)
    g.beginPath(); g.arc(x, y, 34, 0, Math.PI * 2); g.fill()
    g.strokeStyle = accent; g.lineWidth = 3
    g.beginPath()
    for (let i = 0; i < 640; i += 4) g.lineTo(i, 180 + 90 * Math.sin((i + frame * 6) / 40))
    g.stroke()
  }, 100)
</script>`
