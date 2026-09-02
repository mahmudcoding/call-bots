// The terminal shares the same Meet profile pool as the app. These checks use
// an empty scratch home so they fail before opening a browser or joining a call.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = join(projectRoot, 'src', 'cli.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'call-bots-cli-'))
const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const run = (args) => spawnSync(process.execPath, [cli, ...args], {
  cwd: projectRoot,
  env: { ...process.env, CALL_BOTS_HOME: scratch },
  encoding: 'utf8',
  timeout: 10_000,
})

try {
  console.log('\nCLI Meet support')
  const help = run(['help'])
  check('help names both supported platforms and account requirement',
    help.status === 0 && /Aloqa or Google Meet/u.test(help.stdout) &&
      /one ready account required per concurrent bot/u.test(help.stdout))

  const missing = run(['join', 'https://meet.google.com/abc-defg-hij', '--bots', '1'])
  check('a Meet join with no configured profile is actionable',
    missing.status === 1 && /Add or reconnect accounts in Call Bots/u.test(missing.stderr),
    missing.stderr.trim())

  const label = run([
    'join', 'https://meet.google.com/abc-defg-hij', '--bots', '1', '--label', 'QA',
  ])
  check('--label reports that it is unavailable for Meet',
    label.status === 1 && /--label is unavailable for Google Meet/u.test(label.stderr),
    label.stderr.trim())

  // These are refused from what the platform declares, not from a list of
  // platform names in the CLI — live Meet ignores codec preferences and refuses
  // to present, so its adapter says so and this follows.
  const mediaOptions = run([
    'join', 'https://meet.google.com/abc-defg-hij', '--share', '1',
    '--audio-codec', 'opus', '--video-codec', 'vp9', '--screen-codec', 'vp8',
  ])
  check('screen-share and codec flags all report unavailable for Meet',
    mediaOptions.status === 1 && ['--share', '--audio-codec', '--video-codec', '--screen-codec']
      .every((flag) => mediaOptions.stderr.includes(flag)), mediaOptions.stderr.trim())
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
