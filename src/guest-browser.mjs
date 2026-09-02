// The browser Google Meet guests actually get in with.
//
// Meet refuses anonymous joins from a browser with a debugger attached — same
// window, same meeting, same minute: readable through Apple Events, refused
// through CDP. So a guest gets no Playwright and no --remote-debugging-port. It
// is a real, ordinary window on a throwaway profile, scripted through Chrome's
// own `execute javascript`, which Meet cannot tell from the page's own code.
//
// One Chrome process per guest. Chrome's fake camera and microphone are
// process-wide flags, so guests sharing a process shared one clip and one
// voice; a process each gives every guest its own, cycling through the five
// clips and voices exactly as Aloqa bots do. Neither AppleScript nor
// JavaScript for Automation can do this — `tell application id` reaches ONE
// process per bundle id, and Application(pid) was measured to answer from that
// same process whatever pid it was given — but the Apple Event Manager itself
// addresses a process by pid without ambiguity. A small compiled helper,
// scripts/macos-app/aesend.swift, sends the handful of events needed with the
// target built from the pid and nothing in between: twelve concurrent calls
// to two processes, every answer from the right one. A pid that is gone is an
// error, never a launch of a stray Chrome.
//
// The processes still run from a copy of Chrome carrying its own bundle
// identity. The Automation grant macOS asks for is per target application, and
// it should name the bots' browser — not hand a script the run of the user's
// own Chrome.
//
// Not incognito, though it started that way: an incognito window refuses to
// inherit the camera and microphone grant seeded into the profile, and Meet
// then has nothing to offer but "Continue without microphone and camera". A
// fresh profile is already signed out, which is all a guest actually needs.
//
// See CLAUDE.md for the measurements behind every line of this.

import { execFile, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { RUN_MARKER, googleChromePath } from './browser.mjs'
import { baseDir, projectRoot } from './config.mjs'
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
// How long a closing browser gets to exit on its own before it is killed.
const EXIT_WAIT = 6000

// ---------------------------------------------------------------------------
// The helper.

const HELPER_SOURCE = join(projectRoot, 'scripts', 'macos-app', 'aesend.swift')
// Built into the app bundle by scripts/build-macos-app.mjs; a source checkout
// compiles it once into the data directory and again when the source changes.
const HELPER_BUNDLED = join(projectRoot, 'native', 'aesend')
const HELPER_BUILT = join(baseDir, 'aesend')

let helperPromise = null
const ensureHelper = () => {
  helperPromise ??= (async () => {
    if (existsSync(HELPER_BUNDLED)) return HELPER_BUNDLED
    if (!existsSync(HELPER_SOURCE)) {
      throw new Error('the Call Bots app is missing its Apple Events helper — reinstall it')
    }
    const fresh = existsSync(HELPER_BUILT) && statSync(HELPER_BUILT).mtimeMs >= statSync(HELPER_SOURCE).mtimeMs
    if (fresh) return HELPER_BUILT
    try {
      await run('swiftc', ['--version'], { timeout: 30_000 })
    } catch {
      throw new Error(
        'Meet guests need the Call Bots helper, and this checkout cannot build it — ' +
          'install Xcode Command Line Tools (xcode-select --install) or use the packaged app',
      )
    }
    log.info('compiling the Apple Events helper for Meet guests — one time')
    mkdirSync(baseDir, { recursive: true })
    await run('swiftc', ['-O', '-o', HELPER_BUILT, HELPER_SOURCE], { timeout: 300_000 })
    return HELPER_BUILT
  })().catch((error) => {
    helperPromise = null
    throw error
  })
  return helperPromise
}

// One helper invocation: arguments, optional stdin, and a timeout that kills.
// Ten seconds is long for one Apple Event and short enough that a browser too
// busy to answer does not hold a queue slot for half a minute.
const invoke = (helper, args, { input = null, timeout = 10_000 } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(helper, args, {
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, AESEND_TIMEOUT: String(Math.ceil(timeout / 1000)) },
    })
    let out = ''
    let err = ''
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      child.kill('SIGKILL')
      reject(new Error('Apple Event timed out'))
    }, timeout + 1000)
    child.stdout.on('data', (chunk) => {
      out += chunk
    })
    child.stderr.on('data', (chunk) => {
      err += chunk
    })
    child.on('error', (error) => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (code === 0) resolve(out.replace(/\n$/u, ''))
      else reject(new Error(err.trim() || `helper exited ${code}`))
    })
    if (input !== null) {
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    }
  })

