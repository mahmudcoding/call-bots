import { execFile, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { bundledChromiumPath, systemChromePath } from './browser.mjs'
import { onLog, plain as log } from './log.mjs'
import { machineProfile } from './machine.mjs'
import { Roster } from './orchestrator.mjs'
import { parseInviteLink } from './selectors.mjs'

const UI_PATH = join(dirname(fileURLToPath(import.meta.url)), 'ui.html')

const THUMB_TTL_MS = 1500
const SNAPSHOT_MS = 2000
const VERIFY_EVERY = 3 // every Nth snapshot includes the deep check

// One dashboard drives one call at a time.
const session = {
  status: 'idle', // idle | joining | running | stopping
  roster: null,
  verify: null,
  startedAt: null,
  lastError: null,
}

const sseClients = new Set()
const thumbCache = new Map() // slug -> {at, buffer, inFlight}

const broadcast = (message) => {
  const payload = `data: ${JSON.stringify(message)}\n\n`
  for (const client of sseClients) client.write(payload)
}

onLog((entry) => broadcast({ type: 'log', entry }))

// The .app has no npm; download Chromium through playwright's CLI with our own
// runtime when the machine has no usable browser.
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
      if (text) log.info(`[chromium] ${text.split('\n').pop()}`)
    })
  relay(browserInstall.stdout)
  relay(browserInstall.stderr)
  browserInstall.on('exit', (code) => {
    log[code === 0 ? 'info' : 'warn'](
      code === 0 ? 'Chromium ready' : 'Chromium download failed — install Google Chrome',
    )
    browserInstall = null
  })
}

const stateSnapshot = async ({ withVerify = false } = {}) => {
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
      lastError: session.lastError,
      machine: machineProfile(),
      session: rosterState,
      verify: session.verify,
    },
  }
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

// Send the first guests in. The invite link carries both the origin and the
// token, so there is nothing else to configure.
const startSession = async (body) => {
  if (session.status !== 'idle') throw new Error(`a session is already ${session.status}`)
  const { origin, token } = parseInviteLink(body.link ?? '')
  const count = Math.max(1, Math.min(50, Number(body.guests) || 1))

  const roster = new Roster({
    baseUrl: origin,
    headed: false,
    browser: 'auto',
    noVideo: Boolean(body.noVideo),
    noAudio: Boolean(body.noAudio),
    size: '1920x1080',
    fps: 12,
  })
  session.roster = roster
  session.status = 'joining'
  session.startedAt = Date.now()
  session.lastError = null
  session.verify = null
  thumbCache.clear()

  ;(async () => {
    try {
      const result = await roster.add(count, token)
      session.status = roster.inCall().length > 0 ? 'running' : 'idle'
      if (roster.inCall().length === 0) {
        session.lastError = 'no guest reached the call'
        await roster.teardownAll().catch(() => {})
        session.roster = null
      } else if (result.failed) {
        log.warn(`${result.failed} guest(s) failed to join`)
      }
    } catch (error) {
      log.error(error.message)
      session.lastError = error.message
      await roster.teardownAll().catch(() => {})
      session.status = 'idle'
      session.roster = null
    }
    broadcast(await stateSnapshot({ withVerify: true }))
  })()
}

const stopSession = async () => {
  if (!session.roster || session.status === 'stopping') return
  session.status = 'stopping'
  broadcast(await stateSnapshot())
  await session.roster.teardownAll().catch((error) => log.warn(error.message))
  session.roster = null
  session.verify = null
  session.status = 'idle'
  broadcast(await stateSnapshot())
}

const runAction = async (slug, action) => {
  const roster = session.roster
  if (!roster || session.status !== 'running') throw new Error('no running session')
  const targets = slug === 'all' ? roster.inCall() : [roster.bySlug(slug)].filter(Boolean)
  if (targets.length === 0) throw new Error(`no guest for "${slug}"`)
  const results = {}
  for (const guest of targets) {
    switch (action) {
      case 'mute':
        results[guest.label] = await guest.setMic(false)
        break
      case 'unmute':
        results[guest.label] = await guest.setMic(true)
        break
      case 'cam-on':
        results[guest.label] = await guest.setCam(true)
        break
      case 'cam-off':
        results[guest.label] = await guest.setCam(false)
        break
      case 'share':
        results[guest.label] = await guest.setShare(true)
        break
      case 'share-stop':
        results[guest.label] = await guest.setShare(false)
        break
      case 'leave':
        await roster.remove(guest.user.slug)
        results[guest.label] = 'removed'
        break
      default:
        throw new Error(`unknown action "${action}"`)
    }
  }
  return results
}

const thumbnail = async (slug) => {
  const guest = session.roster?.bySlug(slug)
  if (!guest?.page || guest.state === 'closed') return null
  const cached = thumbCache.get(slug)
  const now = Date.now()
  if (cached?.buffer && now - cached.at < THUMB_TTL_MS) return cached.buffer
  if (cached?.inFlight) return cached.inFlight
  const inFlight = Promise.race([
    guest.page.screenshot({ type: 'jpeg', quality: 55, timeout: 4000 }),
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

export const startServer = async ({ port = 4610, open = true }) => {
  let snapshots = 0

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://127.0.0.1:${port}`)
    try {
      if (request.method === 'GET' && url.pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        response.end(readFileSync(UI_PATH))
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        json(response, 200, (await stateSnapshot({ withVerify: true })).state)
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
        response.write(`data: ${JSON.stringify(await stateSnapshot({ withVerify: true }))}\n\n`)
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/api/thumb/')) {
        const buffer = await thumbnail(decodeURIComponent(url.pathname.split('/').pop()))
        if (!buffer) {
          response.writeHead(204)
          response.end()
          return
        }
        response.writeHead(200, { 'content-type': 'image/jpeg', 'cache-control': 'no-store' })
        response.end(buffer)
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/start') {
        await startSession(await readBody(request))
        json(response, 200, { ok: true })
        broadcast(await stateSnapshot())
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/add') {
        const body = await readBody(request)
        if (!session.roster || session.status !== 'running') {
          throw new Error('start a session first')
        }
        const count = Math.max(1, Math.min(50, Number(body.guests) || 1))
        const result = await session.roster.add(count)
        broadcast(await stateSnapshot())
        json(response, 200, { ok: true, ...result })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/action') {
        const body = await readBody(request)
        const results = await runAction(body.slug, body.action)
        // removing the last guest ends the session, so the link can change
        if (session.roster && session.roster.guests.length === 0) {
          await stopSession()
        }
        broadcast(await stateSnapshot())
        json(response, 200, { ok: true, results })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/stop') {
        stopSession()
        json(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/quit') {
        json(response, 200, { ok: true })
        log.info('quit requested')
        stopSession()
          .catch(() => {})
          .finally(() => process.exit(0))
        return
      }
      json(response, 404, { ok: false, error: 'not found' })
    } catch (error) {
      json(response, 400, { ok: false, error: error.message })
    }
  })

  setInterval(async () => {
    if (sseClients.size === 0) return
    snapshots += 1
    broadcast(await stateSnapshot({ withVerify: snapshots % VERIFY_EVERY === 0 }))
  }, SNAPSHOT_MS).unref()

  await new Promise((resolve, reject) => {
    server.once('error', (error) => {
      reject(
        error.code === 'EADDRINUSE'
          ? new Error(`port ${port} is busy — Call Bots may already be running`)
          : error,
      )
    })
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = `http://127.0.0.1:${port}`
  log.info(`ready at ${address}`)
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
    await stopSession().catch(() => {})
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  return server
}
