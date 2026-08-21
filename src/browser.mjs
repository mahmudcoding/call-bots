import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { chromium } from 'playwright'

import { runsDir } from './config.mjs'
import { plain as log } from './log.mjs'

// The codec-preference shim rides an init script into every page of a guest's
// context: negotiation hooks have to exist before the call platform's bundle
// creates its peer connections, which rules out the page.evaluate route the
// stream monitor takes. Exported so the RTC test harness can inject the exact
// same file the app does.
export const CODEC_SHIM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'codec-shim.js')

// Strips the audio ask out of getDisplayMedia before Chromium sees it: a tab
// share needs no OS capture API, but a system-audio ask makes macOS pop its
// Screen Recording permission dialog for nothing.
export const CAPTURE_SHIM_PATH = join(dirname(fileURLToPath(import.meta.url)), 'capture-shim.js')

// System Chrome locations per platform. Playwright's channel:'chrome' finds
// these itself — we detect only to choose between Chrome and the bundled
// Chromium without trial-and-error on every launch.
const CHROME_PATHS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: [
    `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'}\\Google\\Chrome\\Application\\chrome.exe`,
    `${process.env.LOCALAPPDATA ?? ''}\\Google\\Chrome\\Application\\chrome.exe`,
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/opt/google/chrome/chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
}

export const systemChromePath = () =>
  (CHROME_PATHS[process.platform] ?? []).find((path) => path && existsSync(path)) ?? null

export const bundledChromiumPath = () => {
  try {
    const path = chromium.executablePath()
    return path && existsSync(path) ? path : null
  } catch {
    return null
  }
}

// Prefer Playwright's own Chromium over the system Chrome. Launching an app
// out of /Applications makes macOS attribute that app's self-updates to us,
// which raises a "prevented from modifying apps" prompt; Chromium lives in a
// cache directory and never triggers it.
// channel:'chromium' picks the FULL browser in new-headless mode. Plain
// headless would use chrome-headless-shell, which ignores the fake-device
// capture flags and joins with no camera or microphone at all.
const resolveChannel = (preference) => {
  if (preference === 'chrome') return 'chrome'
  if (preference === 'chromium') return 'chromium'
  if (bundledChromiumPath()) return 'chromium'
  if (systemChromePath()) return 'chrome'
  throw new Error('no browser yet — Chromium is still downloading, try again in a moment')
}

// Used by the clip renderer, which needs the same browser choice.
export const launchChannel = () => resolveChannel('auto')

// The marker arg lets `clean` find leftover processes after a hard kill.
export const RUN_MARKER = '--call-bots-run'

// A bot has no desktop to share, so it shares a page of its own instead. Chrome
// will not show a source picker to an automated browser — it either hangs
// forever or needs to be told what to pick — so the pick is made by tab title.
export const SCREEN_TITLE = 'Call Bots shared screen'

const buildArgs = (guest, media, options) => {
  // No --use-fake-ui-for-media-stream: permissions come from grantPermissions,
  // and that flag overrides the fake capture files.
  const args = [
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // publish audio without playing every bot through the speakers
    '--mute-audio',
    `${RUN_MARKER}=${options.runId}`,
  ]
  // Tab sources only. The equivalent desktop flag makes Chrome enumerate
  // screens and windows looking for the title, and on macOS enumerating screens
  // needs the Screen Recording permission — so the user gets asked to hand the
  // app their whole screen for a share that only ever captures one of its own
  // tabs. This picks the same tab without going near the OS capture API.
  args.push(`--auto-select-tab-capture-source-by-title=${SCREEN_TITLE}`)
  if (media && !options.noVideo) args.push(`--use-file-for-fake-video-capture=${media.video}`)
  if (media && !options.noAudio) args.push(`--use-file-for-fake-audio-capture=${media.audio}`)
  return args
}

// One browser PROCESS per guest: the fake-capture-file flags are process-wide,
// so distinct media needs distinct processes. Contexts are always fresh — a
// guest must never carry a signed-in cookie, or the invite page auto-joins as
// that account instead of asking for a name.
export const launchGuest = async (guest, media, options, codecs = null) => {
  const args = buildArgs(guest, media, options)
  const headless = !options.headed
  const primary = resolveChannel(options.browser)
  let browser
  try {
    browser = await chromium.launch({ channel: primary, headless, args })
  } catch (error) {
    const fallback = primary === 'chrome' ? 'chromium' : 'chrome'
    const available = fallback === 'chrome' ? systemChromePath() : bundledChromiumPath()
    if ((options.browser && options.browser !== 'auto') || !available) throw error
    log.warn(`browser launch failed (${error.message.split('\n')[0]}); retrying`)
    browser = await chromium.launch({ channel: fallback, headless, args })
  }
  const context = await browser.newContext({
    baseURL: options.baseUrl,
    // A shared screen is captured at the context's viewport — not at the size
    // of the page being shared, and not at --window-size. So this is what
    // decides whether a bot shares in full HD or in 540p upscaled to look like
    // it. Everything else about a bot is unaffected by the larger surface: its
    // camera comes from a file, not from rendering.
    viewport: { width: 1920, height: 1080 },
  })
  await context.grantPermissions(['camera', 'microphone'], { origin: options.baseUrl })
  // Two scripts, run in the order they were added: the per-guest seed, then
  // the shim that reads it. Always installed — with no preference set the shim
  // is inert, and a bot launched with defaults can still be switched later.
  await context.addInitScript((prefs) => {
    window.__botCodecInit__ = prefs
  }, codecs ?? {})
  await context.addInitScript({ path: CODEC_SHIM_PATH })
  await context.addInitScript(
    (seed) => {
      window.__botCaptureInit__ = seed
    },
    {
      label: guest.label,
      videoUrl: `${options.baseUrl}/__call-bots-screen?asset=video`,
    },
  )
  await context.addInitScript({ path: CAPTURE_SHIM_PATH })
  // A fixed budget fails a whole large batch at once: while fifty browsers are
  // starting, none of them loads a page in twenty seconds, and every bot dies
  // of a timeout that says nothing about the real problem.
  context.setDefaultTimeout(Math.min(120_000, 20_000 + (options.batchSize ?? 1) * 2_000))
  const page = await context.newPage()
  return { browser, context, page }
}

export const createRunDir = (runId) => {
  const dir = join(runsDir, runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const writeManifest = (runDir, manifest) => {
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
