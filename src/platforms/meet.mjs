// Google Meet — authenticated browser-profile join. Each bot owns one isolated
// Chrome profile that the user signed into manually through Call Bots.
//
// Meet has no test ids and re-renders constantly, so this adapter never walks a
// fixed script. It reads the page once per tick — one evaluate, one forced
// layout — decides which of a handful of known screens it is looking at, and
// acts on that. A screen nobody anticipated shows up as `loading` and simply
// times out with the text Meet put on it, rather than hanging on a selector.

// Reaching the pre-join screen: a link that resolves at all resolves fast.
const ENTRY_TIMEOUT = 60_000
// After clicking "Join now". Direct entry is near-instant, so a minute here
// means something is wrong — and reporting that in a minute matters, because
// the alternative is the ten-minute lobby budget below and a message about
// admission that never applied.
const JOIN_TIMEOUT = 60_000
// The lobby parks a bot until a host clicks Admit, which takes as long as it
// takes someone to notice. Same reasoning as Aloqa: a bot waiting to be let in
// is doing exactly the right thing, and it gets admitted later anyway.
const ADMISSION_TIMEOUT = 600_000
const TOGGLE_TIMEOUT = 8_000
// Opening the present menu and publishing takes longer than a mute toggle.
const SHARE_TIMEOUT = 15_000

// Two cadences, because the two waits are nothing alike: entry resolves in
// seconds and deserves a fast poll, while the lobby is a human-scale wait and
// polling it four times a minute is plenty. At 500ms a full lobby wait would
// cost 1200 page reads on the machine the rest of this app warns is overloaded.
const POLL_FAST = 500
const POLL_LOBBY = 2_000

// Measured against live Google Meet on 2 Sep 2026, not assumed:
//
// rtc — WORKS, and it is the one that matters. The stream monitor reads a real
//   connection (1 pc, ~230 kbps outbound video), which is what the camera
//   watchdog and the dark-camera heal ladder run on. It only works because the
//   codec shim publishes its connection registry: Meet keeps its peer
//   connections in module closures where the monitor's own scan cannot reach
//   them, and without that bridge it reports "no connection" on a live call.
//
// screen — DOES NOT WORK. getDisplayMedia hands Meet a live 1920x1080 track and
//   Meet's own bundle then throws DisconnectedError and never starts
//   presenting. Reproduced on two separate meetings, and identically with the
//   codec shim disabled, so this is Meet refusing rather than anything of ours.
//   screenState/setScreen below are correct against the DOM and stay tested
//   against the mock pages; flipping this one boolean re-enables them if Meet
//   ever accepts the share.
//
// codecs — DOES NOT WORK. Meet negotiates its own list and then picks AV1 from
//   it whatever the preference says: a runtime switch to vp9 and a launch-time
//   h264 both left AV1 on the wire. Both are reported honestly rather than
//   silently ignored, but a control that can never land is not a control.
//   (If this is ever turned on, note that Guest's last resort for a codec that
//   will not settle is a rejoin — and a Meet rejoin puts the bot back in the
//   waiting room, so it would need a way to opt out of that.)
export const capabilities = Object.freeze({
  mic: true,
  camera: true,
  screen: false,
  rtc: true,
  codecs: false,
})

export const SEL = {
  // A signed-in profile is never asked for a name, so this field appearing IS
  // the signed-out signal — it is never filled.
  anonymousName: 'input[aria-label*="your name" i], input[placeholder*="your name" i]',
  leaveButton: '[aria-label*="Leave call" i], [aria-label*="Leave the call" i]',
  // data-is-muted is the reliable seam and is preferred when present; the
  // aria-label fallbacks cover surfaces Meet renders without it.
  mic: '[data-is-muted][aria-label*="microphone" i], button[aria-label*="microphone" i], [role="button"][aria-label*="microphone" i]',
  cam: '[data-is-muted][aria-label*="camera" i], button[aria-label*="camera" i], [role="button"][aria-label*="camera" i]',
  present: '[aria-label*="Present now" i], [aria-label*="Share screen" i]',
  stopPresent: '[aria-label*="Stop presenting" i], [aria-label*="Stop sharing" i]',
  tile: '[data-participant-id]',
}

