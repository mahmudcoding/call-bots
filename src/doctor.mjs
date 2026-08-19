import { bundledChromiumPath, systemChromePath } from './browser.mjs'
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

  const tts = await detectTtsEngine()
  checks.push(
    tts === 'tones'
      ? warn('speech', 'no system text-to-speech — guests will publish tones instead of speech')
      : ok('speech', `system text-to-speech via ${tts}`),
  )

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
  console.log(healthy ? '\nready — run: npm start' : '\nfix the ✗ items above, then re-run doctor')
  return healthy
}
