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
  check('help names both platforms and says Meet needs nothing set up',
    help.status === 0 && /Aloqa or Google Meet/u.test(help.stdout) &&
      /with nothing to set up/u.test(help.stdout) && !/--as /u.test(help.stdout),
    help.stdout.split('\n').slice(-5).join(' ').trim())

  // Meet bots are guests, so a join needs nothing configured and fails on the
  // link rather than on an identity it was never going to need.
  const guest = run(['join', 'https://meet.google.com/abc-defg-hij', '--bots', '1'])
  check('a Meet join asks for no account',
    !/account/iu.test(guest.stderr), guest.stderr.trim().slice(0, 120))

  // A guest names itself, so the label the account path could not honour works.
  const label = run([
    'join', 'https://meet.google.com/abc-defg-hij', '--bots', '1', '--label', 'QA',
  ])
  check('--label is accepted for Meet',
    !/--label is unavailable/u.test(label.stderr), label.stderr.trim().slice(0, 120))

  // Refused from what the platform declares, not from a list of platform names
  // in the CLI: live Meet ignores codec preferences, so its adapter says so and
  // this follows. Presenting is NOT refused any more — a guest can share.
  const mediaOptions = run([
    'join', 'https://meet.google.com/abc-defg-hij',
    '--audio-codec', 'opus', '--video-codec', 'vp9', '--screen-codec', 'vp8',
  ])
  check('codec flags report unavailable for Meet',
    mediaOptions.status === 1 && ['--audio-codec', '--video-codec', '--screen-codec']
      .every((flag) => mediaOptions.stderr.includes(flag)), mediaOptions.stderr.trim())
  check('and --share is not among them',
    !/--share/u.test(mediaOptions.stderr), mediaOptions.stderr.trim())
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const failed = results.filter((result) => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
