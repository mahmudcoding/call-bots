import { existsSync } from 'node:fs'

import { bundledChromiumPath, systemChromePath } from './browser.mjs'
import { loadConfig, resolveConfigPath } from './config.mjs'
import { detectTtsEngine } from './tts.mjs'

const ok = (label, detail) => ({ ok: true, label, detail })
const bad = (label, detail) => ({ ok: false, label, detail })
const warn = (label, detail) => ({ ok: 'warn', label, detail })

export const collectChecks = async (configPath) => {
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
      ? warn('speech', 'no system text-to-speech — simulated users will publish tone melodies instead of speech')
      : ok('speech', `system text-to-speech via ${tts}`),
  )

  let config = null
  const configFile = resolveConfigPath(configPath)
  if (!existsSync(configFile)) {
    checks.push(bad('config', `${configFile} missing — copy users.example.yaml to users.yaml and fill in accounts`))
  } else {
    try {
      config = loadConfig(configPath)
      checks.push(ok('config', `${config.users.length} user(s), workspace ${config.workspace ?? '(unset)'}`))
    } catch (error) {
      checks.push(bad('config', error.message))
    }
  }

  if (config) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 7000)
      const response = await fetch(`${config.baseUrl}/login`, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
      })
      clearTimeout(timer)
      checks.push(
        response.status < 500
          ? ok('staging', `${config.baseUrl} reachable (HTTP ${response.status})`)
          : warn('staging', `${config.baseUrl} answered HTTP ${response.status}`),
      )
    } catch (error) {
      checks.push(bad('staging', `${config.baseUrl} unreachable — ${error.message}`))
    }
  }

  return checks
}

export const runDoctor = async (configPath) => {
  const checks = await collectChecks(configPath)
  const mark = { true: '✓', false: '✗', warn: '!' }
  for (const check of checks) {
    console.log(` ${mark[String(check.ok)]} ${check.label.padEnd(8)} ${check.detail}`)
  }
  const healthy = checks.every((check) => check.ok !== false)
  console.log(healthy ? '\nready to run: npm start' : '\nfix the ✗ items above, then re-run: node src/cli.mjs doctor')
  return healthy
}
