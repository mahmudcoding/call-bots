import { execFile, spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledChromiumPath, systemChromePath } from './browser.mjs'
import { loadConfig, projectRoot, resolveConfigPath, updateConfigWorkspace } from './config.mjs'
import { userColorHex } from './fixtures.mjs'
import { onLog, plain as log } from './log.mjs'
import { machineProfile } from './machine.mjs'
import { Roster } from './orchestrator.mjs'
import { classifyTarget } from './selectors.mjs'
import {
  discoverJoinedWorkspace,
  extractInviteToken,
  joinUsersToWorkspace,
} from './workspace.mjs'

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ui.html')

const THUMB_TTL_MS = 1500
const SNAPSHOT_MS = 2000
const VERIFY_EVERY = 3 // every Nth snapshot includes the deep check

// One dashboard controls one session at a time.
const session = {
  status: 'idle', // idle | launching | running | stopping
  roster: null,
  verify: null,
  startedAt: null,
  lastRunError: null,
}

// Workspace-join job state (independent of call sessions).
const joinJob = {
  running: false,
  done: 0,
  total: 0,
  summary: null, // {joined, already, failed, workspace}
  error: null,
}

const sseClients = new Set()
const thumbCache = new Map() // slug -> {at, buffer, inFlight}

const broadcast = (message) => {
  const payload = `data: ${JSON.stringify(message)}\n\n`
  for (const client of sseClients) client.write(payload)
}

onLog((entry) => broadcast({ type: 'log', entry }))

const configSnapshot = (configPath) => {
  const file = resolveConfigPath(configPath)
  try {
    const config = loadConfig(configPath)
    return {
      ok: true,
      file,
      baseUrl: config.baseUrl,
      workspace: config.workspace,
      workspaceName: config.workspaceName,
      users: config.users.map((user) => ({
        slug: user.slug,
        label: user.label,
        email: user.email,
        color: userColorHex(user.index),
      })),
    }
  } catch (error) {
    return { ok: false, file, error: error.message }
  }
}

// First run in a fresh home (e.g. the .app bundle): give the user a config
// file to edit instead of an error about a missing one.
const scaffoldConfig = (configPath) => {
  const file = resolveConfigPath(configPath)
  if (existsSync(file)) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    copyFileSync(join(projectRoot, 'users.example.yaml'), file)
    log.info(`created ${file} — fill in real staging accounts`)
  } catch (error) {
    log.warn(`could not scaffold config: ${error.message}`)
  }
}

// The .app has no npm; download Chromium through playwright's CLI with our own
// runtime when the machine has no usable browser. Non-blocking — progress
// streams into the dashboard activity log.
let browserInstall = null
const ensureBrowser = () => {
  if (systemChromePath() || bundledChromiumPath() || browserInstall) return
  let cliPath
  try {
    cliPath = createRequire(import.meta.url).resolve('playwright/cli.js')
  } catch {
    log.warn('no browser found and playwright CLI unavailable — install Google Chrome')
    return
  }
  log.warn('no browser found — downloading Chromium (one-time, ~150 MB)…')
  browserInstall = spawn(process.execPath, [cliPath, 'install', 'chromium'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const relay = (stream) =>
    stream.on('data', (chunk) => {
      const text = String(chunk).trim()
      if (text) log.info(`[chromium download] ${text.split('\n').pop()}`)
    })
  relay(browserInstall.stdout)
  relay(browserInstall.stderr)
  browserInstall.on('exit', (code) => {
    log[code === 0 ? 'info' : 'warn'](
      code === 0
        ? 'Chromium ready'
        : 'Chromium download failed — install Google Chrome and relaunch',
    )
    browserInstall = null
  })
}

const stateSnapshot = async (configPath, { withVerify = false } = {}) => {
  const roster = session.roster
  let rosterState = null
  if (roster) {
    rosterState = await roster.statusData().catch(() => null)
    if (withVerify && session.status === 'running') {
      session.verify = await roster.verifyData().catch(() => session.verify)
    }
  }
  return {
    type: 'state',
    state: {
      status: session.status,
      startedAt: session.startedAt,
      lastRunError: session.lastRunError,
      config: configSnapshot(configPath),
      machine: machineProfile(),
      session: rosterState,
      verify: session.verify,
      join: { ...joinJob },
    },
  }
}

// Logs every fleet user into the product and accepts the invite. HTTP only —
// no browsers — so 100 users cost seconds, not gigabytes.
const runJoinWorkspace = async (configPath, body) => {
  if (joinJob.running) throw new Error('a workspace join is already running')
  const config = loadConfig(configPath)
  const token = extractInviteToken(body.invite)
  const selected =
    Array.isArray(body.users) && body.users.length > 0
      ? config.users.filter((user) => body.users.includes(user.slug))
      : config.users
  if (selected.length === 0) throw new Error('no users selected')

  const apiBase = `${config.baseUrl}/stg/api/v1`
  joinJob.running = true
  joinJob.done = 0
  joinJob.total = selected.length
  joinJob.summary = null
  joinJob.error = null
  log.info(`joining ${selected.length} user(s) to a workspace (token …${token.slice(-6)})`)

  ;(async () => {
    try {
      const results = await joinUsersToWorkspace({
        apiBase,
        users: selected,
        token,
        onProgress: (done, total, outcome) => {
          joinJob.done = done
          if (!outcome.ok) log.warn(`  ${outcome.label}: ${outcome.state} (${outcome.detail})`)
          if (done === 1 || done % 10 === 0 || done === total) {
            log.info(`  joined ${done}/${total}…`)
          }
        },
      })
      const joined = results.filter((r) => r.state === 'joined').length
      const already = results.filter((r) => r.state === 'already_member').length
      const failed = results.filter((r) => !r.ok)
      log.info(
        `workspace join finished: ${joined} joined, ${already} already members, ${failed.length} failed`,
      )

      let workspace = null
      const anySession = results.find((r) => r.ok && r.session)?.session
      if (anySession) {
        workspace = await discoverJoinedWorkspace(anySession).catch(() => null)
        if (workspace) {
          const file = updateConfigWorkspace(configPath, workspace.id, workspace.name)
          log.info(
            `workspace set to ${workspace.name || workspace.id} (${workspace.id})` +
              (file ? ` in ${file}` : ''),
          )
        } else {
          log.warn('joined, but could not read the workspace id — set it manually if needed')
        }
      }
      joinJob.summary = { joined, already, failed: failed.length, workspace }
    } catch (error) {
      joinJob.error = error.message
      log.error(`workspace join failed: ${error.message}`)
    } finally {
      joinJob.running = false
      broadcast(await stateSnapshot(configPath))
    }
  })()
}

const readBody = (request) =>
  new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 1_000_000) reject(new Error('body too large'))
      else chunks.push(chunk)
    })
    request.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    request.on('error', reject)
  })

