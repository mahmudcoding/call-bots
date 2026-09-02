import { existsSync } from 'node:fs'
import { join } from 'node:path'

import { bundledChromiumPath, googleChromePath, systemChromePath } from './browser.mjs'
import { bundledMediaDir } from './config.mjs'
import { machineProfile } from './machine.mjs'
import { detectTtsEngine } from './tts.mjs'

const ok = (label, detail) => ({ ok: true, label, detail })
const bad = (label, detail) => ({ ok: false, label, detail })
const warn = (label, detail) => ({ ok: 'warn', label, detail })

export const collectChecks = async () => {
  const checks = []

  const [major] = process.versions.node.split('.').map(Number)
  checks.push(
    major >= 20
      ? ok('node', `v${process.versions.node}`)
      : bad('node', `v${process.versions.node} — need Node 20 or newer`),
  )

  const chrome = systemChromePath()
  const chromium = bundledChromiumPath()
  if (chrome) checks.push(ok('browser', `system Chrome (${chrome})`))
  else if (chromium) checks.push(ok('browser', 'bundled Chromium (Playwright)'))
  else checks.push(bad('browser', 'none found — install Google Chrome or run: npx playwright install chromium'))

  // Voices ship with the app, so a machine with no text-to-speech is fine —
  // it only matters for a bot beyond the shipped set on a machine that has no
  // imported voice either.
  const shipped = existsSync(join(bundledMediaDir, 'voice-1.wav'))
  const tts = await detectTtsEngine()
  if (shipped) {
    checks.push(ok('speech', 'bundled voices'))
  } else {
    checks.push(
      tts === 'tones'
        ? warn('speech', 'no voices bundled and no system text-to-speech — bots will publish tones')
        : ok('speech', `system text-to-speech via ${tts}`),
    )
  }

  // Google Meet: guests run in a copy of the real Chrome, driven through Apple
  // Events — so a Mac with Chrome installed is what it takes.
  const googleChrome = googleChromePath()
  if (process.platform === 'darwin') {
    checks.push(
      googleChrome
        ? ok('meet', 'Google Chrome found — Meet guests available')
        : warn('meet', 'Google Chrome not found — Meet guests need it installed'),
    )
  } else {
    checks.push(warn('meet', 'Meet guests need macOS — Meet is unavailable on this machine'))
  }

  const machine = machineProfile()
  checks.push(
    ok('machine', `${machine.memGB} GB RAM, ${machine.cores} cores — about ${machine.recommendedMax} guests at once`),
  )

  return checks
}

export const runDoctor = async () => {
  const checks = await collectChecks()
  const mark = { true: '✓', false: '✗', warn: '!' }
  for (const check of checks) {
    console.log(` ${mark[String(check.ok)]} ${check.label.padEnd(8)} ${check.detail}`)
  }
  const healthy = checks.every((check) => check.ok !== false)
  console.log(healthy ? '\nready' : '\nfix the ✗ items above, then run this again')
  return healthy
}
