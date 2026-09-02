// Drives every platform adapter against a page that mimics that platform's
// DOM, so a refactor cannot quietly break a join flow, a device toggle, or the
// participant grid. It does not prove the real product still looks like this —
// only a live call does that — but it does prove the adapter code is intact.
//
//   node scripts/test-platforms.mjs
import { chromium } from 'playwright'

import { resolveLink } from '../src/platforms/index.mjs'
import aloqa from '../src/platforms/aloqa.mjs'
import meet from '../src/platforms/meet.mjs'

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
    <button data-testid="call-controls-screen-share" aria-pressed="false">share</button>
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
    const sh = document.querySelector('[data-testid="call-controls-screen-share"]')
    sh.addEventListener('click', () =>
      sh.setAttribute('aria-pressed', sh.getAttribute('aria-pressed') === 'true' ? 'false' : 'true'))
    document.querySelector('[data-testid="call-controls-leave"]')
      .addEventListener('click', () => { document.getElementById('confirm').hidden = false })
    ${PLAYING_VIDEO}
  </script></body>`

// Meet's real page keeps the pre-join controls in the document after entry and
// only hides them, which is what makes "the first match" and "the visible
// match" different elements. The fixture reproduces that on purpose: an adapter
// that resolves the wrong copy stalls here exactly as it would on the real one.
const MEET_PAGE = ({
  joinText = 'Join now',
  delay = 0,
  consent = false,
  notice = false,
  lobby = false,
  noDevices = false,
  presenting = true,
  askName = false,
} = {}) => `<!doctype html><meta charset=utf-8><body>
  ${askName ? '<div id="namebox"><input aria-label="Your name"></div>' : ''}
  ${consent ? '<div id="consent"><button>Reject all</button></div>' : ''}
  ${notice ? '<div id="notice"><button>Got it</button></div>' : ''}
  ${noDevices ? '<div id="nodev"><button>Continue without microphone and camera</button></div>' : ''}
  <div id="preview">
    <button data-is-muted="true" aria-label="Turn on microphone">mic</button>
    <button data-is-muted="true" aria-label="Turn on camera">cam</button>
    <button id="join">${joinText}</button>
  </div>
  <div id="lobby" hidden>Asking to be let in…</div>
  <div id="call" hidden>
    <button data-is-muted="true" aria-label="Turn on microphone">mic</button>
    <button data-is-muted="true" aria-label="Turn on camera">cam</button>
    <button aria-label="Leave call">leave</button>
    ${presenting ? '<button id="present" aria-label="Present now">present</button>' : ''}
    <button id="stop" aria-label="Stop presenting" hidden>stop</button>
    <div id="menu" hidden><button>A tab</button></div>
    <button aria-label="People 2">2</button>
    <div data-participant-id="self" data-self-name="Google Tester"></div>
    <div data-participant-id="remote" data-sort-key="Alice">
      <video playsinline></video></div>
  </div>
  <script>
    const show = (id, on) => { document.getElementById(id).hidden = !on }
    for (const b of document.querySelectorAll('[data-is-muted]')) {
      b.addEventListener('click', () =>
        b.setAttribute('data-is-muted', b.getAttribute('data-is-muted') === 'true' ? 'false' : 'true'))
    }
    for (const b of document.querySelectorAll('#consent button, #notice button')) {
      b.addEventListener('click', () => b.parentElement.remove())
    }
    // Meet shows the name field first and the join control only once it has a
    // name, which is what makes the guest path two steps rather than one.
    const nameBox = document.getElementById('namebox')
    if (nameBox) {
      const field = nameBox.querySelector('input')
      document.getElementById('preview').hidden = true
      field.addEventListener('input', () => {
        const named = field.value.trim().length > 0
        nameBox.hidden = named
        document.getElementById('preview').hidden = !named
      })
    }
    document.getElementById('join').addEventListener('click', () => {
      ${lobby ? "show('preview', false); show('lobby', true);" : ''}
      setTimeout(() => {
        show('preview', false)
        ${lobby ? "show('lobby', false);" : ''}
        show('call', true)
      }, ${delay})
    })
    const present = document.getElementById('present')
    if (present) present.addEventListener('click', () => show('menu', true))
    const menuItem = document.querySelector('#menu button')
    if (menuItem) menuItem.addEventListener('click', () => {
      show('menu', false); show('present', false); show('stop', true)
    })
    document.getElementById('stop').addEventListener('click', () => {
      show('stop', false); show('present', true)
    })
    document.querySelector('[aria-label="Leave call"]').addEventListener('click', () => {
      show('call', false)
    })
    ${PLAYING_VIDEO}
  </script></body>`

const log = { info: () => {}, warn: () => {}, error: () => {} }
const fail = (name, message) => { throw new Error(`${name}: ${message}`) }

const drive = async (browser, {
  title, link, adapter, routes, expectCallId,
  expectAdmission = false,
  // Every platform draws its own share control, so the "host forbids sharing"
  // step has to be told which one to disable.
  shareSel = '[data-testid="call-controls-screen-share"]',
  shareBlocks = true,
  asGuest = false,
}) => {
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
  let screenPrepared = false
  const admission = []
  const ctx = { page, target, displayName: 'Bot 1', log, fail,
    options: { startCam: false, startMic: false },
    // A guest bot is exactly one that was handed no profile.
    meetProfile: asGuest
      ? null
      : { displayName: 'Google Tester', markNeedsSignIn: () => {} },
    setWaitingAdmission: (waiting) => admission.push(waiting),
    prepareScreen: async () => { screenPrepared = true } }

  try {
    const { callId } = await adapter.join(ctx)
    check('joins the call', true)
    check('reports the call id', callId === expectCallId, `got ${JSON.stringify(callId)}`)
    if (expectAdmission) {
      check('reports that the account is awaiting admission',
        admission.includes(true) && admission.at(-1) === false, JSON.stringify(admission))
    }

    check('mic reads off before arming', (await adapter.micState(page)) === 'off')
    check('cam reads off before arming', (await adapter.camState(page)) === 'off')
    check('setMic(true) turns it on', (await adapter.setMic(ctx, true)) === 'on')
    check('setCam(true) turns it on', (await adapter.setCam(ctx, true)) === 'on')
    check('setMic(false) turns it off', (await adapter.setMic(ctx, false)) === 'off')
    check('setMic(true) again is idempotent', (await adapter.setMic(ctx, true)) === 'on')

    if (adapter.screenState) {
      check('screen share reads off before sharing', (await adapter.screenState(page)) === 'off')
      check('setScreen(true) starts sharing', (await adapter.setScreen(ctx, true)) === 'on')
      check('a page to share is opened first', screenPrepared)
      check('setScreen(false) stops sharing', (await adapter.setScreen(ctx, false)) === 'off')
      if (shareBlocks) {
        await page.evaluate((sel) => { document.querySelector(sel).disabled = true }, shareSel)
      } else {
        // Meet does not disable the control, it removes it — an absent present
        // button while the leave button is up IS the host's restriction.
        await page.evaluate((sel) => { document.querySelector(sel).hidden = true }, shareSel)
      }
      check('a call that forbids sharing reports blocked',
        (await adapter.setScreen(ctx, true)) === 'blocked')
      await page.evaluate((sel) => {
        const el = document.querySelector(sel)
        el.disabled = false
        el.hidden = false
      }, shareSel)
    }

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

console.log('\nGoogle Meet link parsing')
const meetTarget = resolveLink('https://meet.google.com/AbC-DeFg-HiJ?authuser=1')
check('recognises a standard Meet call link',
  meetTarget.platform === 'meet' && meetTarget.callId === 'abc-defg-hij', JSON.stringify(meetTarget))
let invalidMeet = null
try { resolveLink('https://meet.google.com/not-a-meeting') } catch (error) { invalidMeet = error.message }
check('rejects a non-standard Meet path with an example',
  /abc-defg-hij/u.test(invalidMeet ?? ''), invalidMeet ?? 'accepted')
// Measured against live Meet, not guessed: the stream monitor reads a real
// connection there, and neither presenting nor codec preferences do anything.
check('declares the controls live Meet actually honours',
  meet.capabilities.mic && meet.capabilities.camera && meet.capabilities.rtc &&
    !meet.capabilities.screen && !meet.capabilities.codecs,
  JSON.stringify(meet.capabilities))
// Disabled by capability, not deleted — the implementation stays correct
// against the DOM so re-enabling it is one boolean if Meet ever accepts a share.
check('still implements presenting behind that switch',
  typeof meet.screenState === 'function' && typeof meet.setScreen === 'function')
const aliasTarget = resolveLink('https://meet.google.com/lookup/AbCd1234?pli=1')
check('recognises a nicknamed Meet link',
  aliasTarget.platform === 'meet' && aliasTarget.callId === 'AbCd1234',
  JSON.stringify(aliasTarget))
const scoped = resolveLink('https://meet.google.com/u/0/abc-defg-hij')
check('follows an account-scoped Meet link', scoped.callId === 'abc-defg-hij', JSON.stringify(scoped))
// No authuser: a guest has no account for it to select, and a profile has
// exactly one, so naming an account index can only ever be wrong.
check('pins the language and names no account in the URL it opens',
  /[?&]hl=en/u.test(scoped.url) && !/authuser/u.test(scoped.url), scoped.url)

await drive(browser, {
  title: 'Google Meet — direct entry',
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  expectCallId: 'abc-defg-hij',
  shareSel: '#present',
  shareBlocks: false,
  routes: () => MEET_PAGE({ joinText: 'Join now' }),
})

await drive(browser, {
  title: 'Google Meet — lobby admission',
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  expectCallId: 'abc-defg-hij',
  expectAdmission: true,
  shareSel: '#present',
  shareBlocks: false,
  routes: () => MEET_PAGE({ joinText: 'Ask to join', delay: 400, lobby: true }),
})

// The whole point of a guest: no Google account anywhere. It types a name and
// waits for the host, exactly as an Aloqa guest does.
await drive(browser, {
  title: 'Google Meet — anonymous guest',
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  expectCallId: 'abc-defg-hij',
  expectAdmission: true,
  asGuest: true,
  shareSel: '#present',
  shareBlocks: false,
  routes: () => MEET_PAGE({ joinText: 'Ask to join', delay: 400, lobby: true, askName: true }),
})

// A first sign-in meets both of these before it ever sees a join button, and
// they sit on top of it — an adapter that does not clear them never gets in.
await drive(browser, {
  title: 'Google Meet — consent banner and onboarding notice',
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  expectCallId: 'abc-defg-hij',
  shareSel: '#present',
  shareBlocks: false,
  routes: () => MEET_PAGE({ joinText: 'Join now', consent: true, notice: true }),
})

// --- Meet in-call details ---------------------------------------------------
// Two things the join drives above cannot reach: a control the host has taken
// away, and a page that only LOOKS like a call.
{
  console.log('\nGoogle Meet — in-call details')
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } })
  await context.route('**/*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: `<!doctype html><meta charset=utf-8><body>
        <div id="left">
          <button aria-label="Leave call" hidden>leave</button>
          <div data-participant-id="ghost" data-sort-key="Alice"><video playsinline></video></div>
        </div>
        <div id="call" hidden>
          <button data-is-muted="true" aria-label="Turn on microphone" aria-disabled="true">mic</button>
          <button data-is-muted="false" aria-label="Turn off camera">cam</button>
          <button aria-label="Leave call">leave</button>
          <div data-participant-id="self" data-self-name="Google Tester"></div>
        </div></body>`,
    }))
  const page = await context.newPage()
  await page.goto('https://meet.google.com/abc-defg-hij')

  // The post-call screen keeps a hidden leave button around. Treating its mere
  // presence as proof resurrects a bot that is not in the call at all, and
  // recoverIfAdmitted then flips a genuine failure back to "in call".
  const ghost = await meet.remote(page)
  check('a hidden leave button is not proof of being in the call', ghost.local === 0,
    JSON.stringify(ghost))

  await page.evaluate(() => { document.getElementById('call').hidden = false })
  const inCall = await meet.remote(page)
  check('a visible leave button stands in for a virtualised self tile', inCall.local === 1,
    JSON.stringify(inCall))

  // A host who has taken the microphone away leaves a control that looks
  // clickable. Blind-clicking it reports success for a bot that is still muted.
  check('a host-restricted microphone reads as request',
    (await meet.micState(page)) === 'request')
  check('and is never blind-clicked',
    (await meet.setMic({ page, log }, true)) === 'request')
  check('the camera beside it still reads normally', (await meet.camState(page)) === 'on')
  await context.close()
}

// --- refusals ---------------------------------------------------------------
// The message a bot fails with is what the user acts on, so it is worth
// pinning down too.
const expectFailure = async (title, { link, adapter, body, expect, within = 10, asGuest = false }) => {
  console.log(`\n${title}`)
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } })
  await context.route('**/*', (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body }))
  const page = await context.newPage()
  let markedSignedOut = false
  const ctx = {
    page,
    target: resolveLink(link),
    displayName: 'Bot 1',
    log,
    fail,
    options: { startCam: false, startMic: false },
    meetProfile: asGuest
      ? null
      : {
          displayName: 'Google Tester',
          markNeedsSignIn: () => { markedSignedOut = true },
        },
    setWaitingAdmission: () => {},
  }
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
  check('reports the refusal promptly', seconds < within, `took ${seconds.toFixed(1)}s`)
  if (/signed out/iu.test(message ?? '')) {
    check('marks the saved profile as needing sign-in', markedSignedOut)
  }
  await context.close()
}

await expectFailure('Aloqa — join refused', {
  link: 'https://aloqa.test/join/AbCdEfGhIjKlMnOpQrSt',
  adapter: aloqa,
  body: `<!doctype html><meta charset=utf-8><body>
    <div data-testid="guest-join-blocked">This invite link has expired</div></body>`,
  expect: /join refused: This invite link has expired/u,
})

await expectFailure('Google Meet — signed out', {
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  body: '<!doctype html><body><input aria-label="Enter your name"></body>',
  expect: /signed out.*reconnect/iu,
})

// Accepting Meet's offer puts a bot in the call publishing nothing at all —
// the exact failure this app exists to make visible. It must be recognised, and
// it must never be clicked.
await expectFailure('Google Meet — offered a call with no devices', {
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  body: `<!doctype html><body>
    <div><button>Continue without microphone and camera</button></div>
    <button data-is-muted="true" aria-label="Turn on microphone">mic</button>
    <button id="join">Join now</button></body>`,
  expect: /no camera or microphone/iu,
})

// Meet renders in the ACCOUNT's language, which overrides the hl in the link.
// A page with Meet's device toggles and none of its English controls is a
// language problem, and saying so beats timing out on a selector.
await expectFailure('Google Meet — account is not in English', {
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  body: `<!doctype html><body>
    <button data-is-muted="true" aria-label="microphone">mic</button>
    <button data-is-muted="true" aria-label="camera">cam</button>
    <button>Rejoindre maintenant</button></body>`,
  expect: /not in English/iu,
  within: 30,
})

// Meet turns anonymous visitors away from any meeting a personal Google
// account created, and it does so with the same words it uses for a blocked
// account. A guest told to "reconnect its account" would be nonsense.
await expectFailure('Google Meet — a meeting that takes no guests', {
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  asGuest: true,
  body: `<!doctype html><body>You can't join this video call
    <button>Return to home screen</button></body>`,
  expect: /does not take guests[\s\S]*personal Google account/iu,
})

await expectFailure('Google Meet — a guest asked to sign in', {
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  asGuest: true,
  body: '<!doctype html><body>Sign in to join this call</body>',
  expect: /does not take guests/iu,
})

await expectFailure('Google Meet — removed from the call', {
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  body: `<!doctype html><body>You've been removed from the meeting</body>`,
  expect: /refused this account.*removed/iu,
})

await expectFailure('Google Meet — admission refused', {
  link: 'https://meet.google.com/abc-defg-hij',
  adapter: meet,
  body: `<!doctype html><body>
    <button id="join">Ask to join</button>
    <div id="refused" hidden>You can't join this video call</div>
    <script>document.getElementById('join').onclick = () => {
      document.getElementById('refused').hidden = false
    }</script></body>`,
  expect: /Google Meet refused this account: You can't join this video call/iu,
})

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