// Accessible-name patterns. Playwright's getByRole resolves both a text label
// and an aria-label, which is what makes these work across Meet's mix of real
// buttons and role="button" divs.
// Unanchored on purpose: Meet appends a keyboard hint to the accessible name
// of the join button, so anything anchored to the end of it misses.
const JOIN_NAME = /join now|ask to join|switch here|join anyway/iu
const ASK_NAME = /ask to join/iu
// These two stay anchored. An unanchored "close" or "reject" would match half
// the controls in the call and start clicking things nobody asked for.
const DISMISS_NAME = /^\s*(?:got it|dismiss|no thanks|not now)\s*$/iu
const CONSENT_NAME = /^\s*(?:reject all|reject|decline all)\s*$/iu
// Accepting this joins the call publishing nothing at all, which is precisely
// the failure this app exists to make visible. Never click it — recognising it
// is how a device fault gets reported as a device fault.
const NO_DEVICES_NAME = /continue without (?:microphone|mic|camera)/iu

const REFUSALS = [
  /You can'?t join this (?:video )?call/iu,
  /denied your request/iu,
  /No one responded to your request/iu,
  /Check your meeting code/iu,
  /Your?'?ve been removed/iu,
  /You'?ve been removed/iu,
  /removed from the (?:meeting|call)/iu,
  /not allowed to join/iu,
  /meeting is full/iu,
  /call is full/iu,
  /Your browser (?:is ?n'?t|is not) supported/iu,
  /This meeting (?:has ended|is over)/iu,
  /Return to home screen/iu,
]

const SIGNED_OUT = /Sign in to (?:join|continue)|Choose an account to continue|Use your Google Account/iu
const LOBBY = /Asking to be let in|Waiting for (?:the host|someone)|You'?ll join(?: the call)? when someone lets you in|let you in/iu
const DEVICE_TROUBLE = /(?:camera|microphone) is (?:in use|blocked|not available)|no camera found|can'?t (?:find|use) your (?:camera|microphone)/iu

const CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/u
const ALIAS_RE = /^(?:lookup|_meet)\/([A-Za-z0-9._~%-]{1,120})$/u

// meet.google.com is ours whatever the path, so a wrong shape throws with an
// example rather than falling through to Aloqa's catch-all matcher.
const parse = (url) => {
  if (url.hostname !== 'meet.google.com') return null
  // Meet prefixes account-scoped URLs with /u/<n>; the profile holds exactly
  // one account, so the prefix carries no information for us.
  const path = url.pathname.replace(/^\/u\/\d+/u, '').replace(/^\/+|\/+$/gu, '')
  const code = path.toLowerCase()
  const alias = path.match(ALIAS_RE)
  const slug = CODE_RE.test(code) ? code : alias ? `${alias[0]}` : null
  if (!slug) {
    throw new Error(
      `expected a Meet link like meet.google.com/abc-defg-hij, got ${url.pathname || '/'}`,
    )
  }
  // hl pins the URL language and authuser pins the account: a profile has one
  // signed-in account, so a link copied from someone else's second account must
  // not send this bot looking for an account it does not have.
  return {
    origin: url.origin,
    url: `${url.origin}/${slug}?hl=en&authuser=0`,
    callId: CODE_RE.test(code) ? code : (alias?.[1] ?? slug),
  }
}

// ---------------------------------------------------------------------------
// One read per tick.

// Everything the join loop needs, in a single evaluate. Splitting this back
// into separate isVisible() calls is what made the old version cost four page
// round-trips and two whole-document innerText scrapes every 500ms.
const readPage = (page, { withText = false } = {}) =>
  page.evaluate(
    ({ sel, text, withText }) => {
      const rx = (source) => new RegExp(source, 'iu')
      const vis = (el) =>
        Boolean(el) && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
      const label = (el) =>
        ((el && (el.getAttribute('aria-label') || el.textContent)) || '')
          .replace(/\s+/gu, ' ')
          .trim()

      const allVisible = (selector) => [...document.querySelectorAll(selector)].filter(vis)

      // Prefer the control that carries data-is-muted: on a screen showing both
      // the toolbar button and a settings menu entry, only one of them is the
      // toggle, and it is always that one.
      const device = (selector) => {
        const found = allVisible(selector)
        const el = found.find((node) => node.hasAttribute('data-is-muted')) ?? found[0]
        if (!el) return 'unknown'
        if (el.getAttribute('aria-disabled') === 'true' || el.disabled === true) return 'request'
        const muted = el.getAttribute('data-is-muted')
        if (muted === 'true') return 'off'
        if (muted === 'false') return 'on'
        const name = label(el).toLowerCase()
        if (/turn on/u.test(name)) return 'off'
        if (/turn off/u.test(name)) return 'on'
        return 'unknown'
      }

      const buttons = []
      for (const el of document.querySelectorAll('button, [role="button"]')) {
        if (buttons.length >= 60) break
        if (!vis(el)) continue
        const name = label(el).slice(0, 80)
        if (name) buttons.push(name)
      }
      const has = (source) => {
        const pattern = rx(source)
        return buttons.some((name) => pattern.test(name))
      }

      const leave = allVisible(sel.leaveButton).length > 0
      const mic = device(sel.mic)
      const cam = device(sel.cam)

      // The expensive read, and the only one that needs the whole page. Once
      // the leave control exists the bot is in and nothing here is consulted,
      // so the cost falls away exactly when the long wait begins.
      const headline =
        leave || !withText
          ? ''
          : (document.body ? document.body.innerText : '')
              .replace(/\n{2,}/gu, '\n')
              .slice(0, 1500)

      return {
        // Meet's own offline page, and it renders in whatever language Chrome
        // feels like — this browser knows the answer without reading any of it.
        offline: navigator.onLine === false,
        leave,
        mic,
        cam,
        nameField: allVisible(sel.anonymousName).length > 0,
        joinButton: has(text.join),
        askToJoin: has(text.ask),
        dismissible: has(text.dismiss),
        consent: has(text.consent),
        noDevices: has(text.noDevices),
        presenting: allVisible(sel.stopPresent).length > 0,
        canPresent: allVisible(sel.present).length > 0,
        headline,
      }
    },
    {
      sel: SEL,
      withText,
      text: {
        join: JOIN_NAME.source,
        ask: ASK_NAME.source,
        dismiss: DISMISS_NAME.source,
        consent: CONSENT_NAME.source,
        noDevices: NO_DEVICES_NAME.source,
      },
    },
  )

// Smart quotes normalised so the patterns above can spell it "can't".
const plain = (value) => String(value ?? '').replace(/[‘’ʼ]/gu, "'")

const refusalIn = (headline) => {
  const text = plain(headline)
  for (const pattern of REFUSALS) {
    if (!pattern.test(text)) continue
    return (text.split('\n').find((line) => pattern.test(line)) ?? text).trim().slice(0, 180)
  }
  return null
}

// A signed-in Meet page renders in the ACCOUNT's language, which overrides the
// hl in the link. Structural signals still work there, so a page that clearly
// has Meet's device toggles but matches none of the English controls is a
// language problem, not a broken selector — and saying so beats timing out.
const looksNonEnglish = (read) =>
  !read.leave &&
  !read.joinButton &&
  !read.nameField &&
  (read.mic !== 'unknown' || read.cam !== 'unknown')

// Meet answers a code it will not open by quietly landing the account on its
// own home screen instead of saying anything. Left unrecognised that is a
// sixty-second wait ending in "the preview never appeared", which sends the
// user looking at the adapter instead of at their meeting code.
const HOME_PATH = /^\/(?:u\/\d+\/)?(?:home)?$/u

const classify = (read, url) => {
  if (read.leave) return { stage: 'in-call' }

  let host = ''
  let path = ''
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    path = parsed.pathname
  } catch {}
  if (host === 'accounts.google.com') return { stage: 'signin' }
  if (host === 'meet.google.com' && HOME_PATH.test(path)) {
    return {
      stage: 'refused',
      detail: 'Meet sent this account to its home screen — check the meeting code, ' +
        'or invite this account to the meeting',
    }
  }
  if (read.nameField || SIGNED_OUT.test(plain(read.headline))) return { stage: 'signin' }

  const refusal = refusalIn(read.headline)
  if (refusal) return { stage: 'refused', detail: refusal }
  if (read.offline) return { stage: 'offline' }

  // Recognised before the join button, because Meet renders this dialog OVER
  // the pre-join screen and the join button underneath it stays visible.
  if (read.noDevices || DEVICE_TROUBLE.test(plain(read.headline))) {
    return { stage: 'no-devices' }
  }
  if (read.consent) return { stage: 'consent' }
  if (LOBBY.test(plain(read.headline))) return { stage: 'lobby' }
  if (read.joinButton) return { stage: 'prejoin' }
  return { stage: 'loading' }
}

