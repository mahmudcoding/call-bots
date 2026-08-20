import { launchGuest } from './browser.mjs'
import { guestColorHex } from './fixtures.mjs'
import { failureShot, mkLogger } from './log.mjs'
import { platformById } from './platforms/index.mjs'
import { screenHtml } from './screen.mjs'

// One anonymous participant: a real browser that opens the call link, types a
// name, and publishes fake-device audio and video. No account, nothing to
// provision. Everything platform-specific — how to get in, where the device
// toggles are, how to read the participant grid — lives in the adapter under
// src/platforms; this class only sequences it.
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
    this.platform = null
    this.screenPage = null
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

  #fail = async (name, message) => {
    const shot = await this.#shot(name)
    this.state = `error:${name}`
    this.lastError = message
    throw new Error(
      `[${this.label}] ${message} (url: ${this.page.url()}${shot ? `, screenshot: ${shot}` : ''})`,
    )
  }

  // The context the adapter works against.
  #ctx(target) {
    return {
      page: this.page,
      target: target ?? this.target,
      displayName: this.label,
      log: this.log,
      fail: this.#fail,
      options: this.options,
      prepareScreen: () => this.#prepareScreen(),
    }
  }

  async join(target) {
    const platform = platformById(target.platform)
    if (!platform) throw new Error(`no adapter for platform "${target.platform}"`)
    this.platform = platform
    this.target = target
    this.state = 'joining'

    const { callId } = await platform.join(this.#ctx(target))
    this.meetingId = callId ?? null
    this.state = 'in-call'

    // Set both devices to what was asked for rather than assuming a bot arrives
    // with them off: coming through an admission lobby it may not, and a bot
    // sent in muted that quietly publishes audio is worse than one that fails.
    // The clips stay attached either way, so a camera switched on later still
    // shows real footage rather than Chrome's default pattern.
    if (platform.armAfterJoin) {
      if (!this.options.noVideo) {
        await this.setCam(this.options.startCam !== false).catch(() => 'unknown')
      }
      if (!this.options.noAudio) {
        await this.setMic(this.options.startMic !== false).catch(() => 'unknown')
      }
      await this.#settleDevices()
    }
    this.log.info('in call')
  }

  // Aloqa can switch a guest's microphone on by itself as the connection
  // finishes, landing after we have already set what was asked for — so a bot
  // sent in muted starts publishing a moment later. Re-assert until it sticks.
  async #settleDevices() {
    const wantCam = this.options.startCam !== false
    const wantMic = this.options.startMic !== false
    let corrected = false
    for (let round = 0; round < 3; round += 1) {
      await this.page.waitForTimeout(1500)
      const [mic, cam] = await Promise.all([
        this.micState().catch(() => 'unknown'),
        this.camState().catch(() => 'unknown'),
      ])
      let drifted = false
      if (!this.options.noAudio && mic !== 'unknown' && mic !== (wantMic ? 'on' : 'off')) {
        await this.setMic(wantMic).catch(() => {})
        drifted = true
      }
      if (!this.options.noVideo && cam !== 'unknown' && cam !== (wantCam ? 'on' : 'off')) {
        await this.setCam(wantCam).catch(() => {})
        drifted = true
      }
      if (!drifted) break
      corrected = true
    }
    if (corrected) this.log.warn('the call changed this bot\'s devices after joining — set them back')
  }

  // --- in-call devices ------------------------------------------------------

  micState() {
    return this.platform ? this.platform.micState(this.page) : Promise.resolve('unknown')
  }

  camState() {
    return this.platform ? this.platform.camState(this.page) : Promise.resolve('unknown')
  }

  setMic(on) {
    return this.platform ? this.platform.setMic(this.#ctx(), on) : Promise.resolve('unknown')
  }

  setCam(on) {
    return this.platform ? this.platform.setCam(this.#ctx(), on) : Promise.resolve('unknown')
  }

  // A bot has no desktop, so it shares a page of its own: opened before the
  // share button is pressed, titled so Chrome's capture-source flag picks it,
  // and animated so anyone watching can see the feed is live.
  async #prepareScreen() {
    if (this.screenPage && !this.screenPage.isClosed()) return this.screenPage
    const page = await this.context.newPage()
    await page.setContent(screenHtml(this.label, guestColorHex(this.user.n - 1)))
    await this.page.bringToFront()
    this.screenPage = page
    return page
  }

  screenState() {
    return this.platform?.screenState
      ? this.platform.screenState(this.page)
      : Promise.resolve('unknown')
  }

  setScreen(on) {
    if (!this.platform?.setScreen) return Promise.resolve('unknown')
    return this.platform.setScreen(this.#ctx(), on)
  }

  // Buttons are not proof: check that remote <video> elements really play.
  async verifyRemote() {
    if (!this.platform) return null
    return this.platform.remote(this.page)
  }

  // A bot that gave up waiting and was admitted afterwards is in the call, so
  // its controls have to work again. Cheap to check and only asked about bots
  // that are not already in.
  async recoverIfAdmitted() {
    if (!this.platform || !this.page || this.state === 'in-call') return
    if (!String(this.state).startsWith('error:join')) return
    const summary = await this.platform.remote(this.page).catch(() => null)
    if (!summary || summary.local === 0) return
    this.log.info('admitted after all — back in the call')
    this.state = 'in-call'
    this.lastError = null
  }

  async leave() {
    // Never trust our own record here: a bot admitted after it timed out is
    // really in the call, and closing its browser without leaving strands it
    // there as a participant nobody can remove.
    if (!this.platform || !this.page) return
    this.state = 'leaving'
    try {
      await this.platform.leave(this.#ctx())
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
      await this.leave()
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
