import { ChromeWindow } from './src/chrome-window.mjs'
const media = { video: '/Users/mahmud/Projects/call-bots/media/clip-1-1920x1080-30fps-8s.mjpeg',
                audio: '/Users/mahmud/Projects/call-bots/media/voice-1.wav' }
const opts = { runId: 'probe', noVideo: false, noAudio: false }
const READ = "(function(){var v=function(e){return !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)};" +
  "return JSON.stringify({inputs:[].slice.call(document.querySelectorAll('input')).filter(v).map(function(e){return e.getAttribute('aria-label')||e.placeholder})," +
  "leave:[].slice.call(document.querySelectorAll('[aria-label*=\"Leave call\" i]')).filter(v).length," +
  "txt:(document.body.innerText||'').replace(/\\n+/g,' | ').slice(0,80)})})()"
const wins = []
try {
  for (let i = 1; i <= 2; i += 1) {
    const w = await ChromeWindow.open(media, opts)
    wins.push(w)
    await w.goto('https://meet.google.com/hvc-qpag-vhk?hl=en')
    await w.waitForTimeout(9000)
    console.log(`window ${i} (${w.windowId}):`, JSON.stringify(await w.evaluate(READ)))
  }
} catch (e) { console.log('ERROR', e.message.slice(0, 160)) }
finally { for (const w of wins) await w.close().catch(() => {}) }
process.exit(0)