// ---------------------------------------------------------------------------
// Clicking.

const byName = (page, name) =>
  page.getByRole('button', { name }).filter({ visible: true }).first()

// Meet keeps the pre-join controls in the document after entry, just hidden, so
// a plain .first() resolves the wrong copy and then waits out its whole timeout
// on an element that will never be clickable. The page-side reader already
// picks the visible one; this is how the clicking side agrees with it.
const onScreen = (page, selector) => page.locator(selector).filter({ visible: true }).first()

// Meet's DOM re-renders under every click, so a control resolved a moment ago
// can be detached by the time it is clicked. Playwright retries within the
// timeout; what matters here is that a failure comes back as false instead of
// escaping as a raw Playwright error — an unhandled throw out of join() leaves
// the Guest stuck in 'joining' forever, where recoverIfAdmitted cannot reach it.
const tryClick = async (locator, timeout = 5_000) =>
  locator
    .click({ timeout })
    .then(() => true)
    .catch(() => false)

const declineConsent = async (page) => {
  await tryClick(byName(page, CONSENT_NAME), 3_000)
  await page.waitForLoadState('domcontentloaded').catch(() => {})
}

// ---------------------------------------------------------------------------
// Devices.

const deviceState = async (page, which) => {
  const read = await readPage(page).catch(() => null)
  if (!read) return 'unknown'
  return which === 'mic' ? read.mic : read.cam
}