const json = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const launchSession = async (configPath, body) => {
  if (session.status !== 'idle') throw new Error(`a session is already ${session.status}`)
  const config = loadConfig(configPath)
  const selected = (body.users ?? []).map((slug) => {
    const user = config.users.find((entry) => entry.slug === slug)
    if (!user) throw new Error(`unknown user "${slug}"`)
    return user
  })
  if (selected.length === 0) throw new Error('select at least one user')
  const users = selected.map((user, index) => ({ ...user, index }))

  const options = {
    headed: Boolean(body.headed),
    browser: body.browser === 'chromium' ? 'chromium' : 'chrome',
    noVideo: Boolean(body.noVideo),
    noAudio: Boolean(body.noAudio),
    size: '1920x1080',
    fps: 12,
    regen: false,
  }

  const target = classifyTarget(body.link ?? body.callUrl ?? '', config.baseUrl)
  const guestCount = Math.max(0, Math.min(50, Number(body.guests) || 0))

  const roster = new Roster(config, options)
  session.roster = roster
  session.status = 'launching'
  session.startedAt = Date.now()
  session.lastRunError = null
  session.verify = null
  thumbCache.clear()

  // run in the background; SSE snapshots keep the dashboard current
  ;(async () => {
    try {
      await roster.joinByLink(users, target)
      session.status = 'running'
      if (guestCount > 0) {
        // guests are additive: a guest failure must not tear down a live roster
        try {
          const result = await roster.addGuests(guestCount)
          log.info(`guests in call: ${result.added}${result.failed ? `, failed ${result.failed}` : ''}`)
        } catch (error) {
          log.error(`guests: ${error.message}`)
        }
      }
    } catch (error) {
      log.error(`launch failed: ${error.message}`)
      session.lastRunError = error.message
      await roster.teardownAll().catch(() => {})
      session.status = 'idle'
      session.roster = null
    }
    broadcast(await stateSnapshot(configPath, { withVerify: true }))
  })()
}

const stopSession = async (configPath) => {
  if (!session.roster || session.status === 'stopping') return
  session.status = 'stopping'
  broadcast(await stateSnapshot(configPath))
  await session.roster.teardownAll().catch((error) => log.warn(error.message))
  session.roster = null
  session.verify = null
  session.status = 'idle'
  broadcast(await stateSnapshot(configPath))
}

