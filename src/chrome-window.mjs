// Real Google Chrome incognito windows, driven the way a person drives them.
//
// Google refuses anonymous Meet joins from a browser with a debugger attached.
// Same window, same meeting, same minute: readable through AppleScript, refused
// through CDP. So a Meet guest gets no Playwright and no --remote-debugging-port
// — it is a window Chrome opened normally, scripted through Chrome's own
// `execute javascript`, which Meet cannot tell from the page's own code.
//
// Two constraints shape everything here, both measured:
//
//   * Apple Events reach only ONE Chrome process. Launching a second Chrome
//     with its own --user-data-dir makes the first one invisible to scripting,
//     so every guest has to live in one process, as its own incognito window.
//   * That one process therefore carries one set of fake-capture flags, so all
//     guests in a run share a camera clip and a voice. Aloqa bots and Meet
//     account bots still get one apiece; only guests are alike.

import { execFile, spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

import { RUN_MARKER } from './browser.mjs'

const run = promisify(execFile)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const READY_TIMEOUT = 45_000

// AppleScript string literals: backslashes first, then quotes.
const quote = (value) => `"${String(value).replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`

const osascript = async (script, timeout = 25_000) => {
  const { stdout } = await run('osascript', ['-e', script], { timeout, maxBuffer: 16 * 1024 * 1024 })
  return stdout.trimEnd()
}

const chromeTell = (body) => `tell application "Google Chrome"\n${body}\nend tell`

const windowIds = async () => {
  const out = await osascript(chromeTell('return id of every window')).catch(() => '')
  return out.split(',').map((value) => value.trim()).filter(Boolean)
}

// The one Chrome the guests share. Created on first use, torn down when the
// last window closes.
let shared = null

const startShared = async (media, options) => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'call-bots-meet-guests-'))
  const child = spawn(
    CHROME,
    [
      `--user-data-dir=${userDataDir}`,
      '--incognito',
      '--lang=en-US',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream',
      ...(media && !options.noVideo ? [`--use-file-for-fake-video-capture=${media.video}`] : []),
      ...(media && !options.noAudio ? [`--use-file-for-fake-audio-capture=${media.audio}`] : []),
      `${RUN_MARKER}=${options.runId}`,
      'about:blank',
    ],
    { stdio: 'ignore', detached: true },
  )

  const deadline = Date.now() + READY_TIMEOUT
  while (Date.now() < deadline) {
    const ids = await windowIds()
    // Apple Events land on the newest Chrome, which is the one just started.
    if (ids.length > 0) {
      return { child, userDataDir, windows: new Set(), seed: ids[ids.length - 1] }
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  try {
    process.kill(-child.pid)
  } catch {
    child.kill()
  }
  rmSync(userDataDir, { recursive: true, force: true })
  throw new Error('Google Chrome did not come up for the Meet guests')
}

const stopShared = () => {
  if (!shared || shared.windows.size > 0) return
  const { child, userDataDir } = shared
  shared = null
  try {
    process.kill(-child.pid)
  } catch {
    try {
      child.kill()
    } catch {
      // Already gone.
    }
  }
  try {
    rmSync(userDataDir, { recursive: true, force: true })
  } catch {
    // A directory Chrome is still unlinking is not a teardown failure.
  }
}

export class ChromeWindow {
  constructor(windowId) {
    this.windowId = windowId
    this.closed = false
  }

  static async open(media, options) {
    if (!shared) shared = await startShared(media, options)

    // The first guest takes the window Chrome already opened; the rest get one
    // each, so every guest is its own Meet participant.
    let windowId = shared.seed
    shared.seed = null
    if (!windowId) {
      const before = new Set(await windowIds())
      await osascript(chromeTell('make new window with properties {mode:"incognito"}'))
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline && !windowId) {
        windowId = (await windowIds()).find((id) => !before.has(id)) ?? null
        if (!windowId) await new Promise((resolve) => setTimeout(resolve, 200))
      }
      if (!windowId) throw new Error('Google Chrome did not open a window for this Meet guest')
    }
    shared.windows.add(windowId)
    return new ChromeWindow(windowId)
  }

  #tab() {
    return `active tab of (first window whose id is ${this.windowId})`
  }

  async url() {
    if (this.closed) return 'about:blank'
    return osascript(chromeTell(`return URL of ${this.#tab()}`)).catch(() => 'about:blank')
  }

  async goto(target) {
    await osascript(chromeTell(`set URL of ${this.#tab()} to ${quote(target)}`))
    // `set URL` returns as soon as the navigation is asked for, so settle on the
    // document rather than on the call coming back.
    const deadline = Date.now() + 45_000
    while (Date.now() < deadline) {
      const state = await this.evaluate('document.readyState').catch(() => null)
      if (state === 'interactive' || state === 'complete') return
      await this.waitForTimeout(250)
    }
  }

  // `source` is a JavaScript expression. Chrome hands back a bare string, so
  // anything structured is stringified in-page and parsed here.
  async evaluate(source) {
    if (this.closed) throw new Error('the Meet guest window is closed')
    const out = await osascript(
      chromeTell(`return execute ${this.#tab()} javascript ${quote(source)}`),
    )
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

  isClosed() {
    return this.closed
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await osascript(chromeTell(`close (first window whose id is ${this.windowId})`)).catch(() => {
      // A window somebody already closed is not a teardown failure.
    })
    shared?.windows.delete(this.windowId)
    stopShared()
  }
}
