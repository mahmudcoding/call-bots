import { launchGuest } from './browser.mjs'
import { failureShot, mkLogger } from './log.mjs'
import { platformById } from './platforms/index.mjs'

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

    // Devices start off, so a bot only publishes what it was sent in with. The
    // clips stay attached either way, so a camera switched on later still shows
    // real footage rather than Chrome's default pattern.
    if (platform.armAfterJoin) {
      if (!this.options.noVideo && this.options.startCam !== false) {
        await this.setCam(true).catch(() => 'unknown')
      }
      if (!this.options.noAudio && this.options.startMic !== false) {
        await this.setMic(true).catch(() => 'unknown')
      }
    }
    this.log.info('in call')
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

  // Buttons are not proof: check that remote <video> elements really play.
  async verifyRemote() {
    if (!this.platform) return null
    return this.platform.remote(this.page)
  }

  async leave() {
    if (this.state !== 'in-call') return
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
