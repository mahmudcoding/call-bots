// Google Meet — two ways in.
//
// A bot with a saved Chrome profile joins as that Google account. A bot without
// one joins as an anonymous guest: it types a name and asks to be let in, the
// way Aloqa guests do, and needs no account at all.
//
// Guests are not always allowed. Meet refuses anonymous visitors outright for
// any meeting created by a PERSONAL Google account — no name field, just "You
// can't join this video call", and that holds even while the host is sitting in
// the call. Workspace meetings can permit them if the admin has. The adapter
// says which of those happened rather than leaving a bot to time out.
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
  // A guest types a name here; a signed-in profile is never asked for one, so
  // for an account bot this field appearing IS the signed-out signal. The bare
  // text input is a last resort — Meet's pre-join screen has no other one.
  anonymousName:
    'input[aria-label*="your name" i], input[placeholder*="your name" i], input[type="text"]',
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
// Its opposite, and the one to click. A guest window gets asked this outright
// rather than inheriting a granted permission, and a bot that never answers is
// left looking at the refusal the dialog is sitting on top of.
const USE_DEVICES_NAME = /\buse\b[^.]{0,20}\b(?:microphone|camera)\b/iu

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
  // hl pins the URL language. No authuser: a guest has no account for it to
  // select, and a profile has exactly one, so it can only ever be wrong.
  return {
    origin: url.origin,
    url: `${url.origin}/${slug}?hl=en`,
    callId: CODE_RE.test(code) ? code : (alias?.[1] ?? slug),
  }
}

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

const classify = (read, url, guest) => {
  if (read.leave) return { stage: 'in-call' }

  let host = ''
  let path = ''
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    path = parsed.pathname
  } catch {}
  if (host === 'accounts.google.com') return { stage: 'signin' }
  // The same field means opposite things to the two kinds of bot: a guest is
  // being asked to introduce itself, an account bot has lost its session. Meet
  // leaves the field on screen after it is filled, so only an EMPTY one is
  // still asking — otherwise a guest retypes its name forever.
  if (read.nameField && !read.named) return { stage: guest ? 'name-entry' : 'signin' }
  if (read.nameField && !guest) return { stage: 'signin' }
  if (host === 'meet.google.com' && HOME_PATH.test(path)) {
    return {
      stage: 'refused',
      detail: 'Meet sent this account to its home screen — check the meeting code, ' +
        'or invite this account to the meeting',
    }
  }
  if (SIGNED_OUT.test(plain(read.headline))) return { stage: 'signin' }

  // Before the refusal check: Meet draws this dialog OVER whatever is
  // underneath, so the page can read as refused while the only thing actually
  // wrong is that nobody answered the question.
  if (read.useDevices) return { stage: 'devices-ask' }

  const refusal = refusalIn(read.headline)
  if (refusal) return { stage: 'refused', detail: refusal }
  if (read.offline) return { stage: 'offline' }

  // Recognised before the join button, because Meet renders this dialog OVER
  // the pre-join screen and the join button underneath it stays visible.
  // Meet offers this on the ordinary pre-join screen, beside working device
  // toggles, and offers it during the load before those toggles exist. It is a
  // fault only when nothing else is on offer and no device ever appears — which
  // the join loop decides by waiting, not by one reading.
  if (read.noDevices && !read.useDevices && read.mic === 'unknown' && read.cam === 'unknown') {
    return { stage: 'maybe-no-devices' }
  }
  if (DEVICE_TROUBLE.test(plain(read.headline))) return { stage: 'no-devices' }
  if (read.consent) return { stage: 'consent' }
  if (LOBBY.test(plain(read.headline))) return { stage: 'lobby' }
  if (read.joinButton) return { stage: 'prejoin' }
  return { stage: 'loading' }
}

// ---------------------------------------------------------------------------
// Talking to the page.
//
// Everything below goes through one primitive: evaluate a single-line
// JavaScript expression that returns a JSON string. That is the only thing a
// guest window can do — it is driven through Chrome's AppleScript interface,
// which takes a string and nothing else — and a Playwright page does it too, so
// one adapter drives both kinds of bot.
//
// Single line is not a style choice. AppleScript string literals cannot span
// lines, and a multi-line script comes back as `missing value` rather than an
// error.

const oneLine = (source) => source.replace(/\s*\n\s*/gu, ' ').trim()

