// The browser Google Meet guests actually get in with.
//
// Meet refuses anonymous joins from a browser with a debugger attached — same
// window, same meeting, same minute: readable through AppleScript, refused
// through CDP. So a guest gets no Playwright and no --remote-debugging-port. It
// is a real, ordinary window on a throwaway profile, scripted through Chrome's
// own `execute javascript`, which Meet cannot tell from the page's own code.
//
// Not incognito, though it started that way: an incognito window refuses to
// inherit the camera and microphone grant seeded into the profile, and Meet
// then has nothing to offer but "Continue without microphone and camera". A
// fresh profile is already signed out, which is all a guest actually needs.
//
// Apple Events reach only ONE process per bundle id, and which one is not
// stable, so the bots cannot share the name "Google Chrome" with the user's
// browser. They get a copy of Chrome carrying its own identity instead.
//
// See CLAUDE.md for the measurements behind every line of this.

import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { RUN_MARKER, googleChromePath } from './browser.mjs'
import { baseDir } from './config.mjs'
import { plain as log } from './log.mjs'

const run = promisify(execFile)

export const BUNDLE_ID = 'com.aloqa.call-bots.browser'
const BUNDLE_PATH = join(baseDir, 'Call Bots Browser.app')
// Wherever the user's Chrome actually is: /Applications for most people,
// ~/Applications for the ones who install without admin rights.
const sourceApp = () => {
  const binary = googleChromePath()
  return binary ? binary.replace(/\/Contents\/MacOS\/Google Chrome$/u, '') : null
}
const READY_TIMEOUT = 60_000

const quote = (value) => `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`

// Ten seconds is long for one Apple Event and short enough that a browser too
// busy to answer does not hold a queue slot for half a minute — and a kill
// that means it: osascript stuck inside an Apple Event ignores SIGTERM, which
// is how thirty of them came to be alive at once.
const osascript = async (script, timeout = 10_000) => {
  const { stdout } = await run('osascript', ['-e', script], {
    timeout,
    killSignal: 'SIGKILL',
    maxBuffer: 16 * 1024 * 1024,
  })
  return stdout.trimEnd()
}

const tell = (body) => `tell application id ${quote(BUNDLE_ID)}\n${body}\nend tell`

// Never send an Apple Event to a browser that is not running. `tell application
// id ...` LAUNCHES the app when it is not — and this app is a copy of Chrome,
// so launching it without a --user-data-dir makes it join the user's own Chrome
// and open windows there. One stray `count of windows` did exactly that, twice.
// System Events answers without launching anything.
// macOS refuses the Apple Event outright when Automation permission has not
// been granted — which must not be read as "the browser is not running". It is
// a different problem with a different fix, and it has to be said out loud.
const NOT_PERMITTED = /not authorized to send apple events|-1743|not permitted/iu
const PERMISSION_HELP =
  'Call Bots needs permission to control the Call Bots browser — ' +
  'System Settings → Privacy & Security → Automation → Call Bots'

// Asked of LaunchServices directly, which is exactly what `tell application
// id` consults before deciding whether to launch — and it needs no Automation
// permission at all. The earlier System Events check did: from the packaged
// app every one of those queries failed, every liveness answer was wrong, and
// the whole guest path fell over while the same code ran clean from a shell.
const browserRunning = async () => {
  // Once started, the browser is this process's own child, and its exit is an
  // event already delivered — no lookup needed, and none spawned per Apple
  // Event. Before that, and while it is being stopped, ask the system.
  const child = shared?.child
  if (child) return child.exitCode === null && child.signalCode === null
  let out
  try {
    ;({ stdout: out } = await run('lsappinfo', ['find', `bundleid=${BUNDLE_ID}`], { timeout: 10_000 }))
  } catch {
    return false
  }
  return /^ASN:/u.test(out.trim())
}

const processCount = async () => {
  try {
    const { stdout } = await run('lsappinfo', ['find', `bundleid=${BUNDLE_ID}`], { timeout: 10_000 })
    return String(stdout.split('\n').filter((line) => /^ASN:/u.test(line.trim())).length)
  } catch {
    return '?'
  }
}

// One Apple Event to the bot browser itself, sent before any guest window
// exists, so macOS's Automation prompt for it appears when a person can answer
// it — not while bots are already launching, which was measured as a guest
// that never navigated. The call blocks while the dialog is up and gets the
// time a person needs.
const preflightPermissions = async () => {
  if (!(await browserRunning())) return
  try {
    await osascript(tell('return count of windows'), 120_000)
  } catch (error) {
    if (NOT_PERMITTED.test(String(error.message))) throw new Error(PERMISSION_HELP)
  }
}

