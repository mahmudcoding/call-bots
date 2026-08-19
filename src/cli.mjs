#!/usr/bin/env node
import { parseArgs } from 'node:util'

import { ensureDirs, loadConfig } from './config.mjs'
import { ensureFixtures } from './fixtures.mjs'
import { plain as log } from './log.mjs'
import { Roster } from './orchestrator.mjs'
import { findMarkedPids, killPids } from './procs.mjs'
import { startRepl } from './repl.mjs'
import { RUN_MARKER } from './browser.mjs'
import { parseCallUrl } from './selectors.mjs'

const USAGE = `aloqa-calls-sim — simulate N real users in an Aloqa staging call

usage:
  calls-sim ui [--port 4610]            open the web dashboard (recommended)
  calls-sim join <call-url> [options]   join an existing call (paste its URL)
  calls-sim create [options]            first sim user creates an Open call,
                                        prints its URL, the rest join it
  calls-sim fixtures [--regen]          (re)generate per-user media fixtures
  calls-sim doctor                      check browser, TTS, config, staging
  calls-sim clean                       kill leftover sim browser processes

options:
  --config <path>       config file (default ./users.yaml)
  --users <n>           use the first n users from the config
  --only <a,b>          use only these labels (comma-separated)
  --ws <id>             workspace id for create (default: config "workspace")
  --headed              show browser windows (default: headless)
  --browser <name>      chrome (default, system Chrome) or chromium (bundled)
  --no-video            join with camera off
  --no-audio            join with microphone off
  --size <WxH>          fixture video size (default 640x360, even dims)
  --fps <n>             fixture video fps (default 12)
  --regen               regenerate fixtures even if cached

The call must be joinable without admission (entry mode "Open") and accounts
must be members of its workspace with 2FA off. ~4-6 users is the realistic
ceiling on a 16 GB Mac.`

const parseCli = () => {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      users: { type: 'string' },
      only: { type: 'string' },
      ws: { type: 'string' },
      headed: { type: 'boolean', default: false },
      browser: { type: 'string', default: 'chrome' },
      'no-video': { type: 'boolean', default: false },
      'no-audio': { type: 'boolean', default: false },
      size: { type: 'string', default: '640x360' },
      fps: { type: 'string', default: '12' },
      regen: { type: 'boolean', default: false },
      port: { type: 'string', default: '4610' },
      'no-open': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  })
  return { command: positionals[0], positionals: positionals.slice(1), values }
}

const selectUsers = (config, values) => {
  let users = config.users
  if (values.only) {
    const wanted = values.only.split(',').map((label) => label.trim().toLowerCase())
    users = users.filter(
      (user) =>
        wanted.includes(user.label.toLowerCase()) || wanted.includes(user.slug),
    )
    if (users.length !== wanted.length) {
      const have = new Set(users.map((u) => u.label.toLowerCase()))
      const missing = wanted.filter((w) => !have.has(w))
      if (missing.length > 0) throw new Error(`--only: unknown label(s): ${missing.join(', ')}`)
    }
  }
  if (values.users) {
    const n = Number(values.users)
    if (!Number.isInteger(n) || n < 1) throw new Error('--users must be a positive integer')
    users = users.slice(0, n)
  }
  if (users.length === 0) throw new Error('no users selected')
  // fixture audio offsets depend on position within THIS run's roster
  return users.map((user, index) => ({ ...user, index }))
}

const buildOptions = (values) => ({
  headed: values.headed,
  browser: values.browser === 'chromium' ? 'chromium' : 'chrome',
  noVideo: values['no-video'],
  noAudio: values['no-audio'],
  size: values.size,
  fps: Number(values.fps) || 12,
  regen: values.regen,
})

const withRoster = async (roster, runFlow) => {
  let interrupted = 0
  const onSigint = () => {
    interrupted += 1
    if (interrupted > 1) {
      console.error('\nforced exit')
      process.exit(130)
    }
    console.error('\nCtrl-C — leaving call and closing browsers (again to force-quit)')
    roster.teardownAll().then(() => process.exit(130))
  }
  process.on('SIGINT', onSigint)
  try {
    let ok
    try {
      ok = await runFlow()
    } catch (error) {
      log.error(error.message)
      await roster.teardownAll()
      process.exitCode = 1
      return
    }
    if (roster.inCall().length === 0) {
      log.error('no simulated user reached the call — nothing to hold open')
      await roster.teardownAll()
      process.exitCode = 1
      return
    }
    if (!ok) log.warn('some users failed to join — roster is partial (see errors above)')
    console.log(`\n${await roster.statusTable()}`)
    await startRepl(roster)
    await roster.teardownAll()
  } finally {
    process.off('SIGINT', onSigint)
  }
}

const main = async () => {
  const { command, positionals, values } = parseCli()
  if (values.help || !command || command === 'help') {
    console.log(USAGE)
    return
  }
  ensureDirs()

  if (command === 'ui') {
    const { startServer } = await import('./server.mjs')
    await startServer({
      port: Number(values.port) || 4610,
      configPath: values.config ?? null,
      open: !values['no-open'],
    })
    return new Promise(() => {}) // server runs until SIGINT
  }

  if (command === 'clean') {
    const pids = await findMarkedPids(RUN_MARKER)
    if (pids.length === 0) {
      log.info('no leftover sim browser processes')
      return
    }
    log.info(`killed ${killPids(pids)} leftover process(es)`)
    return
  }

  if (command === 'doctor') {
    const { runDoctor } = await import('./doctor.mjs')
    process.exitCode = (await runDoctor(values.config ?? null)) ? 0 : 1
    return
  }

  const config = loadConfig(values.config)
  const users = selectUsers(config, values)
  const options = buildOptions(values)

  if (command === 'fixtures') {
    await ensureFixtures(users, options)
    log.info('fixtures ready')
    return
  }

  if (command === 'join') {
    const target = positionals[0]
    if (!target) throw new Error('usage: calls-sim join <call-url>')
    const { wsId, callId } = parseCallUrl(target, config.baseUrl)
    log.info(`joining call ${callId} in workspace ${wsId} with ${users.length} user(s)`)
    const roster = new Roster(config, options)
    await withRoster(roster, () => roster.joinExisting(users, wsId, callId))
    return
  }

  if (command === 'create') {
    const wsId = values.ws ?? config.workspace
    if (!wsId) throw new Error('create needs --ws <workspaceId> or "workspace" in users.yaml')
    log.info(`creating an Open call in workspace ${wsId} with ${users.length} user(s)`)
    const roster = new Roster(config, options)
    await withRoster(roster, () => roster.createAndJoin(users, wsId))
    return
  }

  throw new Error(`unknown command "${command}" — run calls-sim help`)
}

main().catch((error) => {
  console.error(`\n${error.message}`)
  process.exitCode = 1
})
