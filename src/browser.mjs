import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright'

import { runsDir } from './config.mjs'
import { plain as log } from './log.mjs'

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

let resolved
const resolveChannel = (preference) => {
  if (preference === 'chrome') return 'chrome'
  if (preference === 'chromium') return undefined
  if (resolved) return resolved === 'chromium' ? undefined : resolved
  if (systemChromePath()) {
    resolved = 'chrome'
    return 'chrome'
  }
  if (bundledChromiumPath()) {
    resolved = 'chromium'
    return undefined
  }
  throw new Error('no browser found: install Google Chrome, or run `npm run setup`')
}

export const shareTabTitle = (guest) => `SIM-SHARE-${guest.slug}`

// The marker arg lets `clean` find leftover processes after a hard kill.
export const RUN_MARKER = '--call-bots-run'

const buildArgs = (guest, media, options) => {
  // No --use-fake-ui-for-media-stream: permissions come from grantPermissions,
  // and that flag hijacks getDisplayMedia away from the tab-by-title selector.
  const args = [
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // publish audio without playing every bot through the speakers
    '--mute-audio',
    `--auto-select-tab-capture-source-by-title=${shareTabTitle(guest)}`,
    `${RUN_MARKER}=${options.runId}`,
  ]
  if (media && !options.noVideo) args.push(`--use-file-for-fake-video-capture=${media.video}`)
  if (media && !options.noAudio) args.push(`--use-file-for-fake-audio-capture=${media.audio}`)
  return args
}

// One browser PROCESS per guest: the fake-capture-file flags are process-wide,
// so distinct media needs distinct processes. Contexts are always fresh — a
// guest must never carry a signed-in cookie, or the invite page auto-joins as
// that account instead of asking for a name.
export const launchGuest = async (guest, media, options) => {
  const args = buildArgs(guest, media, options)
  const headless = !options.headed
  const primary = resolveChannel(options.browser)
  let browser
  try {
    browser = await chromium.launch({ channel: primary, headless, args })
  } catch (error) {
    const fallback = primary === 'chrome' ? undefined : 'chrome'
    const available = fallback === 'chrome' ? systemChromePath() : bundledChromiumPath()
    if ((options.browser && options.browser !== 'auto') || !available) throw error
    log.warn(`browser launch failed (${error.message.split('\n')[0]}); retrying`)
    browser = await chromium.launch({ channel: fallback, headless, args })
  }
  const context = await browser.newContext({
    baseURL: options.baseUrl,
    viewport: { width: 960, height: 540 },
  })
  await context.grantPermissions(['camera', 'microphone'], { origin: options.baseUrl })
  context.setDefaultTimeout(20_000)
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
