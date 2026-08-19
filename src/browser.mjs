import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { chromium } from 'playwright'

import { runsDir, stateDir } from './config.mjs'
import { plain as log } from './log.mjs'

// System Chrome locations per platform (playwright's channel:'chrome' finds
// these itself — we only detect to choose between Chrome and the bundled
// Chromium without trial-and-error on every launch).
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

// 'auto' (default): system Chrome when present, else bundled Chromium.
let resolvedChannel
const resolveChannel = (preference) => {
  if (preference === 'chrome') return 'chrome'
  if (preference === 'chromium') return undefined
  if (resolvedChannel !== null && resolvedChannel !== undefined) return resolvedChannel === 'chromium' ? undefined : resolvedChannel
  if (systemChromePath()) {
    resolvedChannel = 'chrome'
    return 'chrome'
  }
  if (bundledChromiumPath()) {
    resolvedChannel = 'chromium'
    return undefined
  }
  throw new Error(
    'no browser found: install Google Chrome, or run `npm run setup` to download Chromium',
  )
}

export const shareTabTitle = (user) => `SIM-SHARE-${user.slug}`

export const statePath = (email) =>
  join(stateDir, `${email.replace(/[^A-Za-z0-9.@_-]/gu, '_')}.json`)

// The marker arg lets `calls-sim clean` find leftover processes after a hard
// kill. Chrome ignores switches it does not recognize.
export const RUN_MARKER = '--calls-sim-run'

const buildArgs = (user, media, options) => {
  // No --use-fake-ui-for-media-stream: camera/mic prompts are covered by
  // context.grantPermissions, and the fake-UI flag hijacks getDisplayMedia to
  // the blank virtual monitor instead of honoring the tab-by-title selector.
  const args = [
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // Sim users must not play call audio through the Mac's speakers — with N
    // instances that becomes a feedback-free but deafening chorus. Output only;
    // fake-device capture is unaffected.
    '--mute-audio',
    `--auto-select-tab-capture-source-by-title=${shareTabTitle(user)}`,
    `${RUN_MARKER}=${options.runId}`,
  ]
  if (media && !options.noVideo) {
    args.push(`--use-file-for-fake-video-capture=${media.video}`)
  }
  if (media && !options.noAudio) {
    args.push(`--use-file-for-fake-audio-capture=${media.audio}`)
  }
  return args
}

// One browser PROCESS per user: the fake-capture-file flags are process-wide,
// so distinct per-user media requires distinct processes. Contexts are
// ephemeral; only the storageState JSON persists between runs (no user-data
// dirs, no SingletonLock cleanup class).
export const launchUser = async (user, media, options) => {
  const args = buildArgs(user, media, options)
  const headless = !options.headed
  let browser
  const primary = resolveChannel(options.browser)
  try {
    browser = await chromium.launch({ channel: primary, headless, args })
  } catch (error) {
    // auto mode gets one cross-engine retry (e.g. a broken Chrome install)
    const fallback = primary === 'chrome' ? undefined : 'chrome'
    const fallbackAvailable = fallback === 'chrome' ? systemChromePath() : bundledChromiumPath()
    if ((options.browser && options.browser !== 'auto') || !fallbackAvailable) throw error
    log.warn(
      `browser launch failed (${error.message.split('\n')[0]}); ` +
        `retrying with ${fallback ?? 'bundled Chromium'}`,
    )
    browser = await chromium.launch({ channel: fallback, headless, args })
  }
  const state = statePath(user.email)
  const context = await browser.newContext({
    baseURL: options.baseUrl,
    viewport: { width: 960, height: 540 },
    storageState: existsSync(state) ? state : undefined,
  })
  await context.grantPermissions(['camera', 'microphone'], { origin: options.baseUrl })
  context.setDefaultTimeout(20_000)
  const page = await context.newPage()
  return { browser, context, page }
}

export const saveState = async (context, email) => {
  mkdirSync(stateDir, { recursive: true })
  await context.storageState({ path: statePath(email) })
}

export const createRunDir = (runId) => {
  const dir = join(runsDir, runId)
  mkdirSync(dir, { recursive: true })
  return dir
}

export const writeManifest = (runDir, manifest) => {
  writeFileSync(join(runDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
}
