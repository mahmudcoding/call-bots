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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { RUN_MARKER, googleChromePath } from './browser.mjs'
import { baseDir } from './config.mjs'

const run = promisify(execFile)

export const BUNDLE_ID = 'com.aloqa.call-bots.browser'
const BUNDLE_PATH = join(baseDir, 'Call Bots Browser.app')
const SOURCE_APP = '/Applications/Google Chrome.app'
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
const browserRunning = async () => {
  const out = await osascript(
    `tell application "System Events" to return (exists (first application process whose bundle identifier is ${quote(BUNDLE_ID)}))`,
    10_000,
  ).catch(() => 'false')
  return out.trim() === 'true'
}

const speak = async (body) => {
  if (!(await browserRunning())) throw new Error('the Call Bots browser is not running')
  return osascript(tell(body))
}

// A copy of Chrome with its own bundle identifier, so AppleScript can address
// the bots' browser without ever reaching the user's. Built once and kept.
export const ensureGuestBundle = async () => {
  if (existsSync(join(BUNDLE_PATH, 'Contents/MacOS/Google Chrome'))) return BUNDLE_PATH
  if (!googleChromePath()) {
    throw new Error('Google Chrome is required for Meet guests — Meet turns away anything else')
  }
  const staging = `${BUNDLE_PATH}.building`
  rmSync(staging, { recursive: true, force: true })
  await run('ditto', [SOURCE_APP, staging], { timeout: 300_000 })
  const plist = join(staging, 'Contents/Info.plist')
  await run('/usr/libexec/PlistBuddy', ['-c', `Set :CFBundleIdentifier ${BUNDLE_ID}`, plist])
  await run('/usr/libexec/PlistBuddy', ['-c', 'Set :CFBundleName CallBotsBrowser', plist])
  // Without this codesign refuses: "resource fork, Finder information, or
  // similar detritus not allowed".
  await run('xattr', ['-cr', staging], { timeout: 120_000 })
  await run('codesign', ['--force', '--sign', '-', staging], { timeout: 300_000 })
  rmSync(BUNDLE_PATH, { recursive: true, force: true })
  await run('mv', [staging, BUNDLE_PATH])
  return BUNDLE_PATH
}

const windowIds = async () => {
  const out = await speak('return id of every window').catch(() => '')
  return out.split(',').map((value) => value.trim()).filter(Boolean)
}

let shared = null

const startShared = async (media, options) => {
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
  const deadline = Date.now() + READY_TIMEOUT
  while (Date.now() < deadline) {
    if (await browserRunning()) {
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
  // Chrome is still unlinking its own files for a moment after the kill, so the
  // first removal usually loses the race and leaves the profile behind.
  const sweep = (attempt = 0) => {
    try {
      rmSync(userDataDir, { recursive: true, force: true })
    } catch {
      if (attempt < 5) setTimeout(() => sweep(attempt + 1), 500).unref?.()
    }
  }
  sweep()
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
  constructor(windowId) {
    this.windowId = windowId
    this.closed = false
  }

  static async open(media, options) {
    if (!shared) {
      killOnExit()
      starting ??= startShared(media, options).finally(() => {
        starting = null
      })
      shared = await starting
    }

    // The first guest takes the window the browser opened with; the rest get
    // one each, so every guest is its own Meet participant.
    let windowId = shared.spare
    shared.spare = null
    if (!windowId) {
      const before = new Set(await windowIds())
      // A normal window, deliberately. The profile is a throwaway that is
      // already signed out, and an incognito window would not inherit the
      // camera and microphone grant seeded into it — leaving Meet with nothing
      // to offer but "Continue without microphone and camera".
      await speak('make new window')
      const deadline = Date.now() + 20_000
      while (Date.now() < deadline && !windowId) {
        windowId = (await windowIds()).find((id) => !before.has(id)) ?? null
        if (!windowId) await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (!windowId) throw new Error('the Call Bots browser did not open a window for this guest')
    }
    shared.windows.add(windowId)
    return new GuestWindow(windowId)
  }

  // Window ids run past 2^30, and AppleScript turns a literal that big into a
  // real — "whose id is 1439954207" goes looking for 1.439954207E+9 and fails
  // with "Invalid index". Comparing as text sidesteps the conversion entirely.
  #on(body) {
    return [
      'set _w to missing value',
      'repeat with _c in windows',
      `  if ((id of _c) as text) is ${quote(this.windowId)} then set _w to _c`,
      'end repeat',
      'if _w is missing value then error "this Meet guest window is gone"',
      'set _t to active tab of _w',
      body,
    ].join('\n')
  }

  async url() {
    if (this.closed) return 'about:blank'
    return speak(this.#on('return URL of _t')).catch(() => 'about:blank')
  }

  // `inject` is a one-line expression to run as early as the new document will
  // take it. Meet grabs RTCPeerConnection into a module closure while its bundle
  // parses, so anything that arrives after the page has settled is too late to
  // see a single connection — the only chance is to get in during the load.
  async goto(target, { inject = null } = {}) {
    await speak(this.#on(`set URL of _t to ${quote(target)}`))
    // `set URL` returns as soon as the navigation is asked for.
    const deadline = Date.now() + 45_000
    let injected = false
    while (Date.now() < deadline) {
      if (inject && !injected) {
        const out = await this.evaluate(inject).catch(() => null)
        if (out) injected = true
      }
      const state = await this.evaluate('document.readyState').catch(() => null)
      if (state === 'complete' || (state === 'interactive' && (!inject || injected))) return
      await this.waitForTimeout(inject && !injected ? 30 : 250)
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

  // The dashboard's card thumbnail. There is no page object to screenshot here,
  // but the window is a real one on a real screen — so ask AppleScript where it
  // is and photograph that rectangle. Whatever sits on top of it lands in the
  // picture; the alternative is no picture at all.
  async screenshot() {
    if (this.closed) return null
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
