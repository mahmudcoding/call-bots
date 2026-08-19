#!/usr/bin/env node
import { parseArgs } from 'node:util'

import { RUN_MARKER } from './browser.mjs'
import { ensureDirs } from './config.mjs'
import { ensureGuestFixtures } from './fixtures.mjs'
import { plain as log } from './log.mjs'
import { Roster } from './orchestrator.mjs'
import { findMarkedPids, killPids } from './procs.mjs'
import { resolveLink } from './platforms/index.mjs'

const USAGE = `Call Bots — put any number of guests into an Aloqa call

usage:
  call-bots ui [--port 4610]        open the app window (recommended)
  call-bots join <invite-link>      send guests in from the terminal
  call-bots fixtures [--regen]      (re)generate the camera video and audio
  call-bots doctor                  check browser, speech, machine limits
  call-bots clean                   kill leftover guest browser processes

options:
  --guests <n>       how many guests to send (default 2)
  --headed           show the guest browser windows (default: headless)
  --browser <name>   chrome, chromium, or auto (default)
  --camera <on|off>  arrive with the camera on or off (default on)
  --mic <on|off>     arrive with the microphone on or off (default on)
  --no-video         attach no camera video at all (cheaper for a load run)
  --no-audio         attach no microphone audio at all
  --size <WxH>       camera video size (default 1920x1080, even dimensions)
  --fps <n>          camera video frame rate (default 12)
  --regen            rebuild the media even if it is cached

Guests need no accounts: the call's invite link is the only input.`

const parseCli = () => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      guests: { type: 'string' },
      headed: { type: 'boolean', default: false },
      browser: { type: 'string', default: 'auto' },
      camera: { type: 'string', default: 'on' },
      mic: { type: 'string', default: 'on' },
      'no-video': { type: 'boolean', default: false },
      'no-audio': { type: 'boolean', default: false },
      size: { type: 'string', default: '1920x1080' },
      fps: { type: 'string', default: '12' },
      regen: { type: 'boolean', default: false },
      port: { type: 'string', default: '4610' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  return { command: positionals[0], positionals: positionals.slice(1), values }
}

const buildOptions = (values, baseUrl) => ({
  baseUrl,
  headed: values.headed,
  browser: values.browser,
  noVideo: values['no-video'],
  noAudio: values['no-audio'],
  // The state a bot arrives in; its clip and voice stay attached either way.
  startCam: values.camera !== 'off',
  startMic: values.mic !== 'off',
  size: values.size,
  fps: Number(values.fps) || 12,
  regen: values.regen,
})

const main = async () => {
  const { command, positionals, values } = parseCli()
  if (values.help || !command || command === 'help') {
    console.log(USAGE)
    return
  }
  ensureDirs()

  if (command === 'ui') {
    const { startServer } = await import('./server.mjs')
    await startServer({ port: Number(values.port) || 4610, open: !values['no-open'] })
    return new Promise(() => {}) // runs until SIGINT
  }

  if (command === 'clean') {
    const pids = await findMarkedPids(RUN_MARKER)
    if (pids.length === 0) {
      log.info('no leftover guest browsers')
      return
    }
    log.info(`killed ${killPids(pids)} leftover process(es)`)
    return
  }

  if (command === 'doctor') {
    const { runDoctor } = await import('./doctor.mjs')
    process.exitCode = (await runDoctor()) ? 0 : 1
    return
  }

  if (command === 'fixtures') {
    const sample = Array.from({ length: 2 }, (_, i) => ({
      n: i + 1,
      index: i,
      label: `Guest ${i + 1}`,
      slug: `guest-${i + 1}`,
    }))
    await ensureGuestFixtures(sample, buildOptions(values, null))
    log.info('fixtures ready')
    return
  }

  if (command === 'join') {
    const link = positionals[0]
    if (!link) throw new Error('usage: call-bots join <invite-link>')
    const target = resolveLink(link)
    const count = Number(values.guests) || 2
    const roster = new Roster(buildOptions(values, target.origin))

    let interrupted = 0
    const onSigint = () => {
      interrupted += 1
      if (interrupted > 1) process.exit(130)
      console.error('\nCtrl-C — closing guests (again to force-quit)')
      roster.teardownAll().then(() => process.exit(130))
    }
    process.on('SIGINT', onSigint)

    log.info(`sending ${count} guest(s) into the call`)
    const result = await roster.add(count, target)
    if (roster.inCall().length === 0) {
      log.error('no guest reached the call')
      await roster.teardownAll()
      process.exitCode = 1
      return
    }
    log.info(`${result.added} guest(s) in call — Ctrl-C to end`)
    await new Promise(() => {}) // hold until interrupted
    return
  }

  throw new Error(`unknown command "${command}" — run call-bots help`)
}

main().catch((error) => {
  console.error(`\n${error.message}`)
  process.exitCode = 1
})
