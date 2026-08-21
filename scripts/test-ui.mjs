// Drives the real dashboard (src/ui.html) against synthetic server states, so
// a refactor cannot quietly lose a control the user depends on. The server is
// stubbed at the network seam: EventSource is replaced before the page loads,
// states are pushed through it, and /api/* is routed to fixtures.
//
// The one rule this file exists to pin: the Stop button is visible whenever
// there is a session to stop — while joining as much as while running. One bot
// stuck in an admission lobby holds "joining" for up to ten minutes, and that
// must never leave the window with no way out.
//
// It also pins the grouping: bots are sent into the same call more than once,
// each send is its own batch, and one button takes a whole batch back out
// without touching the batches around it or the per-bot controls.
//
//   node scripts/test-ui.mjs
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { launchChannel } from '../src/browser.mjs'

const html = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../src/ui.html'),
  'utf8',
)

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

// The exact shape stateSnapshot() broadcasts.
const state = (status, session = null, extra = {}) => ({
  status,
  startedAt: status === 'idle' ? null : 1,
  lastError: null,
  machine: { memGB: 16, cores: 8, recommendedMax: 6, platform: 'test' },
  browserReady: true,
  browserInstalling: false,
  browserProgress: null,
  session,
  verify: null,
  ...extra,
})

// `sizes` splits the same bots across sends, the way the server reports them
// after "5 bots, then 7 more". One send is the default.
const roster = (states, sizes = [states.length]) => {
  const batchOf = (index) => {
    let seen = 0
    for (const [batch, size] of sizes.entries()) {
      seen += size
      if (index < seen) return batch + 1
    }
    return sizes.length
  }
  return {
    meetingId: 'mtg-abc123',
    inviteLink: 'https://aloqa.test/join/AbCdEfGhIjKlMnOpQrSt',
    platform: 'Aloqa',
    batches: sizes.map((size, i) => ({ id: i + 1, at: 1_755_000_000_000 + i * 60_000, size })),
    guests: states.map((guestState, i) => ({
      index: i,
      slug: `bot-${i + 1}`,
      label: `Bot ${i + 1}`,
      color: '#00e5ff',
      state: guestState,
      batch: batchOf(i),
      mic: guestState === 'in-call' ? 'on' : null,
      cam: guestState === 'in-call' ? 'on' : null,
      screen: guestState === 'in-call' ? 'off' : null,
      rtc: guestState === 'in-call'
        ? { pcs: 1, via: false, down: 1830, up: 940, rtt: 45, loss: 0.2, jit: 9, in: { a: 1, v: 2 }, out: { a: 1, v: 1 }, limit: null }
        : null,
      lastError: null,
    })),
  }
}

// What /api/rtc/<slug> serves: the sanitized stream model read out of a bot's
// page, one row per RTP stream, names joined in-page. `limit` on the video
// exercises the encoder-limitation warning.
const RTC_SNAP = {
  t: 1_755_000_000_000, pcs: 1, via: false, down: 1830, up: 940, rtt: 45, loss: 0.2, jitter: 9,
  avail: 2500, limit: 'bandwidth', dtls: 'connected',
  localCand: { type: 'host', proto: 'udp', net: 'wifi', relay: null },
  remoteCand: { type: 'srflx', proto: 'udp' },
  outbound: [
    { id: 'o1', kind: 'video', dir: 'out', ssrc: 111111, mid: '0', track: 't-local-v', name: 'Bot 1',
      kbps: 900, w: 1280, h: 720, fps: 24, codec: { name: 'VP8', clock: 90000, channels: null },
      bytes: 1_000_000, rid: null, limit: 'bandwidth', active: true, rtt: 45, fraction: 0.1,
      remoteJitter: 8, nack: 0, pli: 1, keyframes: 4, encoder: 'libvpx', role: 'camera', level: null },
    { id: 'o2', kind: 'audio', dir: 'out', ssrc: 222222, mid: '1', track: 't-local-a', name: 'Bot 1',
      kbps: 40, w: null, h: null, fps: null, codec: { name: 'opus', clock: 48000, channels: 2 },
      bytes: 200_000, rid: null, limit: null, active: true, rtt: 45, fraction: 0,
      remoteJitter: 6, nack: 0, pli: 0, keyframes: null, encoder: null, role: null, level: 0.4 },
  ],
  inbound: [
    { id: 'i1', kind: 'video', dir: 'in', ssrc: 333333, mid: '2', track: 't-rem-v', name: 'Alice',
      kbps: 850, w: 1280, h: 720, fps: 24, codec: { name: 'VP8', clock: 90000, channels: null },
      bytes: 3_000_000, jitter: 7, lossPct: 0.2, jbDelay: 40, framesDropped: 2, freezeCount: 0,
      nack: 1, pli: 0, decoder: 'libvpx', level: null },
    { id: 'i2', kind: 'audio', dir: 'in', ssrc: 444444, mid: '3', track: 't-rem-a', name: 'Alice',
      kbps: 38, w: null, h: null, fps: null, codec: { name: 'opus', clock: 48000, channels: 2 },
      bytes: 400_000, jitter: 5, lossPct: 0, jbDelay: 35, framesDropped: null, freezeCount: null,
      nack: 0, pli: 0, decoder: null, level: 0.6 },
    // measured-inactive (0 kbps): a paused SFU layer — the panel must hide it
    { id: 'i3', kind: 'video', dir: 'in', ssrc: 555555, mid: '4', track: null, name: null,
      kbps: 0, w: 960, h: 540, fps: 0, codec: { name: 'VP9', clock: 90000, channels: null },
      bytes: 12_000, jitter: null, lossPct: null, jbDelay: null, framesDropped: null, freezeCount: null,
      nack: 0, pli: 0, decoder: null, level: null },
  ],
  dataChannels: [{ label: 'lossy', state: 'open', inKbps: 1, outKbps: 1 }],
}

