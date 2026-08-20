// Stopping a session that is still joining must be terminal. The dangerous
// case is a stop while bots are queued or launching: a browser that comes up
// after teardownAll has swept would outlive the stop and walk into the call as
// a ghost nobody can remove. This drives a real Roster — real browser
// launches — against a local page that stalls the join, stops it mid-batch,
// and asserts nothing survives.
//
//   node scripts/test-stop.mjs
import http from 'node:http'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The data home is decided when config.mjs loads, so point it at a scratch
// directory before any src module is imported.
process.env.CALL_BOTS_HOME = mkdtempSync(join(tmpdir(), 'call-bots-test-'))

const { RUN_MARKER } = await import('../src/browser.mjs')
const { runsDir } = await import('../src/config.mjs')
const { Roster } = await import('../src/orchestrator.mjs')
const { resolveLink } = await import('../src/platforms/index.mjs')
const { findMarkedPids, killPids } = await import('../src/procs.mjs')

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

const within = async (promise, ms, name) => {
  let timer
  const gaveUp = Symbol('timeout')
  const value = await Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(gaveUp), ms)
    }),
  ])
  clearTimeout(timer)
  check(name, value !== gaveUp, value === gaveUp ? `still pending after ${ms / 1000}s` : '')
  return value !== gaveUp
}

const until = async (condition, ms, step = 100) => {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return true
    await sleep(step)
  }
  return condition()
}

