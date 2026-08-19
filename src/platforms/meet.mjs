// Google Meet — anonymous guest join. A bot opens the meeting link, types a
// name, asks to join, and waits in the lobby until the host admits it.
//
// Meet's markup is generated, so nothing here can lean on class names. The
// stable seams are aria-labels and the data-is-muted attribute Meet puts on its
// microphone and camera buttons. If Google changes those, this file is the only
// one to edit.

// The host has to notice the request and click Admit, so this waits far longer
// than a platform that lets guests straight in.
const LOBBY_TIMEOUT = 180_000
const GREEN_ROOM_TIMEOUT = 45_000
const TOGGLE_TIMEOUT = 8_000

const SEL = {
  name: 'input[aria-label*="your name" i], input[placeholder*="your name" i]',
  // "Ask to join" for anonymous guests, "Join now" when Meet recognises the
  // browser as a member of the meeting's organisation.
  joinButton: 'button:has-text("Ask to join"), button:has-text("Join now")',
  leaveButton: '[aria-label*="Leave call" i]',
  // Meet marks both device buttons with their current state.
  mic: '[data-is-muted][aria-label*="microphone" i]',
  cam: '[data-is-muted][aria-label*="camera" i]',
}

// meet.google.com/abc-defg-hij — the code is the only part that matters.
const CODE_RE = /^\/([a-z]{3}-[a-z]{4}-[a-z]{3})\/?$/u

const parse = (url) => {
  if (url.hostname !== 'meet.google.com') return null
  const match = url.pathname.match(CODE_RE)
  if (!match) {
    throw new Error(
      `expected a Meet link like meet.google.com/abc-defg-hij, got ${url.pathname}`,
    )
  }
  const code = match[1]
  return { origin: url.origin, url: `${url.origin}/${code}`, callId: code }
}

// Consent banners block everything behind them. Decline non-essential cookies
// rather than accepting on the user's behalf; if only an accept button exists,
// leave it alone and let the join attempt report what it hit.
const declineConsent = async (page) => {
  const reject = page.locator('button:has-text("Reject all"), button:has-text("Reject")').first()
  if (await reject.isVisible({ timeout: 2000 }).catch(() => false)) {
    await reject.click().catch(() => {})
    await page.waitForLoadState('domcontentloaded').catch(() => {})
  }
}

// Meet shows a dismissable "Got it" card over the green room often enough that
// skipping it costs a join.
const dismissNotices = async (page) => {
  const got = page.locator('button:has-text("Got it")').first()
  if (await got.isVisible({ timeout: 1500 }).catch(() => false)) await got.click().catch(() => {})
}

const REFUSALS = [
  /You can'?t join this (video )?call/iu,
  /denied your request/iu,
  /Check your meeting code/iu,
  /You'?ve been removed/iu,
  /not allowed to join/iu,
  /Your browser (is ?n'?t|is not) supported/iu,
]

// Read the page text once and match here, rather than a locator per pattern:
// getByText mangles a regex containing an apostrophe, and this is polled while
// a bot sits in the lobby.
const refusalText = async (page) => {
  const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
  for (const pattern of REFUSALS) {
    if (!pattern.test(text)) continue
    const line = text.split('\n').find((candidate) => pattern.test(candidate))
    return (line ?? text).trim().slice(0, 140)
  }
  return null
}

const join = async ({ page, target, displayName, log, fail }) => {
  await page.goto(target.url, { waitUntil: 'domcontentloaded' })
  await declineConsent(page)
  await dismissNotices(page)

  const nameField = page.locator(SEL.name).first()
  const joinButton = page.locator(SEL.joinButton).first()
  try {
    await nameField.or(joinButton).first().waitFor({ state: 'visible', timeout: GREEN_ROOM_TIMEOUT })
  } catch {
    const why = await refusalText(page)
    await fail('entry', why ?? 'the Meet green room never appeared (dead link, or Meet blocked the browser)')
  }

  // A signed-in profile skips straight to "Join now" with no name to type.
  if (await nameField.isVisible().catch(() => false)) {
    await nameField.fill(displayName)
  }

  await joinButton.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  if (!(await joinButton.isVisible().catch(() => false))) {
    const why = await refusalText(page)
    await fail('entry', why ?? 'Meet showed no join button')
  }
  await joinButton.click()
  log.info('asked to join — admit the bot in Meet')

  // Admitted when the in-call controls appear. Meet can also refuse while we
  // wait, so watch for both instead of only timing out.
  const inCall = page.locator(SEL.leaveButton).first()
  const deadline = Date.now() + LOBBY_TIMEOUT
  for (;;) {
    if (await inCall.isVisible().catch(() => false)) break
    const why = await refusalText(page)
    if (why) await fail('join', why)
    if (Date.now() > deadline) {
      await fail('join', 'nobody admitted the bot — click Admit in Meet, then send it again')
    }
    await page.waitForTimeout(1000)
  }

  return { callId: target.callId }
}

const deviceState = async (page, selector) => {
  const button = page.locator(selector).first()
  if (!(await button.isVisible().catch(() => false))) return 'unknown'
  const muted = await button.getAttribute('data-is-muted')
  if (muted === 'true') return 'off'
  if (muted === 'false') return 'on'
  return 'unknown'
}

const setDevice = async ({ page, log }, kind, selector, on) => {
  const current = await deviceState(page, selector)
  if (current === 'unknown') {
    log.warn(`${kind} button not found — not in call?`)
    return 'unknown'
  }
  const want = on ? 'on' : 'off'
  if (current === want) return want
  await page.locator(selector).first().click()
  try {
    await page.waitForFunction(
      ({ sel, value }) => document.querySelector(sel)?.getAttribute('data-is-muted') === value,
      { sel: selector, value: on ? 'false' : 'true' },
      { timeout: TOGGLE_TIMEOUT },
    )
  } catch {
    log.warn(`${kind} did not reach "${want}" within ${TOGGLE_TIMEOUT}ms`)
  }
  return deviceState(page, selector)
}

export default {
  id: 'meet',
  label: 'Google Meet',
  // Meet carries the green room's device state into the call, and permission is
  // already granted, so a bot arrives publishing. Arming again is harmless and
  // covers a meeting that force-mutes on entry.
  armAfterJoin: true,
  parse,
  join,
  micState: (page) => deviceState(page, SEL.mic),
  camState: (page) => deviceState(page, SEL.cam),
  setMic: (ctx, on) => setDevice(ctx, 'mic', SEL.mic, on),
  setCam: (ctx, on) => setDevice(ctx, 'camera', SEL.cam, on),

  // Meet gives each tile a participant id and marks the bot's own tile, so the
  // same "are remote tiles really playing" check works here too.
  remote: (page) =>
    page.evaluate(() => {
      const tiles = [...document.querySelectorAll('[data-participant-id]')]
      const summary = { local: 0, remote: 0, remotePlaying: 0, frozen: 0, names: [] }
      for (const tile of tiles) {
        const local = tile.hasAttribute('data-self-name')
        const name = tile.getAttribute('data-self-name') ?? tile.getAttribute('data-sort-key')
        if (name) summary.names.push(`${local ? '*' : ''}${name.split('_')[0]}`)
        if (local) {
          summary.local += 1
          continue
        }
        summary.remote += 1
        const video = tile.querySelector('video')
        if (video && video.readyState >= 2 && video.videoWidth > 0 && !video.paused) {
          summary.remotePlaying += 1
        }
      }
      return summary
    }),

  leave: async ({ page, log }) => {
    await page.locator(SEL.leaveButton).first().click({ timeout: 5000 })
    log.info('left the call')
  },
}