// The same browser choice the app makes, so this passes on an installation
// that has only system Chrome and never downloaded the bundled Chromium.
const browser = await chromium.launch({ channel: launchChannel(), headless: true })
try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } })

  // The page connects to /api/events on load; hand it a silent stand-in the
  // test can push states through instead.
  await context.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        window.__es = this
      }
      close() {}
    }
  })

  const stops = []
  await context.route('**/*', (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    if (request.method() === 'POST' && path === '/api/start') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    }
    if (request.method() === 'POST' && path === '/api/add') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true,"added":2,"failed":0,"removed":false}',
      })
    }
    if (request.method() === 'POST' && path === '/api/stop') {
      stops.push(path)
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    }
    if (request.method() === 'POST' && path === '/api/action') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"ok":true,"results":{}}',
      })
    }
    if (request.method() === 'GET' && path.startsWith('/api/rtc/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(RTC_SNAP),
      })
    }
    if (path === '/') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html })
    }
    return route.fulfill({ status: 204, body: '' })
  })

  const page = await context.newPage()
  await page.goto('http://call-bots.test/')

  const push = (nextState) =>
    page.evaluate((s) => {
      window.__es.onmessage({ data: JSON.stringify({ type: 'state', state: s }) })
    }, nextState)

  const stopBtn = page.locator('#stopBtn')
  const goBtn = page.locator('#goBtn')

  // What a control asks the server for is the whole of its behaviour here.
  const actionOf = async (locator) => {
    const sent = page.waitForRequest(
      (request) => request.method() === 'POST' && request.url().endsWith('/api/action'),
    )
    await locator.click()
    return (await sent).postDataJSON()
  }

  console.log('\nidle')
  await push(state('idle'))
  check('no Stop button before a session', !(await stopBtn.isVisible()))
  check('Send bots is offered', (await goBtn.textContent()) === 'Send bots')
  check('Send bots is enabled', !(await goBtn.isDisabled()))
  check('no all-bots bar', !(await page.locator('#allbar').isVisible()))
  await page.locator('#link').fill('https://aloqa.test/join/AbCdEfGhIjKlMnOpQrSt')
  await page.locator('#botLabel').fill('  Mahmud  ')
  const startRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/start'),
  )
  await goBtn.click()
  check('the label is sent when starting',
    (await startRequest).postDataJSON().label === 'Mahmud')
  await page.waitForFunction(() => !document.querySelector('#goBtn').disabled)

  console.log('\njoining — bots are landing, one is still in the lobby')
  await push(state('joining', roster(['in-call', 'joining'])))
  check('the status pill says joining', (await page.locator('#statusPill').textContent()) === 'joining')
  const stopVisibleMidJoin = await stopBtn.isVisible()
  check('Stop is available mid-join', stopVisibleMidJoin)
  check('a card exists per bot', (await page.locator('.card').count()) === 2)
  check('sending more is paused', await goBtn.isDisabled())
  check('the link is locked to the call', await page.locator('#link').isDisabled())
  check('all-bots actions wait for running', !(await page.locator('#allbar').isVisible()))
  check('removing a batch waits for running too',
    await page.locator('[data-batch-remove]').first().isDisabled())
  check('no stream stats before a bot is in the call',
    !(await page.locator('.card[data-slug="bot-2"] .rtcbar').isVisible()))
  check('the stream monitor waits for the call too',
    await page.locator('.card[data-slug="bot-2"] [data-rtc-toggle]').isDisabled())

  if (stopVisibleMidJoin) {
    const stopRequest = page.waitForRequest((request) => request.url().endsWith('/api/stop'))
    await stopBtn.click()
    await stopRequest
  }
  check('clicking Stop mid-join calls /api/stop', stops.length === 1,
    stopVisibleMidJoin ? '' : 'no button to click')
  check('the stop is accepted without an error toast', (await page.locator('.toast.-err').count()) === 0)

  console.log('\nstopping')
  await push(state('stopping', roster(['leaving', 'leaving'])))
  check('Stop hides once the stop is underway', !(await stopBtn.isVisible()))

  console.log('\nrunning')
  await push(state('running', roster(['in-call', 'in-call'])))
  check('Stop is available while running', await stopBtn.isVisible())
  check('the all-bots bar appears', await page.locator('#allbar').isVisible())
  check('the button now adds bots', (await goBtn.textContent()) === 'Add bots')
  check('adding is enabled', !(await goBtn.isDisabled()))
  const addRequest = page.waitForRequest(
    (request) => request.method() === 'POST' && request.url().endsWith('/api/add'),
  )
  await goBtn.click()
  check('the label is sent when adding more bots',
    (await addRequest).postDataJSON().label === 'Mahmud')
  await page.waitForFunction(() => !document.querySelector('#goBtn').disabled)
  check('the bots are shown as the one batch they arrived in',
    (await page.locator('.batch').count()) === 1)

  console.log('\nstream monitor')
  check('an in-call card shows its compact stats bar',
    await page.locator('.card[data-slug="bot-1"] .rtcbar').isVisible())
  check('the bar shows the receive rate from the snapshot',
    (await page.locator('.card[data-slug="bot-1"] [data-rtc=down]').textContent()) === '1.8 Mbps')
  const monitorBtn = page.locator('.card[data-slug="bot-1"] [data-rtc-toggle]')
  await monitorBtn.click()
  check('opening the monitor expands the card', await page
    .locator('.card[data-slug="bot-1"]')
    .evaluate((card) => card.classList.contains('rtc-open')))
  await page.waitForFunction(
    () => document.querySelectorAll('.card[data-slug="bot-1"] .srow').length === 4,
  )
  check('one row per stream, sending and receiving', true)
  check('a 0 kbps receiving stream is hidden and the count matches',
    (await page.locator('.card[data-slug="bot-1"] .rtcpanel').textContent()).includes('Receiving · 2'))
  check('streams carry the names joined inside the bot page',
    (await page.locator('.card[data-slug="bot-1"] .rtcpanel').textContent()).includes('Alice'))
  check('45 ms / 0.2% / 9 ms reads as excellent',
    (await page.locator('.card[data-slug="bot-1"] .rhero .qw').textContent()) === 'excellent')
  check('the encoder limitation is surfaced',
    await page.locator('.card[data-slug="bot-1"] .rwarn').isVisible())
  await monitorBtn.click()
  check('closing the monitor collapses the card', !(await page
    .locator('.card[data-slug="bot-1"]')
    .evaluate((card) => card.classList.contains('rtc-open'))))
  check('closing it stops the polling',
    await page.evaluate(() => ![...S.rtc.values()].some((entry) => entry.timer)))

  console.log('\nrunning — 3 more bots sent into the same call')
  await push(state('running', roster(['in-call', 'in-call', 'in-call', 'in-call', 'in-call'], [2, 3])))
  check('a group per send', (await page.locator('.batch').count()) === 2)
  check('the first send keeps its own bots',
    (await page.locator('[data-batch="1"] .card').count()) === 2)
  check('the second send is a group of its own',
    (await page.locator('[data-batch="2"] .card').count()) === 3)
  check('a group says how many bots it holds',
    (await page.locator('[data-batch="2"] .bhead .sub').textContent()).startsWith('3 bots'))
  check('one remove button per group', (await page.locator('[data-batch-remove]').count()) === 2)
  check('every bot still has its own controls',
    (await page.locator('.card [data-act=leave]').count()) === 5)

  const perBot = await actionOf(page.locator('[data-batch="2"] .card [data-act=mic]').first())
  check('a card control still acts on that one bot',
    perBot.slug === 'bot-3' && perBot.action === 'mute', JSON.stringify(perBot))
  const forAll = await actionOf(page.locator('[data-all=mute]'))
  check('the all-bots bar still acts on every bot',
    forAll.slug === 'all' && forAll.action === 'mute', JSON.stringify(forAll))
  const forBatch = await actionOf(page.locator('[data-batch="2"] [data-batch-remove]'))
  check('one button removes the whole batch',
    forBatch.slug === 'batch:2' && forBatch.action === 'leave', JSON.stringify(forBatch))
  check('removing a batch raises no error', (await page.locator('.toast.-err').count()) === 0)

  console.log('\nthe removed batch is gone, the first one is untouched')
  await push(state('running', roster(['in-call', 'in-call'], [2])))
  check('the removed group disappears', (await page.locator('.batch').count()) === 1)
  check('its cards go with it', (await page.locator('.card').count()) === 2)
  check('the bots that stayed are still there',
    (await page.locator('[data-batch="1"] .card').count()) === 2)
  check('the remove button comes back for the next removal',
    !(await page.locator('[data-batch="1"] [data-batch-remove]').isDisabled()))

  console.log('\nidle again — the session ended')
  await push(state('idle'))
  check('Stop hides with the session', !(await stopBtn.isVisible()))
  check('the cards are cleared', (await page.locator('.card').count()) === 0)
  check('the groups are cleared too', (await page.locator('.batch').count()) === 0)
  check('the empty state returns', await page.locator('#empty').isVisible())
  check('stream monitor state goes with the cards',
    await page.evaluate(() => S.rtc.size === 0))

  console.log('\nreopen')
  await page.close()
  const reopened = await context.newPage()
  await reopened.goto('http://call-bots.test/')
  check('the label is restored after reopening',
    (await reopened.locator('#botLabel').inputValue()).trim() === 'Mahmud')
  await reopened.close()
} finally {
  await browser.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
