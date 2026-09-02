import { chromium } from 'playwright'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const dir = mkdtempSync(join(tmpdir(), 'b-'))
const child = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  `--user-data-dir=${dir}`, '--incognito', '--remote-debugging-port=0',
  '--no-first-run', '--no-default-browser-check', '--lang=en-US', '--mute-audio',
  '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream',
  'https://meet.google.com/hvc-qpag-vhk?hl=en',
], { stdio: 'ignore', detached: true })
let port = 0
for (let i = 0; i < 100 && !port; i += 1) {
  await new Promise(r => setTimeout(r, 200))
  try { port = Number(readFileSync(join(dir,'DevToolsActivePort'),'utf8').split('\n')[0]) } catch {}
}
await new Promise(r => setTimeout(r, 9000))
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('hvc-qpag'))
console.log('B (CDP attached):', JSON.stringify(await page.evaluate(() => {
  const v = e => !!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)
  return { inputs: [...document.querySelectorAll('input')].filter(v).map(e=>e.getAttribute('aria-label')||e.placeholder),
    txt: (document.body.innerText||'').replace(/\n+/g,' | ').slice(0,80) }
})))
await browser.close().catch(()=>{})
try { process.kill(-child.pid) } catch {}
process.exit(0)