// Chrome answers Apple Events one at a time, so sending more at once only
// queues them inside Chrome, where a caller that gave up waiting cannot take
// its request back. Queue them here instead, a few at a time, and refuse
// outright what has already waited longer than any caller would: with three
// guests and a dashboard polling every second, that is how every probe stopped
// timing out at once.
const SPEAK_AT_ONCE = 3
const SPEAK_QUEUE_MS = 6000
let speaking = 0
const speakQueue = []
const nextSpeaker = () => {
  while (speaking < SPEAK_AT_ONCE && speakQueue.length > 0) {
    const { resolve, reject, queuedAt } = speakQueue.shift()
    if (Date.now() - queuedAt > SPEAK_QUEUE_MS) {
      reject(new Error('the Call Bots browser is busy'))
      continue
    }
    speaking += 1
    resolve()
  }
}
const turnToSpeak = () =>
  new Promise((resolve, reject) => {
    speakQueue.push({ resolve, reject, queuedAt: Date.now() })
    nextSpeaker()
  })
const doneSpeaking = () => {
  speaking -= 1
  nextSpeaker()
}

const speak = async (body) => {
  if (!(await browserRunning())) throw new Error('the Call Bots browser is not running')
  await turnToSpeak()
  let out
  try {
    out = await osascript(tell(body))
  } catch (error) {
    if (NOT_PERMITTED.test(String(error.message))) throw new Error(PERMISSION_HELP)
    throw error
  } finally {
    doneSpeaking()
  }
  if (process.env.CALL_BOTS_DEBUG_MEET) {
    console.error('[speak]', body.split('\n').pop().slice(0, 44), '| procs after:', await processCount())
  }
  return out
}

// A copy of Chrome with its own bundle identifier, so AppleScript can address
// the bots' browser without ever reaching the user's. Built once and kept.
const bundleVersion = async (app) => {
  try {
    const { stdout } = await run('/usr/libexec/PlistBuddy', [
      '-c',
      'Print :CFBundleShortVersionString',
      join(app, 'Contents/Info.plist'),
    ])
    return stdout.trim()
  } catch {
    return null
  }
}

