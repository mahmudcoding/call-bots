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

const GOOGLE_CHROME_PATHS = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'],
  win32: CHROME_PATHS.win32,
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'],
}

export const systemChromePath = () =>
  (CHROME_PATHS[process.platform] ?? []).find((path) => path && existsSync(path)) ?? null

// Google sign-in is supported by Google Chrome, not the open-source Chromium
// bundle. Meet profiles are created in normal Chrome and must be reopened by
// that same browser family later.
export const googleChromePath = () =>
  (GOOGLE_CHROME_PATHS[process.platform] ?? []).find((path) => path && existsSync(path)) ?? null

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

// Playwright's defaults that a signed-in Google profile cannot live with.
//
// --enable-automation hangs Chrome's "controlled by automated test software"
// banner on the window and turns on a set of automation defaults a signed-in
// Google session has no use for. Playwright still reports navigator.webdriver
// either way, and Meet does not currently mind — this only drops the parts we
// can drop.
//
// The keychain pair is a macOS-only fix. Setup uses normal Chrome and therefore
// the normal macOS keychain, and Playwright's mock-keychain default would make
// that same profile's encrypted Google cookies unreadable when reopened. On
// Linux the opposite is true: --password-store=basic is what lets Chrome read
// its own cookies on a headless box with no unlocked keyring, and taking it
// away would silently sign every profile out.
const meetLaunchIgnores = () =>
  process.platform === 'darwin'
    ? ['--enable-automation', '--use-mock-keychain', '--password-store=basic']
    : ['--enable-automation']

// One browser PROCESS per guest: the fake-capture-file flags are process-wide,
// so distinct media needs distinct processes. Aloqa contexts are always fresh
// and anonymous; Meet deliberately reopens the one isolated signed-in profile
// reserved for that bot.
export const launchGuest = async (guest, media, options, codecs = null, meetProfile = null) => {
  const args = buildArgs(guest, media, options)
  const headless = !options.headed
  const contextOptions = {
    baseURL: options.baseUrl,
    // A shared screen is captured at the context's viewport — not at the size
    // of the page being shared, and not at --window-size. So this is what
    // decides whether a bot shares in full HD or in 540p upscaled to look like
    // it. Everything else about a bot is unaffected by the larger surface: its
    // camera comes from a file, not from rendering.
    viewport: { width: 1920, height: 1080 },
    ...(meetProfile ? { locale: 'en-US' } : {}),
  }

  let browser = null
  let context = null
  try {
    if (meetProfile) {
      const executablePath = googleChromePath()
      if (!executablePath) {
        throw new Error('Google Chrome is required for saved Google Meet accounts')
      }
      args.push('--lang=en-US', '--disable-session-crashed-bubble')
      context = await chromium.launchPersistentContext(meetProfile.userDataDir, {
        executablePath,
        headless,
        args,
        ignoreDefaultArgs: meetLaunchIgnores(),
        ...contextOptions,
      })
      browser = context.browser()
    } else {
      const primary = resolveChannel(options.browser)
      try {
        browser = await chromium.launch({ channel: primary, headless, args })
      } catch (error) {
        const fallback = primary === 'chrome' ? 'chromium' : 'chrome'
        const available = fallback === 'chrome' ? systemChromePath() : bundledChromiumPath()
        if ((options.browser && options.browser !== 'auto') || !available) throw error
        log.warn(`browser launch failed (${error.message.split('\n')[0]}); retrying`)
        browser = await chromium.launch({ channel: fallback, headless, args })
      }
      context = await browser.newContext(contextOptions)
    }

    await context.grantPermissions(['camera', 'microphone'], { origin: options.baseUrl })
    // Codec preferences and the synthetic screen need document-start hooks:
    // both have to exist before the call platform's bundle builds its first
    // peer connection. Persistent contexts take init scripts the same way
    // fresh ones do, so Meet gets them too.
    //
    // The codec shim goes in even where codec CONTROL is switched off, because
    // its connection registry is also how the stream monitor finds a page's
    // peer connections. Without it Meet reports "no connection" on a live call
    // and the camera watchdog has nothing to watch.
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
    const page = meetProfile
      ? context.pages()[0] ?? (await context.newPage())
      : await context.newPage()
    return {
      browser,
      context,
      page,
      close: () => (meetProfile ? context.close() : browser.close()),
    }
  } catch (error) {
    if (context) await context.close().catch(() => {})
    if (browser) await browser.close().catch(() => {})
    if (meetProfile) {
      // Chrome refuses to open a profile a second Chrome already has. The raw
      // form of this is a screenful of Playwright's launch command line, and
      // the one thing the user has to do is not in it.
      if (/ProcessSingleton|SingletonLock/iu.test(error.message)) {
        throw new Error(
          `${meetProfile.displayName} is already open in a Chrome window — ` +
            'close that window, then send the bots again',
        )
      }
      // Otherwise: Playwright launch errors include the full Chrome command
      // line. Replace the private user-data path before the error reaches a
      // bot log or the API.
      const safe = String(error.message).split(meetProfile.userDataDir).join('[private Meet profile]')
      throw new Error(safe)
    }
    throw error
  }
}

// Does Google still accept this saved profile? The files on disk only say a
// sign-in happened once; a session that Google has since expired looks
// identical there and is otherwise discovered as a failed bot halfway through
// a batch. Deliberately conservative: only a clear signed-out signal demotes a
// profile, because wrongly demoting a good account costs a manual re-sign-in.
export const probeMeetSession = async (userDataDir, { timeout = 45_000 } = {}) => {
  const executablePath = googleChromePath()
  if (!executablePath) throw new Error('Google Chrome is required to check Google Meet accounts')

  let context = null
  const run = async () => {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: true,
      args: ['--lang=en-US', '--disable-session-crashed-bubble', '--mute-audio'],
      ignoreDefaultArgs: meetLaunchIgnores(),
      locale: 'en-US',
      viewport: { width: 1280, height: 800 },
    })
    const page = context.pages()[0] ?? (await context.newPage())
    await page.goto('https://meet.google.com/?hl=en&authuser=0', {
      waitUntil: 'domcontentloaded',
      timeout: 30_000,
    })
    await page.waitForTimeout(2_500)
    if (new URL(page.url()).hostname === 'accounts.google.com') return false
    return page.evaluate(() => {
      if (document.querySelector('[aria-label*="Google Account" i]')) return true
      const text = document.body?.innerText ?? ''
      if (/New meeting|Start a meeting|Join a meeting/iu.test(text)) return true
      if (/Sign in to|Sign in\b/iu.test(text)) return false
      return true
    })
  }

  try {
    return await Promise.race([
      run(),
      new Promise((resolve) => setTimeout(() => resolve(true), timeout)),
    ])
  } catch {
    // A launch that failed says nothing about the Google session.
    return true
  } finally {
    if (context) await context.close().catch(() => {})
  }
}

export const createRunDir = (runId) => {
  const dir = join(runsDir, runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const writeManifest = (runDir, manifest) => {
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