// macOS refuses the Apple Event outright when Automation permission has not
// been granted — which must not be read as "the browser is not running". It is
// a different problem with a different fix, and it has to be said out loud.
const NOT_PERMITTED = /-1743|not authorized|not permitted/iu
const PERMISSION_HELP =
  'Call Bots needs permission to control the Call Bots browser — ' +
  'System Settings → Privacy & Security → Automation → Call Bots'
const GONE = /-1728\b/u
const NO_PROCESS = /-600\b|-609\b/u

// Chrome answers Apple Events one at a time per process, so sending more at
// once only queues them inside Chrome, where a caller that gave up waiting
// cannot take its request back. Queue them here instead, a few at a time, and
// refuse outright what has already waited longer than any caller would: with
// three guests and a dashboard polling every second, that is how every probe
// stopped timing out at once.
const SPEAK_AT_ONCE = 4
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

const alive = (proc) => proc.child.exitCode === null && proc.child.signalCode === null

// One Apple Event to one guest's browser.
const speak = async (proc, args, options = {}) => {
  if (!alive(proc)) throw new Error('the Call Bots browser is not running')
  const helper = await ensureHelper()
  await turnToSpeak()
  try {
    return await invoke(helper, [String(proc.child.pid), ...args], options)
  } catch (error) {
    const message = String(error.message)
    if (NOT_PERMITTED.test(message)) throw new Error(PERMISSION_HELP)
    if (GONE.test(message)) throw new Error('this Meet guest window is gone')
    if (NO_PROCESS.test(message)) throw new Error('the Call Bots browser is not running')
    throw error
  } finally {
    doneSpeaking()
  }
}

// ---------------------------------------------------------------------------
// The bundle.

// A copy of Chrome with its own bundle identifier, so Apple Events can address
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
// A stale record — a staging copy, an old build — is the wrong thing in the
// Automation prompt and in Launch Services' idea of what the bundle is.
const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
const registerBundle = async () => {
  await run(LSREGISTER, ['-u', `${BUNDLE_PATH}.building`], { timeout: 60_000 }).catch(() => {})
  await run(LSREGISTER, ['-f', BUNDLE_PATH], { timeout: 60_000 }).catch(() => {})
}

// ---------------------------------------------------------------------------
// Windows.

// Guest windows are small and tiled, not left where Chrome drops them, one on
// top of another at full size. Meet sizes what it asks the server for by the
// tiles it draws, so a small window receives small video — the difference
// between three guests and five on the same machine — and the desktop stays
// legible with several of them open.
const WINDOW_W = 640
const WINDOW_H = 440
const COLUMNS = 3
let slots = 0
const placeWindow = async (proc, windowId, slot) => {
  const col = slot % COLUMNS
  const row = Math.floor(slot / COLUMNS) % 3
  const x = col * WINDOW_W
  const y = 40 + row * (WINDOW_H + 10)
  await speak(proc, ['bounds', windowId, String(x), String(y), String(WINDOW_W), String(WINDOW_H)]).catch(() => {})
}

// Stream stats for a guest come from chrome://webrtc-internals, kept open in a
// second, minimised window of its process. It sees every peer connection in
// the process — including the ones Meet hides in module closures, which
// nothing injected into the page can reach — and, unlike a page, Chrome's
// scripting interface is allowed to read it. It polls getStats itself, once a
// second, and renders the results into tables whose ids spell out what they
// hold: <rid>-<lid>-table-<statId>-<field>.
const INTERNALS = 'chrome://webrtc-internals/'