const runAction = async (slug, action) => {
  const roster = session.roster
  if (!roster || session.status !== 'running') throw new Error('no running session')
  const targets = slug === 'all' ? roster.inCall() : [roster.bySlug(slug)].filter(Boolean)
  if (targets.length === 0) throw new Error(`no user for "${slug}"`)
  const results = {}
  for (const sim of targets) {
    switch (action) {
      case 'mute':
        results[sim.label] = await sim.setMic(false)
        break
      case 'unmute':
        results[sim.label] = await sim.setMic(true)
        break
      case 'cam-on':
        results[sim.label] = await sim.setCam(true)
        break
      case 'cam-off':
        results[sim.label] = await sim.setCam(false)
        break
      case 'share':
        results[sim.label] = await sim.setShare(true)
        break
      case 'share-stop':
        results[sim.label] = await sim.setShare(false)
        break
      case 'leave':
        await sim.leaveCall()
        results[sim.label] = sim.state
        break
      case 'rejoin':
        await sim.ensureLoggedIn(`/w/${roster.wsId}/call/${roster.callId}`)
        await sim.joinCall(roster.wsId, roster.callId)
        results[sim.label] = sim.state
        break
      case 'shot':
        results[sim.label] = await sim.shot()
        break
      default:
        throw new Error(`unknown action "${action}"`)
    }
  }
  return results
}

const thumbnail = async (slug) => {
  const roster = session.roster
  const sim = roster?.bySlug(slug)
  if (!sim?.page || sim.state === 'closed') return null
  const cached = thumbCache.get(slug)
  const now = Date.now()
  if (cached?.buffer && now - cached.at < THUMB_TTL_MS) return cached.buffer
  if (cached?.inFlight) return cached.inFlight
  const inFlight = Promise.race([
    sim.page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000 }),
    new Promise((resolve) => setTimeout(() => resolve(null), 4500)),
  ])
    .then((buffer) => {
      thumbCache.set(slug, { at: Date.now(), buffer, inFlight: null })
      return buffer
    })
    .catch(() => {
      thumbCache.set(slug, { at: Date.now(), buffer: null, inFlight: null })
      return null
    })
  thumbCache.set(slug, { at: cached?.at ?? 0, buffer: cached?.buffer ?? null, inFlight })
  return inFlight
}

export const startServer = async ({ port = 4610, configPath = null, open = true }) => {
  let snapshotCount = 0

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(readFileSync(UI_PATH))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        json(response, 200, (await stateSnapshot(configPath, { withVerify: true })).state)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/events') {
        response.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        response.write('retry: 1500\n\n')
        sseClients.add(response)
        request.on('close', () => sseClients.delete(response))
        response.write(
          `data: ${JSON.stringify(await stateSnapshot(configPath, { withVerify: true }))}\n\n`,
        )
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/thumb/')) {
        const slug = decodeURIComponent(url.pathname.split('/').pop())
        const buffer = await thumbnail(slug)
        if (!buffer) {
          response.writeHead(204)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
        response.end(buffer)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/launch') {
        await launchSession(configPath, await readBody(request))
        json(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/stop') {
        stopSession(configPath)
        json(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/guests') {
        const body = await readBody(request)
        if (!session.roster || session.status !== 'running') {
          throw new Error('start a session before adding guests')
        }
        const count = Math.max(1, Math.min(50, Number(body.count) || 1))
        const result = await session.roster.addGuests(count, body.link ?? null)
        broadcast(await stateSnapshot(configPath))
        json(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/join-workspace') {
        await runJoinWorkspace(configPath, await readBody(request))
        json(response, 200, { ok: true })
        broadcast(await stateSnapshot(configPath))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/quit') {
        json(response, 200, { ok: true })
        log.info('quit requested from dashboard')
        stopSession(configPath)
          .catch(() => {})
          .finally(() => process.exit(0))
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/action') {
        const body = await readBody(request)
        const results = await runAction(body.slug, body.action)
        broadcast(await stateSnapshot(configPath))
        json(response, 200, { ok: true, results })
        return
      }
      json(response, 404, { ok: false, error: 'not found' })
    } catch (error) {
      json(response, 400, { ok: false, error: error.message })
    }
  })

  // Push a fresh snapshot to connected dashboards; every Nth includes the
  // deep verifier pass (remote tiles + server participant count).
  setInterval(async () => {
    if (sseClients.size === 0) return
    snapshotCount += 1
    broadcast(
      await stateSnapshot(configPath, { withVerify: snapshotCount % VERIFY_EVERY === 0 }),
    )
  }, SNAPSHOT_MS).unref()

  scaffoldConfig(configPath)
  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(
              `port ${port} is busy — the dashboard is probably already running at ` +
                `http://127.0.0.1:${port} (or pass --port for another one)`,
            )
          : error,
      )
    })
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = `http://127.0.0.1:${port}`
  log.info(`dashboard ready at ${address}`)
  ensureBrowser()
  if (open) {
    const opener =
      process.platform === 'darwin'
        ? ['open', [address]]
        : process.platform === 'win32'
          ? ['cmd', ['/c', 'start', '', address]]
          : ['xdg-open', [address]]
    execFile(opener[0], opener[1], () => {})
  }

  const shutdown = async () => {
    log.info('shutting down…')
    await stopSession(configPath).catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  return server
}
