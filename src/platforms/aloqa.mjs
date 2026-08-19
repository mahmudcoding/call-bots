// Aloqa Web — anonymous guest join. Verified against aloqa-frontend develop
// @ 97a1746bb. If a deploy changes the UI, this file is the only one to edit.
//
// Behaviour here is unchanged from when Aloqa was the only platform: same
// selectors, same join sequence, same inverted aria-pressed device toggles.

const JOIN_TIMEOUT = 60_000
const TOGGLE_TIMEOUT = 8_000

export const SEL = {
  // guest entry (/join/<token>) — anonymous, no account.
  // The form carries no testids; the name attribute and the form submit are the
  // stable seam, and the submit label varies with the room's entry mode.
  guestName: 'input[name="display_name"]',
  guestSubmit: 'form button[type="submit"]',
  guestSurface: '[data-testid="guest-call-surface"]',
  guestBlocked: '[data-testid="guest-join-blocked"]',

  // in-call surface (shared with the member UI)
  leaveButton: '[data-testid="call-controls-leave"]',
  leaveConfirm: '[data-testid="call-leave-confirm-submit"]',

  // device toggles: the PAIR wrapper holds the testid, the toggle is its first
  // button, and aria-pressed="true" means the device is OFF
  micPair: '[data-testid="mic-control-pair"]',
  camPair: '[data-testid="cam-control-pair"]',
  micRequest: '[data-testid="call-controls-mic-request"]',
  camRequest: '[data-testid="call-controls-camera-request"]',

  // participant grid
  tile: '[data-testid="participant-tile"]',
}

const TOKEN_RE = /^[A-Za-z0-9._~-]{16,512}$/u

// Aloqa runs on any origin, so this is the catch-all: a path shaped like a call
// invite is ours. Returns null when the link is for someone else entirely.
const parse = (url) => {
  if (url.pathname === '/invite' || url.pathname.startsWith('/invite/')) {
    throw new Error('that is a workspace invite — paste the call\'s invite link (…/join/<token>)')
  }
  const match = url.pathname.match(/^\/(?:join|guest\/c)\/([^/?#]+)\/?$/u)
  if (!match) return null
  const token = decodeURIComponent(match[1])
  if (!TOKEN_RE.test(token)) throw new Error('that invite token looks malformed')
  return { origin: url.origin, url: `${url.origin}/join/${encodeURIComponent(token)}` }
}

// Bots join as guests, which have no lobby: name form -> call surface.
const join = async ({ page, target, displayName, fail }) => {
  await page.goto(target.url, { waitUntil: 'domcontentloaded' })

  const nameField = page.locator(SEL.guestName)
  const blocked = page.locator(SEL.guestBlocked)
  try {
    await nameField.or(blocked).first().waitFor({ state: 'visible', timeout: 30_000 })
  } catch {
    await fail('entry', 'the invite link page never resolved (dead or wrong link?)')
  }
  if (await blocked.isVisible().catch(() => false)) {
    const why = ((await blocked.textContent().catch(() => '')) ?? '').trim().slice(0, 120)
    await fail('blocked', `join refused: ${why}`)
  }

  await nameField.fill(displayName)
  const submit = page.locator(SEL.guestSubmit)
  await submit.waitFor({ state: 'visible', timeout: 10_000 })
  await submit.click()

  try {
    await page.locator(SEL.guestSurface).waitFor({ state: 'visible', timeout: JOIN_TIMEOUT })
  } catch {
    const waiting = await page
      .getByText(/Waiting for approval/iu)
      .isVisible()
      .catch(() => false)
    await fail(
      'join',
      waiting
        ? 'waiting for host approval — admit the bot, or use a call with entry mode Open'
        : 'the call never opened after submitting the name',
    )
  }

  // /guest/meeting/<id> — the only place the meeting id is exposed to us
  return { callId: page.url().match(/\/guest\/meeting\/([A-Za-z0-9_-]+)/u)?.[1] ?? null }
}

// The PAIR wrapper carries the testid; its first button is the toggle and
// aria-pressed="true" means the device is OFF. A host force-mute replaces the
// toggle with a request button — detect it, never blind-click.
const deviceState = async (page, pairSelector, requestSelector) => {
  if (await page.locator(requestSelector).isVisible().catch(() => false)) return 'request'
  const toggle = page.locator(`${pairSelector} button`).first()
  if (!(await toggle.isVisible().catch(() => false))) return 'unknown'
  const pressed = await toggle.getAttribute('aria-pressed')
  if (pressed === 'true') return 'off'
  if (pressed === 'false') return 'on'
  return 'unknown'
}

const setDevice = async ({ page, log }, kind, pairSelector, requestSelector, on) => {
  const current = await deviceState(page, pairSelector, requestSelector)
  if (current === 'request') {
    log.warn(`${kind} is host-restricted (request mode) — cannot toggle`)
    return 'request'
  }
  if (current === 'unknown') {
    log.warn(`${kind} toggle not found — not in call?`)
    return 'unknown'
  }
  const want = on ? 'on' : 'off'
  if (current === want) return want
  await page.locator(`${pairSelector} button`).first().click()
  try {
    await page.waitForFunction(
      ({ sel, value }) =>
        document.querySelector(`${sel} button`)?.getAttribute('aria-pressed') === value,
      { sel: pairSelector, value: on ? 'false' : 'true' },
      { timeout: TOGGLE_TIMEOUT },
    )
  } catch {
    log.warn(`${kind} did not reach "${want}" within ${TOGGLE_TIMEOUT}ms`)
  }
  return deviceState(page, pairSelector, requestSelector)
}

export default {
  id: 'aloqa',
  label: 'Aloqa',
  // Guests have no lobby, so devices start off and are armed after joining.
  armAfterJoin: true,
  parse,
  join,
  micState: (page) => deviceState(page, SEL.micPair, SEL.micRequest),
  camState: (page) => deviceState(page, SEL.camPair, SEL.camRequest),
  setMic: (ctx, on) => setDevice(ctx, 'mic', SEL.micPair, SEL.micRequest, on),
  setCam: (ctx, on) => setDevice(ctx, 'camera', SEL.camPair, SEL.camRequest, on),

  // Buttons are not proof: check that remote <video> elements really play.
  remote: (page) =>
    page.evaluate((sel) => {
      const tiles = [...document.querySelectorAll(sel.tile)]
      const summary = { local: 0, remote: 0, remotePlaying: 0, frozen: 0, names: [] }
      for (const tile of tiles) {
        const local = tile.getAttribute('data-local') === 'true'
        const name = tile.querySelector('[data-testid="participant-name"]')?.textContent?.trim()
        if (name) summary.names.push(`${local ? '*' : ''}${name}`)
        if (tile.getAttribute('data-video-frozen') === 'true') summary.frozen += 1
        if (local) {
          summary.local += 1
          continue
        }
        summary.remote += 1
        const video = tile.querySelector('[data-testid="participant-video"]')
        if (video && video.readyState >= 2 && video.videoWidth > 0 && !video.paused) {
          summary.remotePlaying += 1
        }
      }
      return summary
    }, SEL),

  leave: async ({ page, log }) => {
    await page.locator(SEL.leaveButton).click({ timeout: 5000 })
    const confirm = page.locator(SEL.leaveConfirm)
    const appeared = await confirm
      .waitFor({ state: 'visible', timeout: 2000 })
      .then(() => true)
      .catch(() => false)
    if (appeared) await confirm.click({ timeout: 3000 })
    log.info('left the call')
  },
}