// The dashboard's card thumbnail, drawn in the page. The bot's own tile first —
// it is the one carrying Meet's own-video controls (Reframe, Backgrounds,
// effects), which no remote tile has — and only then the biggest playing
// video, because in a grid of three the biggest can be somebody else's dark
// camera.
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

// One read of the whole page: which connection belongs to which page URL, and
// the handful of fields the dashboard shows. Everything else on the page is
// SDP and candidate grids the reader never touches.
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

// ---------------------------------------------------------------------------
// Processes.

// Every guest's process, so a run that dies can still take them down.
const processes = new Set()

const startProcess = async (media, options) => {
  clearStaleProfiles()
  const [bundle] = await Promise.all([ensureGuestBundle(), ensureHelper()])
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
      // microphone grant seeded above — leaving Meet stuck offering to join
      // without them.
      '--lang=en-US',
      '--no-first-run',
      '--no-default-browser-check',
      // Or macOS asks for the login password so this re-signed copy can read
      // the real Chrome's "Chrome Safe Storage". A throwaway profile has no
      // use for it.
      '--use-mock-keychain',
      '--password-store=basic',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      // This process's own clip and voice: the flags are process-wide, and
      // the process is this guest's alone.
      ...(media && !options.noVideo ? [`--use-file-for-fake-video-capture=${media.video}`] : []),
      ...(media && !options.noAudio ? [`--use-file-for-fake-audio-capture=${media.audio}`] : []),
      `${RUN_MARKER}=${options.runId}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )
  const proc = { child, userDataDir }
  processes.add(proc)
  if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] spawned pid', child.pid)

  // The first answer takes as long as a person needs: the very first Apple
  // Event to the bots' browser is what raises macOS's Automation prompt, and
  // it blocks until that is answered. A pid cannot be launched, so asking too
  // early only errors and is asked again.
  const deadline = Date.now() + READY_TIMEOUT
  while (Date.now() < deadline && alive(proc)) {
    const count = await speak(proc, ['count'], { timeout: 120_000 }).catch((error) => {
      if (error.message === PERMISSION_HELP) throw error
      return null
    })
    if (Number(count) >= 1) return proc
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  await stop(proc)
  throw new Error('the Call Bots browser did not come up for this Meet guest')
}

// A polite quit, then the process's actual exit — so the orchestrator's sweep
// never finds a browser still on its way out and reports it as a leftover —
// and a kill for one that lingers: a throwaway profile has nothing to save.
const stop = async (proc) => {
  processes.delete(proc)
  if (processes.size === 0) slots = 0
  if (alive(proc)) {
    await speak(proc, ['quit'], { timeout: 5_000 }).catch(() => {})
    const gone = Date.now() + EXIT_WAIT
    while (Date.now() < gone && alive(proc)) {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  if (alive(proc)) kill(proc, 'SIGTERM')
  const dead = Date.now() + 2000
  while (Date.now() < dead && alive(proc)) {
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  if (alive(proc)) {
    kill(proc, 'SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  // Chrome keeps unlinking its own files for several seconds after the kill,
  // and a removal that lands inside that window loses — measured as one
  // profile left behind per run at 2.5 s of retries. Keep trying for a while,
  // and let the next start clear whatever a crashed run left.
  const sweep = (attempt = 0) => {
    try {
      rmSync(proc.userDataDir, { recursive: true, force: true })
    } catch {
      if (attempt < 20) setTimeout(() => sweep(attempt + 1), 1000).unref?.()
    }
  }
  sweep()
}

const kill = (proc, signal) => {
  try {
    process.kill(-proc.child.pid, signal)
  } catch {
    try {
      proc.child.kill(signal)
    } catch {
      // Already gone.
    }
  }
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
  const held = new Set([...processes].map((proc) => proc.userDataDir))
  for (const name of names) {
    const path = join(dir, name)
    if (held.has(path)) continue
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      // Still held by something; the next start tries again.
    }
  }
}

// The browsers are detached so a group kill can target each precisely, which
// also means nothing kills them for us. A run that dies without tearing down
// would otherwise leave its windows on screen for good.
let exitHooked = false
const killOnExit = () => {
  if (exitHooked) return
  exitHooked = true
  const bail = () => {
    for (const proc of processes) {
      kill(proc, 'SIGTERM')
      try {
        rmSync(proc.userDataDir, { recursive: true, force: true })
      } catch {
        // The next start clears it.
      }
    }
    processes.clear()
  }
  process.once('exit', bail)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      bail()
      process.exit(signal === 'SIGINT' ? 130 : 143)
    })
  }
}

// ---------------------------------------------------------------------------
// The window.

// How long one read of webrtc-internals serves every asker. The dashboard's
// state request and the health tick both want a summary; two reads a few
// milliseconds apart would make the later one a rate over no time at all.
const FRESH_MS = 1500
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
  constructor(proc, windowId, tag) {
    this.proc = proc
    this.windowId = windowId
    // Rides in the URL fragment, which Meet ignores and webrtc-internals
    // prints, so this window's connections can be told from any other's.
    this.tag = tag
    this.closed = false
    this.statsWindow = null
    this.statsPromise = null
    // Cumulative bytes per stream over the last RATE_WINDOW_MS of reads,
    // shared by both readers: every read is another sample for the other.
    this.samples = new Map()
    this.cache = { summary: null, summaryAt: 0, snapshot: null, snapshotAt: 0 }
    this.inFlight = { summary: null, snapshot: null }
  }

  static async open(media, options, { tag = 'guest' } = {}) {
    if (process.platform !== 'darwin') {
      throw new Error('Meet guests need macOS — on this machine, send Meet bots as Google accounts')
    }
    killOnExit()
    const proc = await startProcess(media, options)
    let windowId
    try {
      windowId = (await speak(proc, ['window-id', '1'])).trim()
      if (!/^\d+$/u.test(windowId)) throw new Error('the Call Bots browser opened no window')
    } catch (error) {
      await stop(proc)
      throw error
    }
    if (process.env.CALL_BOTS_DEBUG_MEET) {
      console.error('[guest-browser] pid', proc.child.pid, 'window', windowId, 'for', tag)
    }
    await placeWindow(proc, windowId, slots++)
    return new GuestWindow(proc, windowId, tag)
  }

  #tagged(url) {
    return url.includes('#') ? url : `${url}#cb-${this.tag}`
  }

  #speak(args, options) {
    return speak(this.proc, args, options)
  }

  #exec(windowId, source) {
    return this.#speak(['exec', windowId], { input: source })
  }

  // The second window of this guest's process, on webrtc-internals. Memoised
  // while in flight; a failure is not, so the next read tries again rather
  // than costing the guest its stats for the whole call.
  async #ensureStatsWindow() {
    if (this.closed) return null
    if (this.statsWindow) return this.statsWindow
    const mine = (this.statsPromise ??= (async () => {
      const id = (await this.#speak(['new-window'])).trim()
      if (!/^\d+$/u.test(id)) throw new Error('the Call Bots browser did not open a window')
      await this.#speak(['set-url', id, INTERNALS])
      // Nobody needs to see it; it keeps polling while minimised.
      await this.#speak(['minimize', id]).catch(() => {})
      if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] stats window', id, 'for', this.tag)
      return id
    })().catch((error) => {
      if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] stats window failed:', error.message)
      if (this.statsPromise === mine) this.statsPromise = null
      return null
    }))
    this.statsWindow = await mine
    return this.statsWindow
  }

  async #readInternals() {
    const windowId = await this.#ensureStatsWindow()
    if (!windowId) return null
    let out = ''
    try {
      out = await this.#exec(windowId, INTERNALS_READ)
    } catch (error) {
      // Closed by hand, say: forgotten, so the next read opens another rather
      // than asking a gone window forever.
      if (/window is gone/u.test(error.message)) {
        this.statsWindow = null
        this.statsPromise = null
      }
      return null
    }
    try {
      return JSON.parse(out)
    } catch {
      return null
    }
  }

  // The same shape the stream monitor's summary takes, so the card needs no
  // second code path; and the expanded stream panel in the shape the
  // monitor's snapshot takes, so the dashboard needs no second renderer.
  // Everything here is what webrtc-internals already prints; this only
  // arranges it.
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

  #mine(page) {
    const marker = `#cb-${this.tag}`
    return new Set(
      Object.entries(page.heads)
        .filter(([, url]) => url.includes(marker))
        .map(([pc]) => pc),
    )
  }

  async #readSnapshot() {
    if (this.closed) return null
    const page = await this.#readInternals()
    if (!page) return null
    const mine = this.#mine(page)
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
    let page = await this.#readInternals()
    if (!page) return null
    // A rate is the difference between two reads, so a first read on its own
    // reports every stream at zero — and a dashboard opened the moment a bot
    // lands would show it sending nothing. Take the baseline, wait a beat and
    // read again; once per window.
    if (this.samples.size === 0) {
      if (this.#tally(page) === null) return null
      await new Promise((resolve) => setTimeout(resolve, FIRST_SAMPLE_MS))
      page = (await this.#readInternals()) ?? page
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
    const mine = this.#mine(page)
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

  async url() {
    if (this.closed) return 'about:blank'
    return this.#speak(['url', this.windowId]).catch(() => 'about:blank')
  }

  async goto(target) {
    const url = this.#tagged(target)
    const wanted = url.split('#')[0]
    const host = new URL(wanted).host
    // Setting the address on a window Chrome has only just made can lose to
    // the new tab page still committing underneath it — the tab stays on
    // chrome://newtab and the bot polls a page that will never be Meet. So the
    // address is checked, and set again until it holds; and the tab reports
    // the new address while the old document is still the one answering, so
    // what is asked is where the document itself says it is.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await this.#speak(['set-url', this.windowId, url])
      const settled = Date.now() + 2500
      while (Date.now() < settled) {
        await this.waitForTimeout(250)
        const current = await this.url().catch(() => '')
        if (current.startsWith(wanted)) {
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

  // `source` is a single expression; anything structured is stringified in the
  // page and parsed here. Chrome hands back the value as text, and nothing at
  // all for undefined.
  async evaluate(source) {
    if (this.closed) throw new Error('this Meet guest window is closed')
    const out = await this.#exec(this.windowId, source)
    if (out === '' || out === 'missing value' || out === 'undefined' || out === 'null') return null
    try {
      return JSON.parse(out)
    } catch {
      return out
    }
  }

  waitForTimeout(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  // The dashboard's card thumbnail. First choice: draw the bot's own tile — in
  // a call, its camera as Meet renders it — to a canvas and hand back a JPEG.
  // No permission, no window geometry, and it shows exactly what the bot
  // publishes. Fallback: photograph the window's rectangle on screen, which
  // needs Screen Recording and shows whatever sits on top of it.
  async screenshot() {
    if (this.closed) return null
    const grabbed = await this.evaluate(GRAB_VIDEO).catch(() => null)
    if (typeof grabbed === 'string' && grabbed.startsWith('data:image/jpeg;base64,')) {
      return Buffer.from(grabbed.slice('data:image/jpeg;base64,'.length), 'base64')
    }
    return this.#photograph()
  }

  async #photograph() {
    const raw = await this.#speak(['get-bounds', this.windowId]).catch(() => '')
    const [left, top, width, height] = raw.split(' ').map((value) => Number(value))
    if (![left, top, width, height].every(Number.isFinite)) return null
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

  // The whole process goes with the window: it was this guest's alone.
  async close() {
    if (this.closed) return
    this.closed = true
    await stop(this.proc)
  }
}
