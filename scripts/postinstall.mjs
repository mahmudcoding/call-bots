// Runs after `npm install`. Keeps installs zero-download when a system Chrome
// exists; otherwise fetches Playwright's Chromium so the tool works anywhere.
// Never fails the install — worst case it prints what to do.
import { spawnSync } from 'node:child_process'

if (process.env.CALLS_SIM_SKIP_BROWSER_INSTALL) process.exit(0)

try {
  const { systemChromePath, bundledChromiumPath } = await import('../src/browser.mjs')
  if (systemChromePath()) {
    console.log('[calls-sim] using system Google Chrome — no browser download needed')
    process.exit(0)
  }
  if (bundledChromiumPath()) {
    console.log('[calls-sim] bundled Chromium already installed')
    process.exit(0)
  }
  console.log('[calls-sim] no Chrome found — downloading Chromium via Playwright (one-time)…')
  const result = spawnSync('npx', ['playwright', 'install', 'chromium'], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  if (result.status !== 0) {
    console.warn('[calls-sim] browser download failed — install Google Chrome or run: npx playwright install chromium')
  }
} catch (error) {
  console.warn(`[calls-sim] postinstall check skipped: ${error.message}`)
}
process.exit(0)