export const ensureGuestBundle = async () => {
  const source = sourceApp()
  if (!source) {
    throw new Error('Google Chrome is required for Meet guests — Meet turns away anything else')
  }
  if (existsSync(join(BUNDLE_PATH, 'Contents/MacOS/Google Chrome'))) {
    // Chrome updates itself; a copy left behind on an old version would one
    // day meet Meet's "your browser isn't supported". Rebuild when they differ.
    const [have, want] = await Promise.all([bundleVersion(BUNDLE_PATH), bundleVersion(source)])
    if (!want || have === want) return BUNDLE_PATH
    log.info(`Google Chrome is now ${want} — rebuilding the Call Bots browser (about a minute)`)
  } else {
    log.info('building the Call Bots browser for Meet guests — one time, about a minute')
  }
  const staging = `${BUNDLE_PATH}.building`
  rmSync(staging, { recursive: true, force: true })
  await run('ditto', [source, staging], { timeout: 600_000 })
  const plist = join(staging, 'Contents/Info.plist')
  await run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${BUNDLE_ID}`, plist])
  await run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName CallBotsBrowser', plist])
  // Without this codesign refuses: "resource fork, Finder information, or
  // similar detritus not allowed".
  await run('xattr', ['-cr', staging], { timeout: 120_000 })
  await run('codesign', ['--force', '--sign', '-', staging], { timeout: 300_000 })
  rmSync(BUNDLE_PATH, { recursive: true, force: true })
  await run('mv', [staging, BUNDLE_PATH])
  await registerBundle()
  return BUNDLE_PATH
}

// One LaunchServices registration for the bundle id, at the path that exists.
// `tell application id` resolves through LaunchServices, and a stale record —
// a staging copy, an old build — is a launch of the wrong thing.
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const registerBundle = async () => {
  await run(LSREGISTER, ['-u', `${BUNDLE_PATH}.building`], { timeout: 60_000 }).catch(() => {})
  await run(LSREGISTER, ['-f', BUNDLE_PATH], { timeout: 60_000 }).catch(() => {})
}

// Window ids run past 2^30, and AppleScript turns a literal that big into a
// real — "whose id is 1439954207" goes looking for 1.439954207E+9 and fails
// with "Invalid index". Comparing as text sidesteps the conversion entirely.
// By id, as an object specifier Chrome resolves when each line runs. This
// used to walk `windows` and keep the loop variable — a reference by
// position — and Chrome orders windows front-to-back, so a window made or
// raised between the walk and the use moved every position along: one
// guest's navigation landed in another's window, and a failed guest closed
// a window that was never its own.
const onWindow = (windowId, body) =>
  [
    'try',
    `  set _w to window id ${String(windowId)}`,
    'on error',
    '  error "this Meet guest window is gone"',
    'end try',
    'set _t to active tab of _w',
    body,
  ].join('\n')

const windowIds = async () => {
  const out = await speak('return id of every window').catch(() => '')
  return out.split(',').map((value) => value.trim()).filter(Boolean)
}

let shared = null

// Stream stats for a guest come from chrome://webrtc-internals, kept open in
// one extra window of the shared browser. It sees every peer connection in the
// process — including the ones Meet hides in module closures, which nothing
// injected into the page can reach — and, unlike a page, Chrome's AppleScript
// interface is allowed to read it. It polls getStats itself, once a second,
// and renders the results into tables whose ids spell out what they hold:
// <rid>-<lid>-table-<statId>-<field>.
const INTERNALS = 'chrome://webrtc-internals/'

// Every new window is found by diffing ids before and after "make new window",
// so two of those in flight at once each take the other's window: a guest
// ended up holding the stats window and navigated its own to nowhere. One at
// a time, always.
let creating = Promise.resolve()
const createWindow = (work) => {
  const turn = creating.then(work, work)
  creating = turn.catch(() => {})
  return turn
}

// The id comes back from the creation itself. This used to list the windows
// before and after making one and take the difference — and under load, a
// listing that failed read as an empty list, so the "new" window was whichever
// existing one came first: a guest was handed another guest's window, drove
// it, and closed it on its way out.
const newWindowId = async () => {
  const id = await speak('set _w to make new window\nreturn (id of _w) as text')
  if (!/^\d+$/u.test(id.trim())) throw new Error('the Call Bots browser did not open a window')
  return id.trim()
}

// Guest windows are small and tiled, not left where Chrome drops them, one on
// top of another at full size. Meet sizes what it asks the server for by the
// tiles it draws, so a small window receives small video — the difference
// between three guests and five on the same machine — and the desktop stays
// legible with several of them open.
const WINDOW_W = 640
const WINDOW_H = 440
const COLUMNS = 3
const placeWindow = async (windowId, slot) => {
  const col = slot % COLUMNS
  const row = Math.floor(slot / COLUMNS) % 3
  const x = col * WINDOW_W
  const y = 40 + row * (WINDOW_H + 10)
  await speak(onWindow(windowId, `set bounds of _w to {${x}, ${y}, ${x + WINDOW_W}, ${y + WINDOW_H}}`)).catch(
    () => {},
  )
}

const ensureStatsWindow = async () => {
  if (!shared) return null
  // Memoised while in flight: two guests opening at once must not each build
  // a stats window of their own.
  // A failure is not memoised: one window that would not open must not cost
  // the whole run its stats, so the next read tries again.
  const mine = (shared.statsWindowPromise ??= createWindow(async () => {
    const windowId = await newWindowId()
    await speak(onWindow(windowId, `set URL of _t to ${quote(INTERNALS)}`))
    // Nobody needs to see it; it keeps polling while minimised.
    await speak(onWindow(windowId, 'set minimized of _w to true')).catch(() => {})
    if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] stats window', windowId)
    return windowId
  }).catch((error) => {
    if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] stats window failed:', error.message)
    if (shared?.statsWindowPromise === mine) shared.statsWindowPromise = null
    return null
  }))
  shared.statsWindow = await mine
  return shared.statsWindow
}

// The stats window a read could not reach — closed by hand, say — is forgotten,
// so the next read opens another rather than asking a gone window forever.
const forgetStatsWindow = (windowId) => {
  if (shared?.statsWindow === windowId) {
    shared.statsWindow = null
    shared.statsWindowPromise = null
  }
}

// One read of the whole page: which connection belongs to which page URL, and
// the handful of fields the dashboard shows. Everything else on the page is
// SDP and candidate grids the reader never touches.
// Single line, like everything sent through AppleScript. The bot's own tile
// first — it is the one carrying Meet's own-video controls (Reframe,
// Backgrounds, effects), which no remote tile has — and only then the biggest
// playing video, because in a grid of three the biggest can be somebody else's
// dark camera.
const GRAB_VIDEO = [
  '(function(){',
  'var playing=function(v){return v&&v.readyState>=2&&v.videoWidth>0&&!v.paused};',
  'var best=null,area=0;',
  '[].slice.call(document.querySelectorAll("[data-participant-id]")).forEach(function(t){',
  '  if(best)return;',
  '  if(!t.querySelector("[aria-label*=Reframe i],[aria-label*=Backgrounds i],[aria-label*=effects i]"))return;',
  '  var v=t.querySelector("video");if(playing(v))best=v});',
  'if(!best)[].slice.call(document.querySelectorAll("video")).forEach(function(v){',
  '  if(!playing(v))return;',
  '  var r=v.getBoundingClientRect();var a=r.width*r.height;if(a>area){area=a;best=v}});',
  'if(!best)return "";',
  'var w=320,h=Math.max(1,Math.round(w*best.videoHeight/best.videoWidth));',
  'var c=document.createElement("canvas");c.width=w;c.height=h;',
  'try{c.getContext("2d").drawImage(best,0,0,w,h);return c.toDataURL("image/jpeg",0.6)}catch(e){return ""}',
  '})()',
].join('')

const INTERNALS_READ = [
  '(function(){',
  'var heads={};',
  '[].slice.call(document.querySelectorAll(".tab-head")).forEach(function(e){',
  '  var t=e.textContent.trim();var m=t.match(/rid: (\\d+), lid: (\\d+)/);',
  '  if(m)heads[m[1]+"-"+m[2]]=t.split(" [")[0]});',
  'var stats={};',
  '[].slice.call(document.querySelectorAll("[id*=-table-]")).forEach(function(e){',
  '  var m=e.id.match(/^(\\d+-\\d+)-table-(.+)-(\\w+)$/);if(!m)return;',
  '  var f=m[3];if(!/^(type|kind|bytesSent|bytesReceived|packetsReceived|currentRoundTripTime|packetsLost|jitter|state|nominated|mediaSourceId|trackIdentifier|frameWidth|frameHeight|framesPerSecond|codecId|ssrc|mid|rid|nackCount|pliCount|jitterBufferDelay|jitterBufferEmittedCount|framesDropped|freezeCount|decoderImplementation|audioLevel|qualityLimitationReason|localCandidateId|remoteCandidateId|candidateType|protocol|dtlsState|mimeType|clockRate|channels|availableOutgoingBitrate|selectedCandidatePairId)$/.test(f))return;',
  '  var k=m[1]+"|"+m[2];if(!stats[k])stats[k]={pc:m[1]};',
  '  var v=e.textContent.trim();if(v.indexOf(f)===0)v=v.slice(f.length);v=v.replace(/\\s*\\uD83D\\uDD17\\s*$/,"").trim();',
  '  stats[k][f]=v});',
  'return JSON.stringify({heads:heads,stats:stats})',
  '})()',
].join('')

const readInternals = async () => {
  const windowId = await ensureStatsWindow()
  if (!windowId) return null
  let out = ''
  try {
    out = await speak(onWindow(windowId, `return execute _t javascript ${quote(INTERNALS_READ)}`))
  } catch (error) {
    if (/window is gone/u.test(error.message)) forgetStatsWindow(windowId)
    return null
  }
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}

const startShared = async (media, options) => {
  clearStaleProfiles()
  const bundle = await ensureGuestBundle()
  const userDataDir = mkdtempSync(join(tmpdir(), 'call-bots-meet-guests-'))
  // Scripting is a per-profile preference with no command-line flag, and it has
  // to be there before Chrome first reads the profile.
  mkdirSync(join(userDataDir, 'Default'), { recursive: true })
  const allow = { 'https://meet.google.com:443,*': { setting: 1 } }
  writeFileSync(
    join(userDataDir, 'Default', 'Preferences'),
    JSON.stringify({
      browser: { allow_javascript_apple_events: true },
      // Nobody is here to click Allow. Without the camera and microphone
      // already granted, Meet sits on "Continue without microphone and camera"
      // and never offers to use them. Playwright's grantPermissions is not an
      // option here — this window has no debugger attached, which is the whole
      // point — so the grant is seeded as a content setting instead, the same
      // record Chrome writes when a person clicks Allow.
      profile: {
        content_settings: {
          exceptions: { media_stream_camera: allow, media_stream_mic: allow },
        },
      },
    }),
  )

  const child = spawn(
    join(bundle, 'Contents/MacOS/Google Chrome'),
    [
      `--user-data-dir=${userDataDir}`,
      // Not incognito. A throwaway profile is already signed out, which is all
      // a guest needs, and incognito refuses to inherit the camera and
      // microphone grant seeded below — leaving Meet stuck offering to join
      // without them.
      '--lang=en-US',
      '--no-first-run',
      '--no-default-browser-check',
      // Or macOS asks for the login password so this re-signed copy can read
      // the real Chrome's "Chrome Safe Storage". A throwaway incognito profile
      // has no use for it.
      '--use-mock-keychain',
      '--password-store=basic',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      // Process-wide, so every guest in a run shares this clip and this voice.
      ...(media && !options.noVideo ? [`--use-file-for-fake-video-capture=${media.video}`] : []),
      ...(media && !options.noAudio ? [`--use-file-for-fake-audio-capture=${media.audio}`] : []),
      `${RUN_MARKER}=${options.runId}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )

  // Wait for the process to exist before addressing it, or the first Apple
  // Event launches a second copy into the user's Chrome.
  if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] spawned pid', child.pid)
  const deadline = Date.now() + READY_TIMEOUT
  let asked = false
  while (Date.now() < deadline) {
    if (await browserRunning()) {
      if (!asked) {
        asked = true
        await preflightPermissions()
      }
      const ids = await windowIds()
      if (ids.length > 0) return { child, userDataDir, windows: new Set(), spare: ids[0], slots: 0 }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  stop(child, userDataDir)
  throw new Error('the Call Bots browser did not come up for the Meet guests')
}

// The kill itself is synchronous, so an exit handler can call this without
// waiting; a caller that can wait gets the process's actual exit, so the
// orchestrator's sweep does not find a browser still on its way out and
// report it as a leftover.
const stop = async (child, userDataDir) => {
  try {
    process.kill(-child.pid)
  } catch {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  const gone = Date.now() + EXIT_WAIT
  while (Date.now() < gone && (await browserRunning())) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  // Still here after a polite ask — a throwaway profile has nothing to save.
  if (await browserRunning()) {
    try {
      process.kill(-child.pid, 'SIGKILL')
    } catch {
      // Gone between the check and the kill.
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  // Chrome keeps unlinking its own files for several seconds after the kill,
  // and a removal that lands inside that window loses — measured as one
  // profile left behind per run at 2.5 s of retries. Keep trying for a while,
  // and let startShared clear whatever a crashed run left.
  const sweep = (attempt = 0) => {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      if (attempt < 20) setTimeout(() => sweep(attempt + 1), 1000).unref?.()
    }
  }
  sweep()
}

// Profiles a previous run could not remove — it crashed, or Chrome outlived
// its sweep. Nothing else refers to them once their browser is gone.
const clearStaleProfiles = () => {
  const dir = tmpdir()
  let names = []
  try {
    names = readdirSync(dir).filter((name) => name.startsWith('call-bots-meet-guests-'))
  } catch {
    return
  }
  for (const name of names) {
    const path = join(dir, name)
    if (shared && path === shared.userDataDir) continue
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Still held by something; the next start tries again.
    }
  }
}

// Serialised: two guests starting at once must not each start a browser.
let starting = null

// The browser is detached so a group kill can target it precisely, which also
// means nothing kills it for us. A run that dies without tearing down would
// otherwise leave its windows on screen for good.
let exitHooked = false
const killOnExit = () => {
  if (exitHooked) return
  exitHooked = true
  const bail = () => {
    if (!shared) return
    const { child, userDataDir } = shared
    shared = null
    stop(child, userDataDir)
  }
  process.once('exit', bail)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      bail()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

// How long one read of webrtc-internals serves every asker. The dashboard's
// state request and the health tick both want a summary; two reads a few
// milliseconds apart would make the later one a rate over no time at all.
const FRESH_MS = 1500
// How long a closing browser gets to exit on its own before it is killed.
const EXIT_WAIT = 8000
// The gap between a window's first two reads, which together make its first
// real rate. Longer than a refresh of webrtc-internals, or the pair could
// straddle none and report a bot sending nothing.
const FIRST_SAMPLE_MS = 2500
// A rate is taken over this much history, not just the last two reads:
// webrtc-internals refreshes its tables about once a second, and unevenly
// while its window sits minimised, so two reads 1.5 s apart can straddle no
// refresh (a rate of zero) or two (double). Over a wider window both even out.
const RATE_WINDOW_MS = 6000

export class GuestWindow {
  constructor(windowId, tag) {
    this.windowId = windowId
    // Rides in the URL fragment, which Meet ignores and webrtc-internals
    // prints, so this window's connections can be told from the others'.
    this.tag = tag
    this.closed = false
    // Cumulative bytes per stream over the last RATE_WINDOW_MS of reads,
    // shared by both readers: every read is another sample for the other.
    this.samples = new Map()
    this.cache = { summary: null, summaryAt: 0, snapshot: null, snapshotAt: 0 }
    this.inFlight = { summary: null, snapshot: null }
  }

  static async open(media, options, { tag = 'guest' } = {}) {
    if (!shared) {
      killOnExit()
      starting ??= startShared(media, options).finally(() => {
        starting = null
      })
      shared = await starting
    }

    // The stats window goes first, so it is never in flight beside a guest's.
    await ensureStatsWindow()
    // The first guest takes the window the browser opened with; the rest get
    // one each, so every guest is its own Meet participant. Normal windows,
    // deliberately: the profile is a throwaway that is already signed out, and
    // an incognito window would not inherit the camera and microphone grant
    // seeded into it — leaving Meet nothing to offer but "Continue without
    // microphone and camera".
    const spare = shared.spare
    shared.spare = null
    const windowId = spare ?? (await createWindow(newWindowId))
    if (process.env.CALL_BOTS_DEBUG_MEET) {
      console.error('[guest-browser] window', windowId, 'for', tag, spare ? '(spare)' : '(new)')
    }
    shared.windows.add(windowId)
    await placeWindow(windowId, shared.slots++)
    return new GuestWindow(windowId, tag)
  }

  #tagged(url) {
    return url.includes('#') ? url : `${url}#cb-${this.tag}`
  }

  // The same shape the stream monitor's summary takes, so the card needs no
  // second code path. Rates are differenced against the previous read, over
  // the real gap between them.
  // The expanded stream panel, in the shape the monitor's snapshot takes so
  // the dashboard needs no second renderer. Everything here is what
  // webrtc-internals already prints; this only arranges it.
  rtcSummary() {
    return this.#shared('summary', () => this.#readSummary())
  }

  rtcSnapshot() {
    return this.#shared('snapshot', () => this.#readSnapshot())
  }

  // One read serves every asker for a moment, and a read in flight is shared
  // rather than raced: a second Apple Event behind the first would only slow
  // both down, and its answer would be a rate over nothing.
  #shared(kind, read) {
    if (this.cache[kind] !== null && Date.now() - this.cache[`${kind}At`] < FRESH_MS) {
      return Promise.resolve(this.cache[kind])
    }
    if (this.inFlight[kind]) return this.inFlight[kind]
    this.inFlight[kind] = read()
      .then((value) => {
        this.cache[kind] = value
        this.cache[`${kind}At`] = Date.now()
        return value
      })
      .finally(() => {
        this.inFlight[kind] = null
      })
    return this.inFlight[kind]
  }

  async #readSnapshot() {
    if (this.closed) return null
    const page = await readInternals()
    if (!page) return null
    const marker = `#cb-${this.tag}`
    const mine = new Set(
      Object.entries(page.heads).filter(([, url]) => url.includes(marker)).map(([pc]) => pc),
    )
    if (mine.size === 0) return null
    const now = Date.now()
    const rate = (key, bytes) => this.#rate(key, bytes, now)
    const r1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null)
    const num = (value) => (value === undefined || value === '' ? null : Number(value))
    const byId = (pc, id) => (id ? page.stats[`${pc}|${id}`] ?? null : null)
    const codecOf = (stat) => {
      const codec = byId(stat.pc, stat.codecId)
      if (!codec?.mimeType) return null
      return {
        name: String(codec.mimeType).split('/').pop(),
        clock: num(codec.clockRate),
        channels: num(codec.channels),
      }
    }

    const outbound = []
    const inbound = []
    let rtt = null
    let jitter = null
    let loss = null
    let avail = null
    let limit = null
    let dtls = null
    let localCand = null
    let remoteCand = null

    for (const [key, stat] of Object.entries(page.stats)) {
      if (!mine.has(stat.pc)) continue
      const id = key.split('|')[1]
      if (stat.type === 'outbound-rtp') {
        const kbps = r1(rate(key, num(stat.bytesSent) || 0))
        const reason = stat.qualityLimitationReason
        if (reason && reason !== 'none') limit = reason
        outbound.push({
          id, kind: stat.kind ?? null, dir: 'out', ssrc: num(stat.ssrc), mid: stat.mid ?? null,
          track: stat.mediaSourceId ?? null, name: null, kbps,
          w: num(stat.frameWidth), h: num(stat.frameHeight), fps: num(stat.framesPerSecond),
          codec: codecOf(stat), bytes: num(stat.bytesSent), rid: stat.rid ?? null,
          limit: reason && reason !== 'none' ? reason : null, idle: kbps === 0,
        })
      } else if (stat.type === 'inbound-rtp') {
        const kbps = r1(rate(key, num(stat.bytesReceived) || 0))
        const lost = num(stat.packetsLost) ?? 0
        const got = num(stat.packetsReceived) ?? 0
        if (stat.kind === 'video' && jitter === null && stat.jitter) jitter = num(stat.jitter) * 1000
        inbound.push({
          id, kind: stat.kind ?? null, dir: 'in', ssrc: num(stat.ssrc), mid: stat.mid ?? null,
          track: stat.trackIdentifier ?? null, name: null, kbps,
          w: num(stat.frameWidth), h: num(stat.frameHeight), fps: num(stat.framesPerSecond),
          codec: codecOf(stat), bytes: num(stat.bytesReceived),
          jitter: stat.jitter ? r1(num(stat.jitter) * 1000) : null,
          lossPct: got + lost > 0 ? r1((lost / (got + lost)) * 100) : null,
          jbDelay: null, framesDropped: num(stat.framesDropped), freezeCount: num(stat.freezeCount),
          nack: num(stat.nackCount), pli: num(stat.pliCount),
          decoder: stat.decoderImplementation ?? null, level: num(stat.audioLevel),
        })
      } else if (stat.type === 'candidate-pair' && stat.state === 'succeeded' && stat.nominated === 'true') {
        rtt = stat.currentRoundTripTime ? num(stat.currentRoundTripTime) * 1000 : rtt
        avail = num(stat.availableOutgoingBitrate)
        const local = byId(stat.pc, stat.localCandidateId)
        const remote = byId(stat.pc, stat.remoteCandidateId)
        if (local) localCand = { type: local.candidateType ?? null, protocol: local.protocol ?? null }
        if (remote) remoteCand = { type: remote.candidateType ?? null, protocol: remote.protocol ?? null }
      } else if (stat.type === 'transport' && stat.dtlsState) {
        dtls = stat.dtlsState
      }
    }
    const lossValues = inbound.map((s) => s.lossPct).filter((v) => v !== null)
    if (lossValues.length > 0) loss = r1(Math.max(...lossValues))
    const up = r1(outbound.reduce((sum, s) => sum + (s.kbps ?? 0), 0))
    const down = r1(inbound.reduce((sum, s) => sum + (s.kbps ?? 0), 0))
    const via = localCand?.type === 'relay' || remoteCand?.type === 'relay'
    return {
      t: now, pcs: mine.size, via, viaTransport: via,
      caps: { audio: [], video: [] },
      negotiated: {
        audio: [...new Set(outbound.filter((s) => s.kind === 'audio').map((s) => s.codec?.name).filter(Boolean))],
        video: [...new Set(outbound.filter((s) => s.kind === 'video').map((s) => s.codec?.name).filter(Boolean))],
        screen: [],
      },
      down, up, rtt: r1(rtt), loss, jitter: r1(jitter),
      avail: avail === null ? null : r1(avail / 1000), limit, dtls, localCand, remoteCand,
      outbound, inbound, dataChannels: [],
    }
  }

  async #readSummary() {
    if (this.closed) return null
    let page = await readInternals()
    if (!page) return null
    // A rate is the difference between two reads, so a first read on its own
    // reports every stream at zero — and a dashboard opened the moment a bot
    // lands would show it sending nothing. Take the baseline, wait a beat and
    // read again; once per window.
    if (this.samples.size === 0) {
      if (this.#tally(page) === null) return null
      await new Promise((resolve) => setTimeout(resolve, FIRST_SAMPLE_MS))
      page = (await readInternals()) ?? page
    }
    return this.#tally(page)
  }

  // Kilobits per second of a cumulative byte counter over the last window of
  // reads. Clamped: a counter that went backwards is a new stream, not debt.
  #rate(key, bytes, now) {
    const samples = this.samples.get(key) ?? []
    samples.push({ bytes, at: now })
    while (samples.length > 2 && now - samples[1].at >= RATE_WINDOW_MS) samples.shift()
    this.samples.set(key, samples)
    const first = samples[0]
    return now > first.at ? Math.max(0, ((bytes - first.bytes) * 8) / (now - first.at)) : 0
  }

  #tally(page) {
    const marker = `#cb-${this.tag}`
    const mine = new Set(
      Object.entries(page.heads)
        .filter(([, url]) => url.includes(marker))
        .map(([pc]) => pc),
    )
    if (mine.size === 0) return null

    const now = Date.now()
    const rate = (key, bytes) => this.#rate(key, bytes, now)
    const r1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null)

    let up = 0
    let upV = 0
    let down = 0
    let rtt = null
    let jitter = null
    // Distinct sources and tracks, not streams: Meet sends a camera as three
    // simulcast layers, and three layers must not read as three cameras.
    const out = { a: new Set(), v: new Set() }
    const inbound = { a: new Set(), v: new Set() }

    for (const [key, stat] of Object.entries(page.stats)) {
      if (!mine.has(stat.pc)) continue
      if (stat.type === 'outbound-rtp') {
        const kbps = rate(key, Number(stat.bytesSent) || 0)
        up += kbps
        if (stat.kind === 'video') upV += kbps
        if (kbps > 0) out[stat.kind === 'video' ? 'v' : 'a'].add(stat.mediaSourceId || key)
      } else if (stat.type === 'inbound-rtp') {
        const kbps = rate(key, Number(stat.bytesReceived) || 0)
        down += kbps
        if (kbps > 0) inbound[stat.kind === 'video' ? 'v' : 'a'].add(stat.trackIdentifier || key)
        if (stat.kind === 'video' && jitter === null && stat.jitter) jitter = Number(stat.jitter) * 1000
      } else if (
        stat.type === 'candidate-pair' &&
        stat.state === 'succeeded' &&
        stat.currentRoundTripTime
      ) {
        rtt = Number(stat.currentRoundTripTime) * 1000
      }
    }
    return {
      pcs: mine.size,
      via: false,
      down: r1(down),
      up: r1(up),
      upV: r1(upV),
      rtt: r1(rtt),
      loss: null,
      jit: r1(jitter),
      in: { a: inbound.a.size, v: inbound.v.size },
      out: { a: out.a.size, v: out.v.size },
      limit: null,
    }
  }

  #on(body) {
    return onWindow(this.windowId, body)
  }

  async url() {
    if (this.closed) return 'about:blank'
    return speak(this.#on('return URL of _t')).catch(() => 'about:blank')
  }

  // `inject` is a one-line expression to run as early as the new document will
  // take it. Meet grabs RTCPeerConnection into a module closure while its bundle
  // parses, so anything that arrives after the page has settled is too late to
  // see a single connection — the only chance is to get in during the load.
  async goto(target) {
    const url = this.#tagged(target)
    const wanted = url.split('#')[0]
    // A `set URL` on a window Chrome has only just made can lose to the new
    // tab page still committing underneath it — the tab stays on
    // chrome://newtab and the bot polls a page that will never be Meet. So
    // the address is checked, and set again until it holds.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await speak(this.#on(`set URL of _t to ${quote(url)}`))
      const settled = Date.now() + 2500
      while (Date.now() < settled) {
        await this.waitForTimeout(250)
        const current = await this.url().catch(() => '')
        if (current.startsWith(wanted)) {
          // `set URL` returns as soon as the navigation is asked for, and the
          // tab reports the new address while the old document is still the
          // one answering — so what is asked is where the document itself
          // says it is.
          const host = new URL(wanted).host
          const deadline = Date.now() + 45_000
          while (Date.now() < deadline) {
            const seen = await this.evaluate('location.host+" "+document.readyState').catch(() => null)
            const [where, state] = String(seen ?? '').split(' ')
            if (where === host && (state === 'interactive' || state === 'complete')) return
            await this.waitForTimeout(250)
          }
          return
        }
      }
    }
    throw new Error('the Meet guest window would not navigate')
  }

  // `source` must be a SINGLE LINE: AppleScript string literals cannot span
  // lines, and a multi-line script comes back as `missing value` rather than an
  // error. Anything structured is stringified in-page and parsed here.
  async evaluate(source) {
    if (this.closed) throw new Error('this Meet guest window is closed')
    const out = await speak(this.#on(`return execute _t javascript ${quote(source)}`))
    if (out === 'missing value' || out === '') return null
    try {
      return JSON.parse(out)
    } catch {
      return out
    }
  }

  waitForTimeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // The dashboard's card thumbnail. First choice: draw the largest playing
  // <video> on the page — in a call that is the bot's own camera as Meet
  // renders it — to a canvas and hand back a JPEG. No permission, no window
  // geometry, and it shows exactly what the bot publishes. Fallback: photograph
  // the window's rectangle on screen, which needs Screen Recording and shows
  // whatever sits on top of it.
  async screenshot() {
    if (this.closed) return null
    const grabbed = await this.evaluate(GRAB_VIDEO).catch(() => null)
    if (typeof grabbed === 'string' && grabbed.startsWith('data:image/jpeg;base64,')) {
      return Buffer.from(grabbed.slice('data:image/jpeg;base64,'.length), 'base64')
    }
    return this.#photograph()
  }

  async #photograph() {
    const raw = await speak(this.#on('return bounds of _w')).catch(() => '')
    const [left, top, right, bottom] = raw.split(',').map((value) => Number(value.trim()))
    if (![left, top, right, bottom].every(Number.isFinite)) return null
    const width = right - left
    const height = bottom - top
    if (width < 40 || height < 40) return null
    const file = join(tmpdir(), `call-bots-shot-${this.windowId}-${Date.now()}.jpg`)
    try {
      await run('screencapture', ['-x', '-t', 'jpg', `-R${left},${top},${width},${height}`, file], {
        timeout: 8_000,
      })
      return readFileSync(file)
    } catch {
      return null
    } finally {
      rmSync(file, { force: true })
    }
  }

  isClosed() {
    return this.closed
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await speak(this.#on('close _w')).catch(() => {
      // A window somebody already closed is not a teardown failure.
    })
    shared?.windows.delete(this.windowId)
    if (shared && shared.windows.size === 0) {
      const { child, userDataDir } = shared
      shared = null
      await stop(child, userDataDir)
    }
  }
}
