import { readFile } from 'node:fs/promises'

import { launchGuest } from './browser.mjs'
import { guestColorHex } from './fixtures.mjs'
import { failureShot, mkLogger } from './log.mjs'
import { platformById } from './platforms/index.mjs'
import { installMonitor, rtcSnapshot, rtcSummary } from './rtc.mjs'
import { screenHtml, screenVideoPath } from './screen.mjs'

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
    // Preferred send codecs by role; null means the platform's own default.
    // A per-guest object on purpose: every guest of a batch shares one options
    // reference, and a runtime switch must never leak to the siblings.
    this.codecs = {
      audio: options.audioCodec ?? null,
      video: options.videoCodec ?? null,
      screen: options.screenCodec ?? null,
    }
    this.log = mkLogger(guest.label, guest.index)
    this.state = 'created'
    this.meetingId = null
    this.browser = null
    this.context = null
    this.page = null
    this.lastError = null
    this.platform = null
    this.screenPage = null
    this.monitorInstall = null // in-flight stream-monitor install, so retries dedupe
    this.monitorWarned = false // warn once per breakage, not every status tick
  }

  get label() {
    return this.user.label
  }

  async start() {
    const launched = await launchGuest(this.user, this.media, this.options, this.codecs)
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
    // After the devices settle, so the injection never competes with the
    // arming clicks. Losing the monitor is not losing the bot.
    await this.#ensureMonitor().catch(() => {})
    // The join navigated, and navigation re-seeds the page with the LAUNCH
    // codec preferences — anything switched while this bot was still on its
    // way has to be pushed again now that the call page is settled.
    await this.#syncCodecs().catch(() => {})
    this.log.info('in call')
  }

  // Installs the vendored stream monitor into the call page. Deduped: the
  // status poll retries through here whenever the page lost it (a navigation,
  // a late admission), and two concurrent installs would re-run the monitor's
  // IIFE, which toggles its panel instead of installing.
  #ensureMonitor() {
    if (this.monitorInstall) return this.monitorInstall
    this.monitorInstall = installMonitor(this.page)
      .then((hidden) => {
        this.monitorWarned = false
        return hidden
      })
      .catch((error) => {
        if (!this.monitorWarned) {
          this.monitorWarned = true
          this.log.warn(`stream monitor install failed: ${error.message}`)
        }
        throw error
      })
      .finally(() => {
        this.monitorInstall = null
      })
    return this.monitorInstall
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

  // --- send codecs ----------------------------------------------------------

  // Preferred send codec for one role: 'audio', 'video' (the camera) or
  // 'screen'. A codec only ever changes through a negotiation the call takes
  // part in — an in-place encoder switch sends fine but the SFU stops
  // forwarding the track, blacking the bot out for every other participant.
  // So: store the preference, offer the page a renegotiation (enough for apps
  // that honour negotiationneeded), and when the app ignores it, make a fresh
  // negotiation happen — restart the share for the screen role, rejoin the
  // call for the others. Result strings ride the same toast path as the other
  // actions.
  async setCodec(role, codec) {
    if (!['audio', 'video', 'screen'].includes(role)) {
      throw new Error(`unknown codec role "${role}" — audio, video or screen`)
    }
    const wanted = typeof codec === 'string' && codec.trim() ? codec.trim().toLowerCase() : null
    this.codecs = { ...this.codecs, [role]: wanted }
    if (!this.page || this.page.isClosed()) return 'unknown'
    const res = await this.page
      .evaluate((arg) => window.__botSetCodec__?.(arg.role, arg.codec) ?? null, {
        role,
        codec: wanted,
      })
      .catch(() => null)
    if (!res) return 'unknown'
    if (res.ok === false) return res.reason === 'unsupported' ? 'unsupported' : 'unknown'
    if (this.state !== 'in-call') return 'requested'

    // A LiveKit app takes exactly one consistent path: its own republish,
    // where the publish request names the codec and the SFU consents. The
    // shim reaches the Room through the page's component tree.
    const lk = await this.#lkSwitch(role, wanted)
    if (lk.ok) {
      if (wanted === null) return 'default'
      if (await this.#codecSettled(role, wanted, 10_000)) return 'applied'
      return res.negotiated === false ? 'unavailable' : 'requested'
    }
    if (lk.reason === 'unpublishable') return 'unavailable'

    if (role === 'screen') {
      const sharing = await this.screenState().catch(() => 'unknown')
      // Nothing to renegotiate until a share is up; the preference is stored
      // and applied the moment a share starts.
      if (sharing !== 'on') return wanted === null ? 'default' : 'requested'
      if (wanted !== null && (await this.#codecSettled(role, wanted))) return 'applied'
      // A share restart is a fresh publication carrying the preference.
      await this.setScreen(false).catch(() => {})
      await this.setScreen(true).catch(() => {})
      if (wanted === null) return 'default'
      if (await this.#codecSettled(role, wanted, 6000)) return 'applied'
      return res.negotiated === false ? 'unavailable' : 'requested'
    }

    // Apps that renegotiate on demand settle right here, no rejoin needed.
    if (wanted !== null && (await this.#codecSettled(role, wanted))) return 'applied'
    // Last resort: rejoin, so the preference lands at a join negotiation the
    // call itself answers.
    const rejoined = await this.#rejoinWithCodecs()
    if (!rejoined) return 'unknown'
    if (wanted === null) return 'default'
    if (await this.#codecSettled(role, wanted, 8000)) return 'applied'
    return res.negotiated === false ? 'unavailable' : 'requested'
  }

  #lkSwitch(role, codec) {
    if (!this.page || this.page.isClosed()) return Promise.resolve({ ok: false, reason: 'no-page' })
    return this.page
      .evaluate(
        (arg) => window.__botLkSwitch__?.(arg.role, arg.codec) ?? { ok: false, reason: 'no-shim' },
        { role, codec },
      )
      .catch(() => ({ ok: false, reason: 'evaluate' }))
  }

  // Leave and come straight back with the CURRENT preferences seeded at
  // document-start: the join offer then carries them, the call answers, and
  // every other participant keeps decoding a codec their side agreed to. The
  // launch-time init script reseeds launch values on navigation, so a fresh
  // script — added later, running later — asserts the runtime ones on top.
  // Devices and an active share are put back the way they were.
  async #rejoinWithCodecs() {
    const mic = await this.micState().catch(() => 'unknown')
    const cam = await this.camState().catch(() => 'unknown')
    const sharing = (await this.screenState().catch(() => 'unknown')) === 'on'
    try {
      await this.context.addInitScript((codecs) => {
        if (!window.__botSetCodec__) return
        for (const [role, codec] of Object.entries(codecs)) window.__botSetCodec__(role, codec)
      }, { ...this.codecs })
      await this.leave()
      await this.join(this.target)
    } catch (error) {
      this.log.warn(`rejoin for the codec change failed: ${error.message}`)
      return false
    }
    if (mic === 'on' || mic === 'off') await this.setMic(mic === 'on').catch(() => {})
    if (cam === 'on' || cam === 'off') await this.setCam(cam === 'on').catch(() => {})
    if (sharing) await this.setScreen(true).catch(() => {})
    return true
  }

  // Polls the monitor snapshot until every outbound stream of the role reports
  // the codec. The monitor ticks once a second, so half-second polls inside a
  // small budget see the flip about as fast as it can be seen. RED never shows
  // in stats — Chrome attributes a RED stream to the opus inside it — so red
  // settles on the negotiated top codec instead.
  async #codecSettled(role, wanted, budgetMs = 2500) {
    const matches = (stream) => {
      if (role === 'audio') return stream.kind === 'audio'
      if (role === 'screen') return stream.kind === 'video' && stream.role === 'screen'
      return stream.kind === 'video' && stream.role !== 'screen'
    }
    const deadline = Date.now() + budgetMs
    while (Date.now() < deadline) {
      if (wanted === 'red') {
        const top = await this.page
          .evaluate((r) => window.__botCodecTop__?.(r) ?? null, role)
          .catch(() => null)
        if (top === 'red') return true
        // The snapshot labels an engaged RED wrap from its payload signature
        // (no state anywhere admits to it) — trust the same label the panel
        // shows.
        const snap = await this.rtcSnapshot()
        const mine = (snap?.outbound ?? []).filter(
          (stream) => stream.kind === 'audio' && (stream.kbps ?? 0) > 0,
        )
        if (
          mine.length > 0 &&
          mine.every((stream) =>
            ['red', 'opus+red'].includes((stream.codec?.name ?? '').toLowerCase()),
          )
        ) {
          return true
        }
      } else {
        const snap = await this.rtcSnapshot()
        // Carrying rows only: a negotiation-based switch starts a fresh
        // stream while the old codec's row lingers at 0 kbps for a few
        // seconds — dying rows must not vote.
        const mine = (snap?.outbound ?? []).filter(
          (stream) => matches(stream) && (stream.kbps ?? 0) > 0,
        )
        if (
          mine.length > 0 &&
          mine.every((stream) => (stream.codec?.name ?? '').toLowerCase() === wanted)
        ) {
          return true
        }
      }
      await this.page.waitForTimeout(500).catch(() => {})
    }
    return false
  }

  // Re-assert the stored preferences inside the page, skipping what the page
  // already has so a plain launch-time preference does not renegotiate twice.
  async #syncCodecs() {
    const wanted = Object.entries(this.codecs).filter(([, codec]) => codec !== null)
    if (wanted.length === 0) return
    const current = await this.page
      .evaluate(() => window.__botCodecState__?.()?.prefs ?? null)
      .catch(() => null)
    for (const [role, codec] of wanted) {
      if (current && current[role] === codec) continue
      await this.page
        .evaluate((arg) => window.__botSetCodec__?.(arg.role, arg.codec) ?? null, { role, codec })
        .catch(() => null)
    }
  }

  // A bot has no desktop, so it shares a page of its own: opened before the
  // share button is pressed, titled so Chrome's capture-source flag picks it,
  // and animated so anyone watching can see the feed is live.
  async #prepareScreen() {
    if (this.screenPage && !this.screenPage.isClosed()) return this.screenPage
    const page = await this.context.newPage()
    const video = screenVideoPath()
    // Served from a path on the call's own origin that nothing else uses, so
    // the page and its footage are same-origin and no other request is touched.
    const base = `${this.options.baseUrl}/__call-bots-screen`
    // Context-wide, not page-scoped: the capture shim inside the CALL page
    // builds the synthetic share from this same clip URL.
    await this.context.route(`${base}*`, async (route) => {
      if (route.request().url().includes('asset=video') && video) {
        return route.fulfill({
          status: 200,
          contentType: 'video/webm',
          body: await readFile(video),
        })
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/html; charset=utf-8',
        body: screenHtml(
          this.label,
          guestColorHex(this.user.n - 1),
          video ? `${base}?asset=video` : null,
        ),
      })
    })
    await page.goto(base)
    await this.page.bringToFront()
    this.screenPage = page
    return page
  }

  screenState() {
    return this.platform?.screenState
      ? this.platform.screenState(this.page)
      : Promise.resolve('unknown')
  }

  async setScreen(on) {
    if (!this.platform?.setScreen) return 'unknown'
    const state = await this.platform.setScreen(this.#ctx(), on)
    // A share born under a stored screen preference republishes to it right
    // away, the LiveKit way — the publication is seconds old and cheap to
    // swap, and the SFU consents to the codec in the process.
    if (on && state === 'on' && this.codecs.screen) {
      await this.#lkSwitch('screen', this.codecs.screen).catch(() => {})
    }
    return state
  }

  // Buttons are not proof: check that remote <video> elements really play.
  async verifyRemote() {
    if (!this.platform) return null
    return this.platform.remote(this.page)
  }

  // Small per-tick network summary for the dashboard's state snapshot. null
  // means nothing to show — and when the cause is a page that lost its monitor
  // (navigated, or admitted after a timeout), a reinstall is kicked off so the
  // next tick heals on its own.
  async rtcSummary() {
    if (this.state !== 'in-call' || !this.page) return null
    const summary = await rtcSummary(this.page).catch(() => null)
    if (summary === null) this.#ensureMonitor().catch(() => {})
    return summary
  }

  // Full sanitized stream model for the expanded card panel.
  async rtcSnapshot() {
    if (this.state !== 'in-call' || !this.page) return null
    return rtcSnapshot(this.page).catch(() => null)
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