const setDevice = async ({ page, log }, kind, which, on) => {
  const selector = which === 'mic' ? SEL.mic : SEL.cam
  const current = await deviceState(page, which)
  if (current === 'request') {
    log.warn(`${kind} is host-restricted — cannot toggle`)
    return 'request'
  }
  if (current === 'unknown') {
    log.warn(`${kind} button not found — not in the Meet call?`)
    return 'unknown'
  }
  const want = on ? 'on' : 'off'
  if (current === want) return want

  // Resolve and click in one step. Reading the state and then re-resolving the
  // button separately is a null dereference waiting to happen on a DOM that
  // re-renders as often as this one.
  const clicked = await tryClick(onScreen(page, selector), TOGGLE_TIMEOUT)
  if (!clicked) {
    log.warn(`${kind} button did not accept a click`)
    return deviceState(page, which)
  }

  const deadline = Date.now() + TOGGLE_TIMEOUT
  while (Date.now() < deadline) {
    const state = await deviceState(page, which)
    if (state === want) return want
    if (state === 'request') {
      log.warn(`${kind} was taken over by the host mid-toggle`)
      return 'request'
    }
    await page.waitForTimeout(150)
  }
  log.warn(`${kind} did not reach "${want}" within ${TOGGLE_TIMEOUT}ms`)
  return deviceState(page, which)
}