const runIds = () =>
  existsSync(runsDir)
    ? readdirSync(runsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    : []

const closeServer = (instance) =>
  new Promise((resolve) => {
    if (!instance) return resolve()
    try {
      instance.close(() => resolve())
    } catch {
      resolve()
    }
  })

const rosters = []
let server = null
let api = null
let apiBase = null
let blocked = false
try {
  // A page with neither the name form nor a refusal keeps the adapter's entry
  // wait pending — the shape of a join that has not resolved yet. Flipped to
  // `blocked`, it refuses every bot instead, so a whole batch fails at once.
  server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(blocked
      ? '<!doctype html><meta charset=utf-8><body><div data-testid="guest-join-blocked">expired</div></body>'
      : '<!doctype html><meta charset=utf-8><body>loading…</body>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${server.address().port}`
  const target = resolveLink(`${origin}/join/AbCdEfGhIjKlMnOpQrSt`)

  const rosterOptions = () => ({
    baseUrl: target.origin,
    headed: false,
    browser: 'auto',
    noVideo: true,
    noAudio: true,
    size: '1920x1080',
    fps: 12,
  })

  const settled = async (roster, adding, budgetMs) => {
    const done = await within(adding, budgetMs, 'add() settles after the stop')
    adding.catch(() => {})
    check('no bot is left in the call', roster.inCall().length === 0)
    const marker = `${RUN_MARKER}=${roster.runId}`
    const swept = await until(async () => (await findMarkedPids(marker)).length === 0, 5000)
    check('no browser process survives the stop', swept)
    return done
  }

  console.log('\nstop before the batch starts launching')
  {
    const roster = new Roster(rosterOptions())
    rosters.push(roster)
    const adding = roster.add(3, target)
    let addSettled = false
    adding.then(() => { addSettled = true }, () => { addSettled = true })
    const stopping = roster.teardownAll()
    // The server leans on this: stopSession must own the roster from the moment
    // it calls teardownAll, before anything is awaited, or launches and the join
    // continuation keep acting on a session that is being stopped.
    check('teardownAll takes ownership synchronously', roster.tearingDown === true)
    await stopping
    check('queued add settles before teardown completes', addSettled)
    await settled(roster, adding, 15_000)
    check(
      'queued bots were never launched',
      roster.guests.every((guest) => guest.state === 'created'),
      roster.guests.map((guest) => guest.state).join(', '),
    )
  }

  console.log('\nstop while the batch is mid-launch')
  {
    const roster = new Roster(rosterOptions())
    rosters.push(roster)
    const adding = roster.add(3, target)
    let addSettled = false
    adding.then(() => { addSettled = true }, () => { addSettled = true })
    const launching = await until(
      () => roster.guests.length === 3 && roster.guests.some((guest) => guest.browser),
      20_000,
    )
    check('a browser came up before the stop', launching)
    await roster.teardownAll()
    check('in-flight add settles before teardown completes', addSettled)
    const marker = `${RUN_MARKER}=${roster.runId}`
    check('no browser exists when teardown completes', (await findMarkedPids(marker)).length === 0)
    await settled(roster, adding, 20_000)
  }

  const { startServer } = await import('../src/server.mjs')
  api = await startServer({ port: 0, open: false })
  apiBase = `http://127.0.0.1:${api.address().port}`
  const post = async (path, body) => {
    const response = await fetch(`${apiBase}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })
    return response.json()
  }
  const getState = async () => (await fetch(`${apiBase}/api/state`)).json()

  console.log('\nreal /api/stop while the session is joining')
  {
    blocked = false
    const before = new Set(runIds())
    const first = await post('/api/start', { link: target.url, guests: 1 })
    check('the joining start is accepted', first.ok === true, JSON.stringify(first))
    const runId = runIds().find((candidate) => !before.has(candidate))
    check('the server roster has a run id', Boolean(runId), runId ?? 'missing')
    const joining = await until(async () => {
      const state = await getState()
      return state.status === 'joining' && Boolean(state.session?.guests?.length)
    }, 20_000, 20)
    check('the real server is still joining', joining)

    const stopped = await post('/api/stop')
    check('the real stop is accepted', stopped.ok === true, JSON.stringify(stopped))
    const idle = await until(async () => (await getState()).status === 'idle', 30_000, 20)
    check('the real stop settles back to idle', idle)
    const afterStop = await getState()
    check('the stopped session is cleared', afterStop.session === null)
    const marker = runId ? `${RUN_MARKER}=${runId}` : null
    check('the server-owned browser is gone when Stop completes',
      marker !== null && (await findMarkedPids(marker)).length === 0)
    await sleep(250)
    const later = await getState()
    check('the stopped join does not resurrect', later.status === 'idle' && later.session === null)
  }

  console.log('\na failed batch cleans up before a retry is offered')
  {
    // A batch that ends with zero successes has to clean itself up while still
    // owning the session — holding "stopping" so a retry cannot start until it
    // is done, and never wiping the session a retry then builds.
    blocked = true
    const first = await post('/api/start', { link: target.url, guests: 1 })
    check('the start is accepted', first.ok === true, JSON.stringify(first))

    let sawStopping = false
    let refusal = null
    let wiped = false
    const watch = async () => {
      const state = await getState()
      if (state.status === 'joining' && state.session === null) wiped = true
      if (state.status === 'stopping' && !sawStopping) {
        sawStopping = true
        refusal = await post('/api/start', { link: target.url, guests: 1 })
      }
      return state.status === 'idle'
    }
    // The stopping window is one real teardown (~100ms and up); sample well
    // inside it.
    await until(watch, 30_000, 20)
    check('cleanup passes through stopping before idle', sawStopping)
    check('a retry during cleanup is refused', refusal !== null && refusal.ok === false,
      JSON.stringify(refusal))
    check('the failure is still reported',
      (await getState()).lastError === 'no bot reached the call')

    const retry = await post('/api/start', { link: target.url, guests: 1 })
    check('a retry after cleanup is accepted', retry.ok === true, JSON.stringify(retry))
    await until(watch, 30_000, 20)
    check('no stale continuation wipes the newer session', !wiped)
    check('the retry settles back to idle', (await getState()).status === 'idle')
  }
} finally {
  // Nothing this test started may outlive it, least of all on a failing run:
  // stop the server's session and each roster through its own teardown, then
  // sweep by marker.
  if (apiBase) {
    await fetch(`${apiBase}/api/stop`, { method: 'POST' }).catch(() => {})
    await until(async () => {
      try {
        return (await fetch(`${apiBase}/api/state`)).json().then((state) => state.status === 'idle')
      } catch {
        return false
      }
    }, 30_000, 20).catch(() => false)
  }
  await closeServer(api)
  for (const roster of rosters) {
    await roster.teardownAll().catch(() => {})
  }
  for (const runId of runIds()) killPids(await findMarkedPids(`${RUN_MARKER}=${runId}`))
  await closeServer(server)
  rmSync(process.env.CALL_BOTS_HOME, { recursive: true, force: true })
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
process.exit(failed.length > 0 ? 1 : 0)
