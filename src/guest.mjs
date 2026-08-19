import { launchGuest } from './browser.mjs'
import { failureShot, mkLogger } from './log.mjs'
import { SEL, guestJoinPath } from './selectors.mjs'

const JOIN_TIMEOUT = 60_000
const TOGGLE_TIMEOUT = 8_000

// One anonymous participant: a real browser that opens the call's invite link,
// types a name, and publishes fake-device audio and video. No account, no
// workspace, nothing to provision.
export class Guest {
  constructor(guest, media, options) {
    this.user = guest // {n, label, slug, index}
    this.media = media
    this.options = options
    this.log = mkLogger(guest.label, guest.index)
    this.state = 'created'
    this.meetingId = null
    this.browser = null
    this.context = null
    this.page = null
    this.lastError = null
  }

  get label() {
    return this.user.label
  }

  async start() {
    const launched = await launchGuest(this.user, this.media, this.options)
    this.browser = launched.browser
    this.context = launched.context
    this.page = launched.page
    this.state = 'ready'
  }

  async #shot(name) {
    return failureShot(this.page, this.options.runDir, this.user.slug, name)
  }

  async #fail(name, message) {
    const shot = await this.#shot(name)
    this.state = `error:${name}`
    this.lastError = message
    throw new Error(
      `[${this.label}] ${message} (url: ${this.page.url()}${shot ? `, screenshot: ${shot}` : ''})`,
    )
  }

  // Guests never see a lobby: name form -> (waiting room) -> call surface.
  async join(token) {
    this.state = 'joining'
    await this.page.goto(guestJoinPath(token), { waitUntil: 'domcontentloaded' })

    const nameField = this.page.locator(SEL.guestName)
    const blocked = this.page.locator(SEL.guestBlocked)
    try {
      await nameField.or(blocked).first().waitFor({ state: 'visible', timeout: 30_000 })
    } catch {
      await this.#fail('entry', 'the invite link page never resolved (dead or wrong link?)')
    }
    if (await blocked.isVisible().catch(() => false)) {
      const why = ((await blocked.textContent().catch(() => '')) ?? '').trim().slice(0, 120)
      await this.#fail('blocked', `join refused: ${why}`)
    }

    await nameField.fill(this.label)
    const submit = this.page.locator(SEL.guestSubmit)
    await submit.waitFor({ state: 'visible', timeout: 10_000 })
    await submit.click()

    try {
      await this.page.locator(SEL.guestSurface).waitFor({ state: 'visible', timeout: JOIN_TIMEOUT })
    } catch {
      const waiting = await this.page
        .getByText(/Waiting for approval/iu)
        .isVisible()
        .catch(() => false)
      await this.#fail(
        'join',
        waiting
          ? 'waiting for host approval — admit the guest, or use a call with entry mode Open'
          : 'the call never opened after submitting the name',
      )
    }

    // /guest/meeting/<id> — the only place the meeting id is exposed to us
    this.meetingId = this.page.url().match(/\/guest\/meeting\/([A-Za-z0-9_-]+)/u)?.[1] ?? null
    this.state = 'in-call'

    // no lobby means devices start off; arm them the way a person would
    if (!this.options.noVideo) await this.setCam(true).catch(() => 'unknown')
    if (!this.options.noAudio) await this.setMic(true).catch(() => 'unknown')
    this.log.info('in call')
  }

  // --- in-call devices ------------------------------------------------------
  // The PAIR wrapper carries the testid; its first button is the toggle and
  // aria-pressed="true" means the device is OFF. A host force-mute replaces the
  // toggle with a request button — detect it, never blind-click.

  async #deviceState(pairSelector, requestSelector) {
    if (await this.page.locator(requestSelector).isVisible().catch(() => false)) return 'request'
    const toggle = this.page.locator(`${pairSelector} button`).first()
    if (!(await toggle.isVisible().catch(() => false))) return 'unknown'
    const pressed = await toggle.getAttribute('aria-pressed')
    if (pressed === 'true') return 'off'
    if (pressed === 'false') return 'on'
    return 'unknown'
  }

  micState() {
    return this.#deviceState(SEL.micPair, SEL.micRequest)
  }

  camState() {
    return this.#deviceState(SEL.camPair, SEL.camRequest)
  }

  async #setDevice(kind, pairSelector, requestSelector, on) {
    const current = await this.#deviceState(pairSelector, requestSelector)
    if (current === 'request') {
      this.log.warn(`${kind} is host-restricted (request mode) — cannot toggle`)
      return 'request'
    }
    if (current === 'unknown') {
      this.log.warn(`${kind} toggle not found — not in call?`)
      return 'unknown'
    }
    const want = on ? 'on' : 'off'
    if (current === want) return want
    await this.page.locator(`${pairSelector} button`).first().click()
    try {
      await this.page.waitForFunction(
        ({ sel, value }) =>
          document.querySelector(`${sel} button`)?.getAttribute('aria-pressed') === value,
        { sel: pairSelector, value: on ? 'false' : 'true' },
        { timeout: TOGGLE_TIMEOUT },
      )
    } catch {
      this.log.warn(`${kind} did not reach "${want}" within ${TOGGLE_TIMEOUT}ms`)
    }
    return this.#deviceState(pairSelector, requestSelector)
  }

  setMic(on) {
    return this.#setDevice('mic', SEL.micPair, SEL.micRequest, on)
  }

  setCam(on) {
    return this.#setDevice('camera', SEL.camPair, SEL.camRequest, on)
  }

  // Buttons are not proof: check that remote <video> elements really play.
  async verifyRemote() {
    return this.page.evaluate((sel) => {
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
    }, SEL)
  }

  async leave() {
    if (this.state !== 'in-call') return
    this.state = 'leaving'
    try {
      await this.page.locator(SEL.leaveButton).click({ timeout: 5000 })
      const confirm = this.page.locator(SEL.leaveConfirm)
      const appeared = await confirm
        .waitFor({ state: 'visible', timeout: 2000 })
        .then(() => true)
        .catch(() => false)
      if (appeared) await confirm.click({ timeout: 3000 })
      this.log.info('left the call')
    } catch {
      this.log.warn('leave button did not respond; closing the browser instead')
    }
    this.state = 'ready'
  }

  async shot(name = 'manual') {
    return this.#shot(name)
  }

  async teardown() {
    if (!this.browser) return
    try {
      if (this.state === 'in-call') await this.leave()
    } catch (error) {
      this.log.warn(`teardown failed: ${error.message}`)
    }
    await Promise.race([
      this.browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ])
    this.state = 'closed'
    this.log.info('closed')
  }
}