// ---------------------------------------------------------------------------
// Screen share.
//
// The capture shim replaces getDisplayMedia with a canvas captureStream before
// Meet's bundle loads, so Meet never reaches Chrome's source picker: whichever
// entry of its present menu gets clicked, the same synthetic screen comes back.

const screenState = async (page) => {
  const read = await readPage(page).catch(() => null)
  if (!read) return 'unknown'
  if (read.presenting) return 'on'
  if (read.canPresent) return 'off'
  // In the call with no present control at all is Meet's way of saying the host
  // turned presenting off for everyone.
  return read.leave ? 'blocked' : 'unknown'
}

const setScreen = async (ctx, on) => {
  const { page, log } = ctx
  const current = await screenState(page)
  if (current === 'blocked') {
    log.warn('this call does not allow presenting — the host restricted it')
    return 'blocked'
  }
  if (current === 'unknown') {
    log.warn('present control not found — not in the Meet call?')
    return 'unknown'
  }
  const want = on ? 'on' : 'off'
  if (current === want) return want

  if (!on) {
    await tryClick(onScreen(page, SEL.stopPresent), SHARE_TIMEOUT)
  } else {
    await ctx.prepareScreen()
    if (!(await tryClick(onScreen(page, SEL.present), SHARE_TIMEOUT))) {
      log.warn('the present control did not accept a click')
      return screenState(page)
    }
    // The menu entry only decides what Meet ASKS for; the shim decides what it
    // gets. A tab is asked for because it is the cheapest thing to grant.
    await tryClick(byName(page, /a tab|chrome tab|entire screen|a window/iu), 4_000)
  }

  const deadline = Date.now() + SHARE_TIMEOUT
  while (Date.now() < deadline) {
    if ((await screenState(page)) === want) return want
    await page.waitForTimeout(300)
  }
  log.warn(`screen share did not reach "${want}" in time`)
  return screenState(page)
}

// ---------------------------------------------------------------------------
// Join.

const failSignedOut = async ({ meetProfile, fail }) => {
  meetProfile?.markNeedsSignIn?.()
  const name = meetProfile?.displayName ?? 'This Google account'
  await fail(
    'account',
    `${name} is signed out — reconnect it in Call Bots → Google accounts`,
    { screenshot: false },
  )
}

