import { chromium } from 'playwright'

const CODE = 'hvc-qpag-vhk'
const variants = [
  ['authuser=0 + hl (what the adapter sends)', `https://meet.google.com/${CODE}?hl=en&authuser=0`, {}],
  ['hl only',                                  `https://meet.google.com/${CODE}?hl=en`,            {}],
  ['bare url',                                 `https://meet.google.com/${CODE}`,                  {}],
  ['bare url, real Chrome channel',            `https://meet.google.com/${CODE}`,   { channel: 'chrome' }],
]

for (const [name, url, opts] of variants) {
  const browser = await chromium.launch({
    channel: opts.channel ?? 'chromium', headless: true,
    args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  })
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1280, height: 800 } })
  await ctx.grantPermissions(['camera', 'microphone'], { origin: 'https://meet.google.com' })
  const page = await ctx.newPage()
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 40000 })
    await page.waitForTimeout(7000)
    const r = await page.evaluate(() => {
      const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      const t = (document.body.innerText || '').replace(/\s+/g, ' ')
      return {
        nameField: [...document.querySelectorAll('input')].filter(vis).length,
        refused: /can'?t join this video call/i.test(t),
        askBtn: [...document.querySelectorAll('button,[role=button]')].filter(vis)
          .some((b) => /ask to join|join now/i.test(b.textContent || '')),
        snippet: t.slice(0, 90),
      }
    })
    console.log(`${r.refused ? 'REFUSED ' : r.nameField ? 'NAME BOX' : '????????'}  ${name}`)
    console.log(`          ${r.snippet}`)
  } catch (e) { console.log('ERROR   ', name, e.message.slice(0, 60)) }
  await browser.close()
}
