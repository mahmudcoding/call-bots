import { authMe, endMeeting, findStringField, leaveMeeting, meetingsCurrent } from './appApi.mjs'
import { launchUser, saveState, shareTabTitle } from './browser.mjs'
import { failureShot, mkLogger } from './log.mjs'
import { SEL, callDeepLinkPath, callsHubPath, guestJoinPath, loginPath } from './selectors.mjs'

const LOGIN_TIMEOUT = 30_000
const JOIN_TIMEOUT = 45_000
const TOGGLE_TIMEOUT = 8_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class SimUser {
  constructor(user, media, options) {
    this.user = user
    this.media = media
    this.options = options
    this.log = mkLogger(user.label, user.index)
    this.state = 'created'
    this.callId = null
    this.browser = null
    this.context = null
    this.page = null
    this.shareTab = null
    this.sharing = false
    this.lastError = null
  }

  get label() {
    return this.user.label
  }

  async start() {
    const launched = await launchUser(this.user, this.media, this.options)
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
    const where = ` (url: ${this.page.url()}${shot ? `, screenshot: ${shot}` : ''})`
    throw new Error(`[${this.label}] ${message}${where}`)
  }

  // Valid session = auth/me answers with our email. Anything else goes through
  // the real login form. `next` keeps the post-login redirect on target.
  async ensureLoggedIn(nextPath) {
    const probe = await authMe(this.context, this.options.baseUrl)
    if (probe.ok && probe.email === this.user.email.toLowerCase()) {
      this.log.info('session reused (auth/me ok)')
      return
    }
    if (probe.ok) await this.context.clearCookies()

    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#loginOnce(nextPath)
        break
      } catch (error) {
        if (attempt >= 2) throw error
        this.log.warn(`login attempt ${attempt} failed (${error.message}); retrying`)
        await sleep(3000)
      }
    }
    const verify = await authMe(this.context, this.options.baseUrl)
    if (!verify.ok || verify.email !== this.user.email.toLowerCase()) {
      await this.#fail(
        'login-verify',
        `login looked successful but auth/me reports "${verify.email}"`,
      )
    }
    await saveState(this.context, this.user.email)
    this.log.info('signed in')
  }

  async #loginOnce(nextPath) {
    await this.page.goto(loginPath(nextPath), { waitUntil: 'domcontentloaded' })
    await this.page.locator(SEL.loginEmail).fill(this.user.email)
    await this.page.locator(SEL.loginPassword).fill(this.user.password)
    await this.page.locator(SEL.loginSubmit).click()
    try {
      await this.page.waitForURL((url) => !url.pathname.startsWith('/login'), {
        timeout: LOGIN_TIMEOUT,
      })
    } catch {
      await this.#fail(
        'login',
        'still on /login after submit — wrong password, 2FA enabled, or rate limit',
      )
    }
  }

  // Lobby pills carry data-camera-enabled / data-mic-enabled; camera defaults
  // OFF, mic defaults ON. Click until the attribute matches, never blind.
  async #setLobbyPill(selector, attribute, want) {
    const pill = this.page.locator(selector).first()
    await pill.waitFor({ state: 'visible', timeout: 10_000 })
    if ((await pill.getAttribute(attribute)) === String(want)) return
    await pill.click()
    await this.page
      .waitForFunction(
        ({ sel, attr, value }) =>
          document.querySelector(sel)?.getAttribute(attr) === value,
        { sel: selector, attr: attribute, value: String(want) },
        { timeout: TOGGLE_TIMEOUT },
      )
      .catch(() => this.#fail('lobby-pill', `${attribute} did not become ${want}`))
  }

  async joinCall(wsId, callId) {
    this.state = 'joining'
    const deepLink = callDeepLinkPath(wsId, callId)
    await this.page.goto(deepLink, { waitUntil: 'domcontentloaded' })

    const outcome = this.page
      .locator(
        `${SEL.lobbyPage}, ${SEL.passwordGate}, ${SEL.loginEmail}, ${SEL.leaveButton}`,
      )
      .first()
    try {
      await outcome.waitFor({ state: 'visible', timeout: 30_000 })
    } catch {
      await this.#fail('lobby', 'neither lobby, password gate, nor call surface appeared')
    }

    if (await this.page.locator(SEL.loginEmail).isVisible().catch(() => false)) {
      // session died between probe and navigation — sign in and land back here
      await this.ensureLoggedIn(deepLink)
      await this.page.goto(deepLink, { waitUntil: 'domcontentloaded' })
      await this.page.locator(SEL.lobbyPage).waitFor({ state: 'visible', timeout: 30_000 })
    }
    if (await this.page.locator(SEL.passwordGate).isVisible().catch(() => false)) {
      await this.#fail('password-gate', 'call requires a password — recreate it without one')
    }
    await this.#completeLobbyJoin()

    this.callId = callId
    this.wsId = wsId
    this.state = 'in-call'
    this.log.info('in call')
  }

  // Lobby -> in call. Shared by the deep-link path and the invite-link path,
  // which converges on the same lobby after its automatic join.
  async #completeLobbyJoin() {
    if (await this.page.locator(SEL.leaveButton).isVisible().catch(() => false)) {
      this.log.info('already in the call')
      return
    }
    await this.#setLobbyPill(SEL.lobbyCamPill, 'data-camera-enabled', !this.options.noVideo)
    await this.#setLobbyPill(SEL.lobbyMicPill, 'data-mic-enabled', !this.options.noAudio)

    const join = this.page.locator(SEL.lobbyJoin)
    // lobby-join uses aria-disabled and stays clickable in the DOM
    await this.page
      .waitForFunction(
        (sel) => {
          const el = document.querySelector(sel)
          return el !== null && !el.hasAttribute('aria-disabled')
        },
        SEL.lobbyJoin,
        { timeout: 15_000 },
      )
      .catch(() => this.#fail('lobby-join-disabled', 'Join button never became enabled'))
    await join.click()

    try {
      // the app router.replaces away from the deep link — gate on the
      // toolbar, never the URL
      await this.page.locator(SEL.leaveButton).waitFor({
        state: 'visible',
        timeout: JOIN_TIMEOUT,
      })
    } catch {
      const stuckInLobby = await this.page.locator(SEL.lobbyPage).isVisible().catch(() => false)
      await this.#fail(
        'join',
        stuckInLobby
          ? 'clicked Join but never reached the call — likely a waiting-room call ' +
            '(admit in the host UI, or use a call with entry mode Open) or a full 1:1'
          : 'call toolbar never appeared after Join',
      )
    }
  }

  // A signed-in user opening a guest invite link auto-joins as themselves (no
  // click) and is redirected to the normal member lobby, so this path only has
  // to survive the handoff and then finish the lobby like any other join.
  // Returns the {wsId, callId} learned from the redirected URL.
  async joinViaInvite(token) {
    this.state = 'joining'
    // storageState restores localStorage, and a persisted waiting record makes
    // the page skip its auto-join on a later run. Auth lives in cookies, so
    // clearing storage here is safe.
    await this.page
      .goto('/', { waitUntil: 'domcontentloaded' })
      .then(() => this.page.evaluate(() => localStorage.clear()))
      .catch(() => {})

    await this.page.goto(guestJoinPath(token), { waitUntil: 'domcontentloaded' })

    const pending = this.page.locator(SEL.guestAutoJoin)
    const lobby = this.page.locator(SEL.lobbyPage)
    const inCall = this.page.locator(SEL.leaveButton)
    const blocked = this.page.locator(SEL.guestBlocked)
    const password = this.page.locator(SEL.guestPassword)
    try {
      await pending
        .or(lobby)
        .or(inCall)
        .or(blocked)
        .or(password)
        .first()
        .waitFor({ state: 'visible', timeout: 30_000 })
    } catch {
      await this.#fail('invite', 'the invite link page never resolved')
    }

    if (await blocked.isVisible().catch(() => false)) {
      const text = ((await blocked.textContent().catch(() => '')) ?? '').trim().slice(0, 120)
      await this.#fail('invite-blocked', `invite link refused the join: ${text}`)
    }
    if (await password.isVisible().catch(() => false)) {
      await this.#fail(
        'invite-password',
        'this call is password-protected — paste the call link instead of the invite link',
      )
    }
    const waiting = await this.page
      .getByText(/Waiting for the host to let you in/iu)
      .isVisible()
      .catch(() => false)
    if (waiting) {
      await this.#fail(
        'invite-waiting',
        'the call needs host approval — admit the user, or use a call with entry mode Open',
      )
    }

    // the auto-join hands off to /w/<wsId>/call/<callId>?guest-link-user=…
    if (!(await inCall.isVisible().catch(() => false))) {
      await lobby
        .waitFor({ state: 'visible', timeout: JOIN_TIMEOUT })
        .catch(() => this.#fail('invite-lobby', 'auto-join never reached the call lobby'))
    }
    const target = this.#readCallFromUrl()
    await this.#completeLobbyJoin()

    this.wsId = target?.wsId ?? null
    this.callId = target?.callId ?? null
    this.state = 'in-call'
    this.log.info('in call (via invite link)')
    return target
  }

  #readCallFromUrl() {
    const match = this.page.url().match(/\/w\/([A-Za-z0-9_-]+)\/call\/([A-Za-z0-9_-]+)/u)
    return match ? { wsId: match[1], callId: match[2] } : null
  }

  // Creates an Open group call through the Calls Hub UI and returns its id.
  // The creator lands in-call directly (no lobby), so camera must be enabled
  // with the in-call toggle afterwards.
  async createCall(wsId) {
    await this.page.goto(callsHubPath(wsId), { waitUntil: 'domcontentloaded' })
    const headerBar = this.page.locator(SEL.callsHubHeaderBar)
    const legacyCard = this.page.locator(SEL.groupCallCard)
    await headerBar
      .or(legacyCard)
      .first()
      .waitFor({ state: 'visible', timeout: 30_000 })
      .catch(() => this.#fail('calls-hub', 'Calls hub did not render'))

    // "Start now" carries no testid; it is structurally the first button in
    // the header bar (locale-proof — visible text varies with account locale).
    // A fast page load can render the button before React attaches its click
    // handler, so click-and-check up to three times.
    const entryOpen = this.page.locator(SEL.startEntryOpen)
    let dialogOpen = false
    for (let attempt = 0; attempt < 3 && !dialogOpen; attempt += 1) {
      if (await headerBar.isVisible().catch(() => false)) {
        await headerBar.locator('button').first().click()
      } else {
        await legacyCard.click()
      }
      dialogOpen = await entryOpen
        .waitFor({ state: 'visible', timeout: 7000 })
        .then(() => true)
        .catch(() => false)
    }
    if (!dialogOpen) {
      await this.#fail('create-dialog', 'start-call dialog never opened after 3 clicks')
    }
    await entryOpen.click()

    const createResponse = this.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1/meeting',
      { timeout: 30_000 },
    )
    await this.page.locator(SEL.startSubmit).click()
    const response = await createResponse.catch(() =>
      this.#fail('create', 'POST /api/v1/meeting was never sent after Start'),
    )
    if (!response.ok()) {
      await this.#fail('create', `POST /api/v1/meeting returned ${response.status()}`)
    }
    const body = await response.json().catch(() => null)
    const callId = findStringField(body, 'id')
    if (!callId) await this.#fail('create', 'create response contained no meeting id')
    // CreateMeeting returns the guest invite link inline — capture it so guests
    // can join without touching the host's Add-to-call modal.
    this.guestToken = findStringField(body?.guest_link ?? body?.guestLink ?? null, 'token')

    await this.page.locator(SEL.leaveButton).waitFor({ state: 'visible', timeout: JOIN_TIMEOUT })
    this.callId = callId
    this.wsId = wsId
    this.state = 'in-call'
    this.log.info(`created call ${callId}`)

    if (!this.options.noVideo) await this.setCam(true)
    if (this.options.noAudio) await this.setMic(false)
    return callId
  }

  // --- in-call device state -------------------------------------------------
  // The PAIR wrapper carries the testid; its first button is the toggle and
  // aria-pressed="true" means the device is OFF. A host force-mute replaces
  // the toggle with a request button — detect, never blind-click.

  async #deviceState(pairSelector, requestSelector) {
    if (await this.page.locator(requestSelector).isVisible().catch(() => false)) {
      return 'request'
    }
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
    const wantPressed = on ? 'false' : 'true'
    try {
      await this.page.waitForFunction(
        ({ sel, value }) =>
          document.querySelector(`${sel} button`)?.getAttribute('aria-pressed') === value,
        { sel: pairSelector, value: wantPressed },
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

  // Screen share: the launch flag auto-selects the tab whose title matches
  // SIM-SHARE-<slug>; we lazily open that tab with visibly-live content.
  async setShare(onValue) {
    const on = onValue !== false
    if (on && !this.shareTab) {
      this.shareTab = await this.context.newPage()
      const title = shareTabTitle(this.user)
      await this.shareTab.setContent(
        `<title>${title}</title>
         <body style="margin:0;display:grid;place-items:center;height:100vh;background:#102030;color:#fff;font-family:sans-serif">
           <div style="text-align:center">
             <h1 style="font-size:64px;margin:0">${this.user.label} — SHARED</h1>
             <div id="clock" style="font-size:48px;margin-top:24px"></div>
           </div>
           <script>setInterval(() => { document.getElementById('clock').textContent = new Date().toISOString().slice(11, 21) }, 100)</script>
         </body>`,
      )
      await this.page.bringToFront().catch(() => {})
    }
    const button = this.page.locator(SEL.screenShare)
    if (!(await button.isVisible().catch(() => false))) {
      this.log.warn('screen-share control not visible (maybe "Request to share" mode)')
      return 'unavailable'
    }
    // grid layout switching to/from screen-share is the real proof, not the
    // button state
    const layout = this.page.locator(SEL.shareLayout)
    const sharingNow = await layout.first().isVisible().catch(() => false)
    if (sharingNow === on) {
      this.sharing = on
      return on ? 'sharing' : 'idle'
    }
    // record what the app actually asks getDisplayMedia for, and how it fails
    await this.page
      .evaluate(() => {
        if (window.__simShare) {
          window.__simShare = { calls: 0, ok: false, error: null, constraints: null }
          return
        }
        const original = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices)
        window.__simShare = { calls: 0, ok: false, error: null, constraints: null }
        navigator.mediaDevices.getDisplayMedia = async (constraints) => {
          window.__simShare.calls += 1
          window.__simShare.constraints = JSON.stringify(constraints ?? null)
          try {
            const stream = await original(constraints)
            window.__simShare.ok = true
            return stream
          } catch (error) {
            window.__simShare.error = `${error.name}: ${error.message}`
            throw error
          }
        }
      })
      .catch(() => {})
    await button.click()
    const confirmed = await layout
      .first()
      .waitFor({ state: on ? 'visible' : 'hidden', timeout: 8000 })
      .then(() => true)
      .catch(() => false)
    const nowSharing = await layout.first().isVisible().catch(() => false)
    this.sharing = on ? nowSharing : false
    if (!confirmed) {
      const diag = await this.page.evaluate(() => window.__simShare).catch(() => null)
      if (on && diag && diag.calls === 0) {
        // the app never called getDisplayMedia — the click sent a
        // permission request to the host instead (room restricts sharing)
        this.log.warn(
          'share needs host approval — approve it in the host UI, then run share again',
        )
        return 'requested'
      }
      const label = await button.getAttribute('aria-label').catch(() => null)
      this.log.warn(
        `share did not ${on ? 'start' : 'stop'} within 8s — button label "${label}", ` +
          `getDisplayMedia ${JSON.stringify(diag)}`,
      )
    }
    return nowSharing ? 'sharing' : 'idle'
  }

  // Grid truth for verification: which tiles exist and whether remote <video>
  // elements actually play (buttons are not proof).
  async verifyRemote() {
    return this.page.evaluate((sel) => {
      const tiles = [...document.querySelectorAll(sel.tile)]
      const summary = { local: 0, remote: 0, remotePlaying: 0, frozen: 0, names: [] }
      for (const tile of tiles) {
        const local = tile.getAttribute('data-local') === 'true'
        const name = tile
          .querySelector('[data-testid="participant-name"]')
          ?.textContent?.trim()
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

  async currentMeeting() {
    return meetingsCurrent(this.page).catch(() => null)
  }

  // Leave ladder: UI click → confirm dialog if present → API fallback.
  async leaveCall() {
    if (this.state !== 'in-call') return
    this.state = 'leaving'
    try {
      const leave = this.page.locator(SEL.leaveButton)
      await leave.click({ timeout: 5000 })
      const confirm = this.page.locator(SEL.leaveConfirm)
      const confirmAppeared = await confirm
        .waitFor({ state: 'visible', timeout: 2000 })
        .then(() => true)
        .catch(() => false)
      if (confirmAppeared) await confirm.click({ timeout: 3000 })
      await this.page
        .locator(SEL.callSurface)
        .waitFor({ state: 'hidden', timeout: 10_000 })
      this.state = 'ready'
      this.log.info('left call')
      return
    } catch {
      this.log.warn('UI leave failed; falling back to POST /meeting/leave')
    }
    if (this.callId) {
      const result = await leaveMeeting(this.page, this.callId).catch(() => null)
      this.log.info(`API leave status ${result?.status ?? 'n/a'}`)
    }
    this.state = 'ready'
  }

  // Used at quit for calls this tool created, so staging is left tidy.
  // API-first: POST /meeting/{id}/end from the page origin is deterministic;
  // the toolbar end-for-everyone menu is the flaky path and stays as fallback.
  async endCallForEveryone() {
    if (!this.callId) return
    const viaApi = await Promise.race([
      endMeeting(this.page, this.callId),
      sleep(8000).then(() => null),
    ]).catch(() => null)
    if (viaApi && viaApi.status < 300) {
      this.state = 'ready'
      this.log.info(`ended call for everyone (API status ${viaApi.status})`)
      return
    }
    this.log.warn(`API end gave ${viaApi?.status ?? 'no response'}; trying the UI`)
    try {
      const direct = this.page.locator(SEL.endForEveryone)
      if (!(await direct.isVisible().catch(() => false))) {
        // control may live behind the leave split-button
        await this.page.locator(SEL.leaveButton).click({ timeout: 4000 })
      }
      await direct.click({ timeout: 4000 })
      const confirm = this.page.locator(SEL.endConfirm)
      const confirmAppeared = await confirm
        .waitFor({ state: 'visible', timeout: 2000 })
        .then(() => true)
        .catch(() => false)
      if (confirmAppeared) await confirm.click({ timeout: 3000 })
      await this.page.locator(SEL.callSurface).waitFor({ state: 'hidden', timeout: 10_000 })
      this.log.info('ended call for everyone (UI)')
    } catch {
      this.log.warn('could not end the call — it will expire when participants drop')
    }
    this.state = 'ready'
  }

  async shot(name = 'manual') {
    return this.#shot(name)
  }

  async teardown({ endCall = false } = {}) {
    if (!this.browser) return
    try {
      if (this.state === 'in-call') {
        if (endCall) await this.endCallForEveryone()
        else await this.leaveCall()
      }
    } catch (error) {
      this.log.warn(`teardown leave failed: ${error.message}`)
    }
    try {
      await Promise.race([saveState(this.context, this.user.email), sleep(5000)])
    } catch {
      /* state save is best-effort */
    }
    // browser.close() can wedge even after the process exits (seen with
    // channel Chrome); never let it block the roster — the orchestrator sweeps
    // leftover processes by run marker afterwards.
    await Promise.race([this.browser.close().catch(() => {}), sleep(8000)])
    this.state = 'closed'
    this.log.info('closed')
  }
}