const join = async (ctx) => {
  const { page, target, log, fail, options, setWaitingAdmission } = ctx
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded' })
  } catch (error) {
    await fail(
      'entry',
      /timeout/iu.test(error.message)
        ? 'the Meet page did not load in time — this machine may be overloaded'
        : error.message,
    )
  }

  let phase = 'entry' // entry -> joining -> lobby
  let deadline = Date.now() + ENTRY_TIMEOUT
  let armed = false
  let dismissals = 0
  let nonEnglishSince = null
  let clickedAt = 0

  for (;;) {
    const read = await readPage(page, { withText: true }).catch(() => null)
    if (!read) {
      // The page went away under us mid-read; the next tick either finds it
      // again or runs out the clock with a real message.
      await page.waitForTimeout(POLL_FAST)
      continue
    }
    const { stage, detail } = classify(read, page.url())

    if (stage === 'in-call') {
      setWaitingAdmission?.(false)
      // Meet greets a fresh profile with onboarding cards that sit over the
      // controls the rest of this adapter needs to click.
      if (read.dismissible && dismissals < 4) {
        dismissals += 1
        await tryClick(byName(page, DISMISS_NAME), 2_000)
      }
      return { callId: target.callId }
    }

    if (stage === 'signin') await failSignedOut(ctx)

    if (stage === 'refused') {
      setWaitingAdmission?.(false)
      await fail(phase === 'entry' ? 'entry' : 'join', `Google Meet refused this account: ${detail}`)
    }

    if (stage === 'offline') {
      // Worth its own message: "the preview never appeared" sends someone
      // hunting through Meet for a fault that is on this machine.
      await fail('entry', 'this machine lost its network connection — Meet cannot load')
    }

    if (stage === 'no-devices') {
      await fail(
        'entry',
        'Chrome gave this bot no camera or microphone — Meet offered to join without them, ' +
          'which would put a silent invisible bot in the call',
      )
    }

    if (stage === 'consent') {
      await declineConsent(page)
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'prejoin') {
      if (read.dismissible && dismissals < 4) {
        dismissals += 1
        await tryClick(byName(page, DISMISS_NAME), 2_000)
        continue
      }
      // Meet remembers the last device state per profile, so set what was asked
      // for BEFORE entry — otherwise admission briefly publishes the wrong one.
      // Guest re-asserts both once the in-call controls exist.
      if (!armed) {
        armed = true
        if (!options.noVideo) await setDevice(ctx, 'camera', 'cam', options.startCam !== false)
        if (!options.noAudio) await setDevice(ctx, 'mic', 'mic', options.startMic !== false)
      }
      // Read the label from THIS tick, not from before the click: Meet swaps
      // "Join now" for "Ask to join" while it is still resolving membership,
      // and a stale read leaves a bot sitting in a lobby nobody is told about.
      const asking = read.askToJoin
      // One click, then let Meet work. Still sitting on the pre-join screen
      // eight seconds later means the click did not take, and re-clicking is
      // the recovery — but firing it every tick is not.
      if (Date.now() - clickedAt > 8_000 && (await tryClick(byName(page, JOIN_NAME), 10_000))) {
        clickedAt = Date.now()
        if (phase === 'entry') {
          phase = asking ? 'lobby' : 'joining'
          deadline = Date.now() + (asking ? ADMISSION_TIMEOUT : JOIN_TIMEOUT)
          if (asking) {
            setWaitingAdmission?.(true)
            log.info('waiting in the Google Meet lobby — admit this account')
          } else {
            log.info('joining Google Meet')
          }
        }
      }
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'lobby' && phase !== 'lobby') {
      // Direct entry that turned into a wait after the fact: Meet decided this
      // account needs admitting only once it had the click.
      phase = 'lobby'
      deadline = Date.now() + ADMISSION_TIMEOUT
      setWaitingAdmission?.(true)
      log.info('waiting in the Google Meet lobby — admit this account')
    }

    if (looksNonEnglish(read)) {
      nonEnglishSince ??= Date.now()
      if (Date.now() - nonEnglishSince > 15_000) {
        await fail(
          'entry',
          'this Google account\'s Meet is not in English — set the account language to English, ' +
            'or use an account that is (Call Bots reads Meet\'s English controls)',
        )
      }
    } else {
      nonEnglishSince = null
    }

    if (Date.now() > deadline) {
      setWaitingAdmission?.(false)
      const message =
        phase === 'lobby'
          ? 'nobody admitted this Google account — admit it in Meet, or invite it to the meeting'
          : phase === 'joining'
            ? 'Meet accepted the click but the call never opened'
            : 'the Google Meet preview never appeared (wrong link, blocked account, or changed UI)'
      await fail(phase === 'entry' ? 'entry' : 'join', message)
    }

    await page.waitForTimeout(phase === 'lobby' ? POLL_LOBBY : POLL_FAST)
  }
}

// ---------------------------------------------------------------------------
// Participants.

