// Drives every platform adapter against a page that mimics that platform's
// DOM, so a refactor cannot quietly break a join flow, a device toggle, or the
// participant grid. It does not prove the real product still looks like this —
// only a live call does that — but it does prove the adapter code is intact.
//
//   node scripts/test-platforms.mjs
import { chromium } from 'playwright'

import { resolveLink } from '../src/platforms/index.mjs'
import aloqa from '../src/platforms/aloqa.mjs'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// A remote tile only counts when its <video> genuinely plays, so the fixtures
// feed one from a canvas rather than leaving an empty element.
const PLAYING_VIDEO = `
  const canvas = document.createElement('canvas')
  canvas.width = 64; canvas.height = 64
  const g = canvas.getContext('2d')
  setInterval(() => { g.fillStyle = '#'+((Date.now()/100|0)%2?'0f0':'00f'); g.fillRect(0,0,64,64) }, 100)
  for (const video of document.querySelectorAll('video')) {
    video.muted = true
    video.srcObject = canvas.captureStream(10)
    video.play().catch(() => {})
  }`

const ALOQA_ENTRY = `<!doctype html><meta charset=utf-8><body>
  <form action="/guest/meeting/mtg-abc123" method="get">
    <input name="display_name">
    <button type="submit">Join call</button>
  </form></body>`

const ALOQA_CALL = `<!doctype html><meta charset=utf-8><body>
  <div data-testid="guest-call-surface">
    <div data-testid="mic-control-pair"><button aria-pressed="true">mic</button></div>
    <div data-testid="cam-control-pair"><button aria-pressed="true">cam</button></div>
    <button data-testid="call-controls-leave">leave</button>
    <div id="confirm" hidden><button data-testid="call-leave-confirm-submit">yes</button></div>
    <div data-testid="participant-tile" data-local="true">
      <span data-testid="participant-name">Bot 1</span></div>
    <div data-testid="participant-tile" data-local="false">
      <span data-testid="participant-name">Alice</span>
      <video data-testid="participant-video" playsinline></video></div>
  </div>
  <script>
    for (const b of document.querySelectorAll('[data-testid$="-control-pair"] button')) {
      b.addEventListener('click', () =>
        b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'))
    }
    document.querySelector('[data-testid="call-controls-leave"]')
      .addEventListener('click', () => { document.getElementById('confirm').hidden = false })
    ${PLAYING_VIDEO}
  </script></body>`

const log = { info: () => {}, warn: () => {}, error: () => {} }
const fail = (name, message) => { throw new Error(`${name}: ${message}`) }

const drive = async (browser, { title, link, adapter, routes, expectCallId }) => {
  console.log(`\n${title}`)
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } })
  await context.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname
    const body = routes(path)
    if (body === null) return route.fulfill({ status: 404, body: 'no fixture' })
    return route.fulfill({ status: 200, contentType: 'text/html', body })
  })
  const page = await context.newPage()
  const target = resolveLink(link)
  const ctx = { page, target, displayName: 'Bot 1', log, fail, options: {} }

  try {
    const { callId } = await adapter.join(ctx)
    check('joins the call', true)
    check('reports the call id', callId === expectCallId, `got ${JSON.stringify(callId)}`)

    check('mic reads off before arming', (await adapter.micState(page)) === 'off')
    check('cam reads off before arming', (await adapter.camState(page)) === 'off')
    check('setMic(true) turns it on', (await adapter.setMic(ctx, true)) === 'on')
    check('setCam(true) turns it on', (await adapter.setCam(ctx, true)) === 'on')
    check('setMic(false) turns it off', (await adapter.setMic(ctx, false)) === 'off')
    check('setMic(true) again is idempotent', (await adapter.setMic(ctx, true)) === 'on')

    await page.waitForTimeout(700) // let the fixture video reach readyState 2
    const remote = await adapter.remote(page)
    check('counts one local tile', remote.local === 1, JSON.stringify(remote))
    check('counts one remote tile', remote.remote === 1)
    check('sees the remote video playing', remote.remotePlaying === 1)
    check('reads participant names', remote.names.length === 2, remote.names.join(', '))

    await adapter.leave(ctx)
    check('leaves the call', true)
  } catch (error) {
    check(`${title} completed`, false, error.message)
  }
  await context.close()
}

const browser = await chromium.launch({ channel: 'chromium', headless: true })

await drive(browser, {
  title: 'Aloqa',
  link: 'https://aloqa.test/join/AbCdEfGhIjKlMnOpQrSt',
  adapter: aloqa,
  expectCallId: 'mtg-abc123',
  routes: (path) => (path.startsWith('/guest/meeting/') ? ALOQA_CALL : ALOQA_ENTRY),
})

// --- refusals ---------------------------------------------------------------
// The message a bot fails with is what the user acts on, so it is worth
// pinning down too.
const expectFailure = async (title, { link, adapter, body, expect }) => {
  console.log(`\n${title}`)
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } })
  await context.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body }))
  const page = await context.newPage()
  const ctx = { page, target: resolveLink(link), displayName: 'Bot 1', log, fail, options: {} }
  let message = null
  const started = Date.now()
  try {
    await adapter.join(ctx)
  } catch (error) {
    message = error.message
  }
  const seconds = (Date.now() - started) / 1000
  check('refuses with a message the user can act on', Boolean(message && expect.test(message)),
    message ?? 'it joined instead of failing')
  // The refusal is on screen within a second. Waiting out a join timeout before
  // reading it leaves the bot claiming to be joining while the page says no.
  check('reports the refusal promptly', seconds < 10, `took ${seconds.toFixed(1)}s`)
  await context.close()
}

await expectFailure('Aloqa — join refused', {
  link: 'https://aloqa.test/join/AbCdEfGhIjKlMnOpQrSt',
  adapter: aloqa,
  body: `<!doctype html><meta charset=utf-8><body>
    <div data-testid="guest-join-blocked">This invite link has expired</div></body>`,
  expect: /join refused: This invite link has expired/u,
})

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
