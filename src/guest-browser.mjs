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

const osascript = async (script, timeout = 25_000) => {
  const { stdout } = await run('osascript', ['-e', script], { timeout, maxBuffer: 16 * 1024 * 1024 })
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

const speak = async (body) => {
  if (!(await browserRunning())) throw new Error('the Call Bots browser is not running')
  let out
  try {
    out = await osascript(tell(body))
  } catch (error) {
    if (NOT_PERMITTED.test(String(error.message))) throw new Error(PERMISSION_HELP)
    throw error
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
const onWindow = (windowId, body) =>
  [
    'set _w to missing value',
    'repeat with _c in windows',
    `  if ((id of _c) as text) is ${quote(String(windowId))} then set _w to _c`,
    'end repeat',
    'if _w is missing value then error "this Meet guest window is gone"',
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

const newWindowId = async () => {
  const before = new Set(await windowIds())
  await speak('make new window')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const fresh = (await windowIds()).find((id) => !before.has(id))
    if (fresh) return fresh
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  throw new Error('the Call Bots browser did not open a window')
}

const ensureStatsWindow = async () => {
  if (!shared) return null
  // Memoised while in flight: two guests opening at once must not each build
  // a stats window of their own.
  shared.statsWindowPromise ??= createWindow(async () => {
    const windowId = await newWindowId()
    await speak(onWindow(windowId, `set URL of _t to ${quote(INTERNALS)}`))
    // Nobody needs to see it; it keeps polling while minimised.
    await speak(onWindow(windowId, 'set minimized of _w to true')).catch(() => {})
    if (process.env.CALL_BOTS_DEBUG_MEET) console.error('[guest-browser] stats window', windowId)
    return windowId
  }).catch(() => null)
  shared.statsWindow = await shared.statsWindowPromise
  return shared.statsWindow
}

// One read of the whole page: which connection belongs to which page URL, and
// the handful of fields the dashboard shows. Everything else on the page is
// SDP and candidate grids the reader never touches.
// Single line, like everything sent through AppleScript. Picks the biggest
// video that is actually playing, which in the call is the bot's own tile.
const GRAB_VIDEO = [
  '(function(){',
  'var best=null,area=0;',
  '[].slice.call(document.querySelectorAll("video")).forEach(function(v){',
  '  if(v.readyState<2||v.videoWidth===0||v.paused)return;',
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
  const out = await speak(onWindow(windowId, `return execute _t javascript ${quote(INTERNALS_READ)}`)).catch(
    () => '',
  )
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
      if (ids.length > 0) return { child, userDataDir, windows: new Set(), spare: ids[0] }
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  stop(child, userDataDir)
  throw new Error('the Call Bots browser did not come up for the Meet guests')
}

const stop = (child, userDataDir) => {
  try {
    process.kill(-child.pid)
  } catch {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
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

export class GuestWindow {
  constructor(windowId, tag) {
    this.windowId = windowId
    // Rides in the URL fragment, which Meet ignores and webrtc-internals
    // prints, so this window's connections can be told from the others'.
    this.tag = tag
    this.closed = false
    // Cumulative bytes per stream from each reader's previous read; a rate is
    // the difference over the real gap since that reader last looked.
    this.lastStats = new Map()
    this.lastSnap = new Map()
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
  async rtcSnapshot() {
    if (this.closed) return null
    const page = await readInternals()
    if (!page) return null
    const marker = `#cb-${this.tag}`
    const mine = new Set(
      Object.entries(page.heads).filter(([, url]) => url.includes(marker)).map(([pc]) => pc),
    )
    if (mine.size === 0) return null
    const now = Date.now()
    const seen = new Map()
    // Its own window between reads: the summary polls every two seconds too,
    // and a rate taken milliseconds after one of those is zero by construction.
    const rate = (key, bytes) => {
      const was = this.lastSnap.get(key)
      seen.set(key, { bytes, at: now })
      return was && now > was.at ? ((bytes - was.bytes) * 8) / (now - was.at) : 0
    }
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
    this.lastSnap = seen
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

  async rtcSummary() {
    if (this.closed) return null
    const page = await readInternals()
    if (!page) return null
    const marker = `#cb-${this.tag}`
    const mine = new Set(
      Object.entries(page.heads)
        .filter(([, url]) => url.includes(marker))
        .map(([pc]) => pc),
    )
    if (mine.size === 0) return null

    const now = Date.now()
    const seen = new Map()
    const rate = (key, bytes) => {
      const was = this.lastStats.get(key)
      seen.set(key, { bytes, at: now })
      return was && now > was.at ? ((bytes - was.bytes) * 8) / (now - was.at) : 0
    }
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
    this.lastStats = seen
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
    await speak(this.#on(`set URL of _t to ${quote(this.#tagged(target))}`))
    // `set URL` returns as soon as the navigation is asked for.
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState').catch(() => null)
      if (state === 'interactive' || state === 'complete') return
      await this.waitForTimeout(250)
    }
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
      stop(child, userDataDir)
    }
  }
}