const remote = (page) =>
  page.evaluate((sel) => {
    const vis = (el) =>
      Boolean(el) && Boolean(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
    // Visible tiles only. Meet virtualises the grid and keeps the post-call
    // screen's leftovers in the document, and counting either of those reports
    // participants nobody can see — the opposite of what this check is for.
    const tiles = [...document.querySelectorAll(sel.tile)].filter(
      (tile) => vis(tile) && !tile.parentElement?.closest(sel.tile),
    )
    const summary = { local: 0, remote: 0, remotePlaying: 0, frozen: 0, names: [] }

    // Meet exposes no frozen flag of its own, so freshness is measured here:
    // a playing video whose currentTime has not moved since the last check is
    // frozen, however healthy its readyState looks.
    const now = Date.now()
    const seen = (window.__botMeetFrames__ ??= new Map())

    // Which tiles belong to somebody else? Meet marks its own tile with
    // nothing — today's self view carries no data-self-name, no aria-label and
    // no "you" anywhere, only the Reframe and Backgrounds controls. Matching
    // the SENT tracks does not work either: Meet's effects pipeline publishes a
    // processed track while the self view renders the raw one.
    //
    // What is never ambiguous is the receiving side. A track this browser is
    // RECEIVING came from another participant by definition, so the tile
    // playing one is theirs and every other tile is this bot's own. No
    // attribute, no English, nothing for a Meet redesign to take away.
    const connections = window.__botPeerConnections__
    const receiving = new Set()
    try {
      for (const pc of connections ?? []) {
        for (const receiver of pc.getReceivers?.() ?? []) {
          if (receiver.track?.id) receiving.add(receiver.track.id)
        }
      }
    } catch {
      // Fall through to the attribute checks below.
    }
    const playsRemoteTrack = (video) => {
      try {
        return (video?.srcObject?.getTracks?.() ?? []).some((track) => receiving.has(track.id))
      } catch {
        return false
      }
    }

    for (const tile of tiles) {
      const aria = tile.getAttribute('aria-label') ?? ''
      const video = tile.querySelector('video')
      // With the shim present the receivers decide and nothing else gets a
      // vote. Without it — a page the shim never reached, or the mock pages the
      // adapter tests drive — fall back to whatever the markup says.
      const local = connections
        ? !playsRemoteTrack(video)
        : tile.hasAttribute('data-self-name') || /\b(?:you|your)\b/iu.test(aria)
      // Only real name attributes. Reaching into the tile for any nested
      // aria-label picks up Meet's own hover controls and reports a
      // participant called "Reframe".
      const rawName =
        tile.getAttribute('data-self-name') ??
        tile.getAttribute('data-sort-key') ??
        tile.querySelector('[data-self-name]')?.getAttribute('data-self-name') ??
        (aria || null)
      const name = rawName?.split('_')[0]?.trim()
      if (name) summary.names.push(`${local ? '*' : ''}${name}`)
      if (local) {
        summary.local += 1
        continue
      }
      summary.remote += 1
      if (video && video.readyState >= 2 && video.videoWidth > 0 && !video.paused) {
        summary.remotePlaying += 1
        const id = tile.getAttribute('data-participant-id') ?? name ?? String(summary.remote)
        const last = seen.get(id)
        if (last && now - last.at > 1000) {
          if (last.time === video.currentTime) summary.frozen += 1
          seen.set(id, { time: video.currentTime, at: now })
        } else if (!last) {
          seen.set(id, { time: video.currentTime, at: now })
        }
      }
    }

    // Meet can virtualise the self-view out of the grid. Its leave control is
    // still authoritative evidence that this browser is in the call — but only
    // while it is actually on screen: the post-call "you left" page keeps a
    // hidden one around, and trusting that resurrects a bot that is not in.
    if (summary.local === 0) {
      const leave = [...document.querySelectorAll(sel.leaveButton)].some(vis)
      if (leave) summary.local = 1
    }
    return summary
  }, SEL)

export default {
  id: 'meet',
  label: 'Google Meet',
  capabilities,
  armAfterJoin: true,
  parse,
  join,
  micState: (page) => deviceState(page, 'mic'),
  camState: (page) => deviceState(page, 'cam'),
  setMic: (ctx, on) => setDevice(ctx, 'mic', 'mic', on),
  setCam: (ctx, on) => setDevice(ctx, 'camera', 'cam', on),
  screenState,
  setScreen,
  remote,
  leave: async ({ page, log }) => {
    // Called for every bot on teardown, including ones that never got in.
    const button = onScreen(page, SEL.leaveButton)
    if ((await button.count().catch(() => 0)) === 0) return
    if (await tryClick(button, 5_000)) log.info('left Google Meet')
  },
}