// Inlined into every source below. No `//` comments in here, and no literal
// newlines — write `[\r\n]` in a character class instead.
const HELPERS = `
var __vis = function (e) {
  return !!(e && (e.offsetWidth || e.offsetHeight || (e.getClientRects && e.getClientRects().length)))
};
var __all = function (s) { return [].slice.call(document.querySelectorAll(s)).filter(__vis) };
var __label = function (e) {
  return ((e && (e.getAttribute('aria-label') || e.textContent)) || '').replace(/\\s+/g, ' ').trim()
};
var __find = function (rx) {
  var r = new RegExp(rx, 'i'), i;
  var n = __all('button,[role=button],[role=menuitem]');
  for (i = 0; i < n.length; i += 1) { if (r.test(__label(n[i]))) return n[i] }
  var best = null, all = document.querySelectorAll('*');
  for (i = 0; i < all.length; i += 1) {
    var e = all[i];
    if (!__vis(e)) continue;
    if (!r.test(__label(e))) continue;
    if (!best || e.compareDocumentPosition(best) & Node.DOCUMENT_POSITION_CONTAINS) best = e;
    else if (best.contains(e)) best = e;
  }
  return best
};
var __device = function (sel) {
  var f = __all(sel), el = null, i;
  for (i = 0; i < f.length; i += 1) { if (f[i].hasAttribute('data-is-muted')) { el = f[i]; break } }
  if (!el) el = f[0];
  if (!el) return 'unknown';
  if (el.getAttribute('aria-disabled') === 'true' || el.disabled === true) return 'request';
  var m = el.getAttribute('data-is-muted');
  if (m === 'true') return 'off';
  if (m === 'false') return 'on';
  var n = __label(el).toLowerCase();
  if (/turn on/.test(n)) return 'off';
  if (/turn off/.test(n)) return 'on';
  return 'unknown'
};
`

const js = (value) => JSON.stringify(value)

