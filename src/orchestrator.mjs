import { RUN_MARKER, createRunDir, writeManifest } from './browser.mjs'
import { THEME_COUNT, ensureGuestFixtures, guestColorHex } from './fixtures.mjs'
import { Guest } from './guest.mjs'
import { plain as log } from './log.mjs'
import { concurrencyWarning } from './machine.mjs'
import { findMarkedPids, killPids } from './procs.mjs'

// Launching browsers is the heavy part, so it stays paced. Waiting to be
// admitted is not, and must never hold a lane: a host running "Wait for
// admission" has to see every request at once, not two at a time with the rest
// queued behind them.
const LAUNCH_CONCURRENCY = 2

const PROBE_TIMEOUT = 4000

// Resolves to `fallback` rather than hanging when a browser is too busy to
// answer. A slow bot should show as unknown, not freeze the whole window.
const bounded = (promise, fallback) =>
  Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), PROBE_TIMEOUT)),
  ])

const pool = async (items, worker, concurrency) => {
  const queue = [...items]
  const failures = []
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()
      try {
        await worker(item)
      } catch (error) {
        item.lastError = error.message
        failures.push({ item, error })
      }
    }
  })
  await Promise.all(lanes)
  return failures
}

// Holds every bot of one call and the run-owned resources behind them.
export class Roster {
  constructor(options) {
    this.options = options
    this.runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
    this.runDir = createRunDir(this.runId)
    this.options.runId = this.runId
    this.options.runDir = this.runDir
    this.guests = []
    this.counter = 0
    this.target = null
    this.meetingId = null
    this.tearingDown = false
  }

  get callUrl() {
    return this.target?.url ?? null
  }

  get platform() {
    return this.target?.label ?? null
  }

  #manifest(extra = {}) {
    writeManifest(this.runDir, {
      runId: this.runId,
      baseUrl: this.options.baseUrl,
      platform: this.target?.platform ?? null,
      meetingId: this.meetingId,
      guests: this.guests.map((guest) => ({ label: guest.label, state: guest.state })),
      ...extra,
    })
  }

  inCall() {
    return this.guests.filter((guest) => guest.state === 'in-call')
  }

  bySlug(slug) {
    return this.guests.find((guest) => guest.user.slug === slug) ?? null
  }

  // Sends `count` more bots into the call. The first call sets the target.
  // `overrides` applies to this batch only, so bots added later can arrive with
  // their camera or microphone in a different state from the ones already in.
  async add(count, target = null, overrides = null) {
    if (target) this.target = target
    if (!this.target) throw new Error('no call link — paste the call link first')

    const total = this.guests.length + count
    const warning = concurrencyWarning(total)
    if (warning) log.warn(warning)

    const batch = Array.from({ length: count }, () => {
      this.counter += 1
      const n = this.counter
      return { n, index: n - 1, label: `Bot ${n}`, slug: `bot-${n}` }
    })
    log.info(`preparing ${batch.length} bot(s)`)
    const media = await ensureGuestFixtures(batch, this.options)
    const options = overrides ? { ...this.options, ...overrides } : this.options
    const guests = batch.map((guest) => new Guest(guest, media.get(guest.slug), options))
    this.guests.push(...guests)
    this.#manifest()

    const failures = []
    const failed = (guest, error) => {
      guest.lastError = error.message
      failures.push({ item: guest, error })
    }

    const launched = []
    await pool(
      guests,
      async (guest) => {
        guest.log.info('launching browser')
        try {
          await guest.start()
          launched.push(guest)
        } catch (error) {
          failed(guest, error)
        }
      },
      LAUNCH_CONCURRENCY,
    )

    await Promise.all(
      launched.map(async (guest) => {
        try {
          await guest.join(this.target)
          this.meetingId ??= guest.meetingId
        } catch (error) {
          failed(guest, error)
        }
      }),
    )
    for (const { item, error } of failures) item.log.error(error.message)
    this.#manifest()
    return { added: guests.length - failures.length, failed: failures.length }
  }

  // A bot that leaves is gone: close its browser and drop it from the roster
  // so nothing lingers in the window.
  async remove(slug) {
    const guest = this.bySlug(slug)
    if (!guest) return false
    await guest.teardown().catch((error) => guest.log.warn(`teardown failed: ${error.message}`))
    this.guests = this.guests.filter((candidate) => candidate !== guest)
    this.#manifest()
    return true
  }

  // Asking each bot in turn costs a round trip per bot per poll, which stops
  // answering at all once there are enough of them on a busy machine. Ask them
  // all at once, and never let one stuck browser hold up the answer.
  async statusData() {
    const guests = await Promise.all(
      this.guests.map(async (guest, i) => {
        // A bot admitted after it stopped waiting is in the call whatever we
        // recorded, and its controls have to come back to life.
        await bounded(guest.recoverIfAdmitted(), null)
        const inCall = guest.state === 'in-call'
        const [mic, cam] = inCall
          ? await Promise.all([
              bounded(guest.micState(), 'unknown'),
              bounded(guest.camState(), 'unknown'),
            ])
          : [null, null]
        return {
          index: i,
          slug: guest.user.slug,
          label: guest.label,
          color: guestColorHex((guest.user.n - 1) % THEME_COUNT),
          state: guest.state,
          mic,
          cam,
          lastError: guest.lastError,
        }
      }),
    )
    return { meetingId: this.meetingId, inviteLink: this.callUrl, platform: this.platform, guests }
  }

  // One bot checks that the other tiles really render — buttons are not proof.
  async verifyData() {
    const verifier = this.inCall()[0]
    if (!verifier) return null
    const remote = await verifier.verifyRemote().catch(() => null)
    return { verifier: verifier.label, remote, at: Date.now() }
  }

  async teardownAll() {
    if (this.tearingDown) return
    this.tearingDown = true
    log.info('closing bots…')
    await Promise.all(
      this.guests.map((guest) =>
        Promise.race([
          guest.teardown(),
          new Promise((resolve) => setTimeout(resolve, 30_000)),
        ]).catch((error) => guest.log.warn(`teardown failed: ${error.message}`)),
      ),
    )
    await this.#sweep()
    this.#manifest({ finishedAt: new Date().toISOString() })
    log.info('done')
  }

  // Belt and braces: a wedged browser.close() must never strand a publishing
  // browser, so kill anything still carrying this run's marker.
  async #sweep() {
    const pids = await findMarkedPids(`${RUN_MARKER}=${this.runId}`)
    if (pids.length === 0) return
    log.warn(`sweeping ${pids.length} leftover browser process(es)`)
    killPids(pids)
  }
}
