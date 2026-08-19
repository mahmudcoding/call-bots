import { launchUser } from './browser.mjs'
import { failureShot, mkLogger } from './log.mjs'
import { SEL, guestJoinPath } from './selectors.mjs'
import { SimUser } from './simuser.mjs'

const JOIN_TIMEOUT = 60_000

// An anonymous participant joining through a guest invite link. No account, no
// stored session — everything in-call (mic/cam/share/tiles/leave) is identical
// to a signed-in user, so the in-call behavior is inherited from SimUser and
// only the entry path differs.
export class GuestUser extends SimUser {
  constructor(guest, media, options) {
    // `anonymous` makes the launcher skip storageState: a signed-in cookie
    // makes the guest page auto-join as that account instead of asking a name.
    super({ ...guest, anonymous: true }, media, options)
    this.log = mkLogger(guest.label, guest.index)
    this.isGuest = true
  }

  async start() {
    const launched = await launchUser(this.user, this.media, this.options)
    this.browser = launched.browser
    this.context = launched.context
    this.page = launched.page
    this.state = 'ready'
  }

  // Guests never see the lobby: name form -> (waiting room) -> call surface.
  async joinGuest(token, callId) {
    this.state = 'joining'
    await this.page.goto(guestJoinPath(token), { waitUntil: 'domcontentloaded' })

    const nameField = this.page.locator(SEL.guestName)
    const blocked = this.page.locator(SEL.guestBlocked)
    const autoJoin = this.page.locator(SEL.guestAutoJoin)
    try {
      await nameField
        .or(blocked)
        .or(autoJoin)
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
    } catch {
      await this.#guestFail('guest-entry', 'guest entry page never resolved (bad or dead link?)')
    }

    if (await blocked.isVisible().catch(() => false)) {
      const reason = (await blocked.textContent().catch(() => '')) ?? ''
      await this.#guestFail('guest-blocked', `join refused: ${reason.trim().slice(0, 120)}`)
    }
    if (await autoJoin.isVisible().catch(() => false)) {
      // should not happen with anonymous contexts, but fail loudly if it does
      await this.#guestFail('guest-signed-in', 'guest context carried a signed-in session')
    }

    await nameField.fill(this.label)
    const submit = this.page.locator(SEL.guestSubmit)
    await submit.waitFor({ state: 'visible', timeout: 10_000 })
    await submit.click()

    try {
      await this.page
        .locator(SEL.guestSurface)
        .waitFor({ state: 'visible', timeout: JOIN_TIMEOUT })
    } catch {
      const waiting = await this.page
        .getByText(/Waiting for approval/iu)
        .isVisible()
        .catch(() => false)
      await this.#guestFail(
        'guest-join',
        waiting
          ? 'waiting for host approval — admit the guest in the host UI, or use an Open call'
          : 'guest call surface never appeared after submitting the name',
      )
    }

    this.callId = callId ?? null
    this.state = 'in-call'

    // Guests never see the lobby, so devices start off: arm them in-call the
    // same way the call creator does.
    if (!this.options.noVideo) await this.setCam(true).catch(() => 'unknown')
    if (!this.options.noAudio) await this.setMic(true).catch(() => 'unknown')
    this.log.info('in call (guest)')
  }

  async #guestFail(name, message) {
    const shot = await failureShot(this.page, this.options.runDir, this.user.slug, name)
    this.state = `error:${name}`
    this.lastError = message
    throw new Error(
      `[${this.label}] ${message} (url: ${this.page.url()}${shot ? `, screenshot: ${shot}` : ''})`,
    )
  }

  // Guests have no account session to persist and no call to end for everyone.
  async teardown() {
    if (!this.browser) return
    try {
      if (this.state === 'in-call') await this.leaveCall()
    } catch (error) {
      this.log.warn(`teardown leave failed: ${error.message}`)
    }
    await Promise.race([
      this.browser.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ])
    this.state = 'closed'
    this.log.info('closed')
  }
}