// Whatever comes back, hand the caller a value. A Playwright page returns the
// string the expression produced; a guest window has already tried to parse it.
const evaluate = async (page, source) => {
  const raw = await page.evaluate(source)
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const readSource = (withText) =>
  oneLine(`(function(){${HELPERS}
    var leave = __all(${js(SEL.leaveButton)}).length > 0;
    var headline = (leave || !${withText ? 'true' : 'false'})
      ? ''
      : ((document.body ? document.body.innerText : '') || '')
          .replace(/[\\r\\n]{2,}/g, '\\n').slice(0, 1500);
    return JSON.stringify({
      offline: navigator.onLine === false,
      leave: leave,
      mic: __device(${js(SEL.mic)}),
      cam: __device(${js(SEL.cam)}),
      nameField: __all(${js(SEL.anonymousName)}).length > 0,
      named: !!(__all(${js(SEL.anonymousName)})[0] || {}).value,
      joinButton: !!__find(${js(JOIN_NAME.source)}),
      askToJoin: !!__find(${js(ASK_NAME.source)}),
      dismissible: !!__find(${js(DISMISS_NAME.source)}),
      useDevices: !!__find(${js(USE_DEVICES_NAME.source)}),
      consent: !!__find(${js(CONSENT_NAME.source)}),
      noDevices: !!__find(${js(NO_DEVICES_NAME.source)}),
      presenting: __all(${js(SEL.stopPresent)}).length > 0,
      canPresent: __all(${js(SEL.present)}).length > 0,
      headline: headline
    })
  })()`)

const readPage = (page, { withText = false } = {}) => evaluate(page, readSource(withText))

// A guest is driven through AppleScript, so nothing hooks the page at
// document-start the way addInitScript does for every other bot — and without a
// hook there is no seeing Meet's peer connections at all: it keeps them in
// module closures, out of reach of any scan from `window`. This goes in as soon
// as the document exists, which beats Meet's bundle to its first connection,
// and keeps its own rolling snapshot because AppleScript can hand back a value
// but can never wait on a promise.
const STATS_SOURCE = oneLine(`(function(){
  if (window.__botGuestStats__) return '"already"';
  var Native = window.RTCPeerConnection;
  if (!Native) return '"no-rtc"';
  var live = new Set();
  var Wrapped = function RTCPeerConnection() {
    var pc = new (Function.prototype.bind.apply(Native, [null].concat([].slice.call(arguments))))();
    live.add(pc);
    return pc
  };
  Wrapped.prototype = Native.prototype;
  try { Object.setPrototypeOf(Wrapped, Native) } catch (e) {}
  window.RTCPeerConnection = Wrapped;
  if ('webkitRTCPeerConnection' in window) window.webkitRTCPeerConnection = Wrapped;
  window.__botPeerConnections__ = live;
  var empty = function () { return { pcs: 0, up: 0, upV: 0, down: 0, rtt: null, out: { a: 0, v: 0 }, in: { a: 0, v: 0 } } };
  var snap = empty();
  var prev = new Map();
  var r1 = function (v) { return (typeof v === 'number' && isFinite(v)) ? Math.round(v * 10) / 10 : null };
  var tick = function () {
    var pcs = [];
    live.forEach(function (pc) {
      try {
        if (pc.connectionState === 'closed' || pc.signalingState === 'closed') live.delete(pc);
        else pcs.push(pc)
      } catch (e) { live.delete(pc) }
    });
    if (!pcs.length) { snap = empty(); return }
    var now = Date.now(), seen = new Map(), up = 0, upV = 0, down = 0, rtt = null;
    var oa = new Set(), ov = new Set(), ia = new Set(), iv = new Set(), pending = pcs.length;
    pcs.forEach(function (pc) {
      pc.getStats().then(function (rep) {
        rep.forEach(function (st) {
          if (st.type === 'candidate-pair' && st.state === 'succeeded' && st.currentRoundTripTime != null) {
            rtt = st.currentRoundTripTime * 1000
          }
          if (st.type !== 'outbound-rtp' && st.type !== 'inbound-rtp') return;
          var key = st.type + ':' + st.id;
          var bytes = (st.bytesSent != null ? st.bytesSent : st.bytesReceived) || 0;
          seen.set(key, { bytes: bytes, at: now });
          var was = prev.get(key);
          var kbps = (was && now > was.at) ? ((bytes - was.bytes) * 8) / (now - was.at) : 0;
          var track = st.trackIdentifier || st.id;
          if (st.type === 'outbound-rtp') {
            up += kbps;
            if (st.kind === 'video') { upV += kbps; ov.add(track) } else oa.add(track)
          } else {
            down += kbps;
            if (st.kind === 'video') iv.add(track); else ia.add(track)
          }
        })
      }).catch(function () {}).then(function () {
        pending -= 1;
        if (pending > 0) return;
        prev = seen;
        snap = { pcs: pcs.length, up: r1(up), upV: r1(upV), down: r1(down), rtt: r1(rtt),
          out: { a: oa.size, v: ov.size }, in: { a: ia.size, v: iv.size } }
      })
    })
  };
  setInterval(tick, 1000);
  window.__botGuestStats__ = function () { return JSON.stringify(snap) };
  return '"installed"'
})()`)

// Clicking is `element.click()`, the same call the page's own code makes. There
// is no locator here to auto-wait, so the join loop retries instead.
const clickNamed = (page, pattern) =>
  evaluate(
    page,
    oneLine(`(function(){${HELPERS}
      var el = __find(${js(pattern.source)});
      if (!el) return 'false';
      el.click();
      return 'true'
    })()`),
  ).then((ok) => ok === true).catch(() => false)

const clickSelector = (page, selector) =>
  evaluate(
    page,
    oneLine(`(function(){${HELPERS}
      var f = __all(${js(selector)}), el = null, i;
      for (i = 0; i < f.length; i += 1) { if (f[i].hasAttribute('data-is-muted')) { el = f[i]; break } }
      if (!el) el = f[0];
      if (!el) return 'false';
      el.click();
      return 'true'
    })()`),
  ).then((ok) => ok === true).catch(() => false)

// Meet's name field is React-controlled: assigning to .value updates the DOM
// and leaves React's state untouched, so the join button stays disabled.
const typeName = (page, displayName) =>
  evaluate(
    page,
    oneLine(`(function(){${HELPERS}
      var el = __all(${js(SEL.anonymousName)})[0];
      if (!el) return 'false';
      var set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ${js(String(displayName ?? '').slice(0, 60))});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return 'true'
    })()`),
  ).then((ok) => ok === true).catch(() => false)

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

  if (!(await clickSelector(page, selector))) {
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
// Disabled by capability — live Meet is handed a real track and then refuses to
// start presenting — but kept correct against the DOM so re-enabling it is one
// boolean if that ever changes.

const screenState = async (page) => {
  const read = await readPage(page).catch(() => null)
  if (!read) return 'unknown'
  if (read.presenting) return 'on'
  if (read.canPresent) return 'off'
  // In the call with no present control at all is Meet saying the host turned
  // presenting off for everyone.
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
    await clickSelector(page, SEL.stopPresent)
  } else {
    await ctx.prepareScreen()
    if (!(await clickSelector(page, SEL.present))) {
      log.warn('the present control did not accept a click')
      return screenState(page)
    }
    // Which entry gets picked only decides what Meet ASKS for; the capture shim
    // decides what it gets. Absent on a live Meet, which shows no menu at all.
    await clickNamed(page, /a tab|chrome tab|entire screen|a window/iu)
  }

  const deadline = Date.now() + SHARE_TIMEOUT
  while (Date.now() < deadline) {
    if ((await screenState(page)) === want) return want
    await page.waitForTimeout(300)
  }
  log.warn(`screen share did not reach "${want}" in time`)
  return screenState(page)
}

const failSignedOut = async ({ meetProfile, fail }) => {
  meetProfile?.markNeedsSignIn?.()
  const name = meetProfile?.displayName ?? 'This Google account'
  await fail(
    'account',
    `${name} is signed out — reconnect it in Call Bots → Google accounts`,
    { screenshot: false },
  )
}

// Told apart by whether this bot was given a saved profile. Everything else
// about the two paths is the same.
const REFUSED_GUEST =
  'this meeting does not take guests — Meet refuses anonymous visitors for any ' +
  'meeting created by a personal Google account. Add a Google account in Call ' +
  'Bots and send the bots on that instead.'

const join = async (ctx) => {
  const { page, target, log, fail, options, setWaitingAdmission, displayName } = ctx
  const guest = !ctx.meetProfile
  try {
    // The guest window takes the stats hook DURING the load; a Playwright page
    // already had it seeded at document-start by the codec shim.
    await page.goto(target.url, { waitUntil: 'domcontentloaded', inject: guest ? STATS_SOURCE : null })
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
  let noDevicesSince = null
  let clickedAt = 0

  for (;;) {
    const read = await readPage(page, { withText: true }).catch(() => null)
    if (!read) {
      // The page went away under us mid-read; the next tick either finds it
      // again or runs out the clock with a real message.
      await page.waitForTimeout(POLL_FAST)
      continue
    }
    // Sync on a Playwright page, async on a guest window.
    const url = await Promise.resolve(page.url()).catch(() => '')
    const { stage, detail } = classify(read, url, guest)
    if (process.env.CALL_BOTS_DEBUG_MEET) {
      console.error('[meet]', stage, JSON.stringify({ ...read, headline: read.headline.slice(0, 90) }))
    }

    if (stage === 'in-call') {
      setWaitingAdmission?.(false)
      // Meet greets a fresh profile with onboarding cards that sit over the
      // controls the rest of this adapter needs to click.
      if (read.dismissible && dismissals < 4) {
        dismissals += 1
        await clickNamed(page, DISMISS_NAME)
      }
      return { callId: target.callId }
    }

    if (stage === 'signin') {
      // A guest being asked to sign in has been turned away, not logged out —
      // there is no session here to have expired.
      if (guest) await fail('entry', REFUSED_GUEST)
      await failSignedOut(ctx)
    }

    if (stage === 'devices-ask') {
      await clickNamed(page, USE_DEVICES_NAME)
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'name-entry') {
      // Meet remembers the name, so a second pass finds the field already
      // filled; fill() replaces rather than appends.
      if (!(await typeName(page, displayName))) {
        await fail('entry', 'the Google Meet name field would not take a name')
      }
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'refused') {
      setWaitingAdmission?.(false)
      // "You can't join this video call" means one thing to a guest and quite
      // another to an account, and the fix is not the same.
      const why =
        guest && /can'?t join this/iu.test(detail ?? '')
          ? REFUSED_GUEST
          : `Google Meet refused this ${guest ? 'guest' : 'account'}: ${detail}`
      await fail(phase === 'entry' ? 'entry' : 'join', why)
    }

    if (stage === 'offline') {
      // Worth its own message: "the preview never appeared" sends someone
      // hunting through Meet for a fault that is on this machine.
      await fail('entry', 'this machine lost its network connection — Meet cannot load')
    }

    // Held for a while before it counts: the offer shows up mid-load, before
    // Meet has drawn the device toggles that prove there was never a fault.
    if (stage === 'maybe-no-devices') {
      noDevicesSince ??= Date.now()
      if (Date.now() - noDevicesSince < 15_000) {
        await page.waitForTimeout(POLL_FAST)
        continue
      }
    } else {
      noDevicesSince = null
    }

    if (stage === 'no-devices' || stage === 'maybe-no-devices') {
      await fail(
        'entry',
        'Chrome gave this bot no camera or microphone — Meet offered to join without them, ' +
          'which would put a silent invisible bot in the call',
      )
    }

    if (stage === 'consent') {
      await clickNamed(page, CONSENT_NAME)
      await page.waitForTimeout(POLL_FAST)
      continue
    }

    if (stage === 'prejoin') {
      if (read.dismissible && dismissals < 4) {
        dismissals += 1
        await clickNamed(page, DISMISS_NAME)
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
      if (Date.now() - clickedAt > 8_000 && (await clickNamed(page, JOIN_NAME))) {
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
    if (await clickSelector(page, SEL.leaveButton)) log.info('left Google Meet')
  },
}
