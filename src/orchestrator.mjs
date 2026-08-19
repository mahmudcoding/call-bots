import { RUN_MARKER, createRunDir, writeManifest } from './browser.mjs'
import { ensureGuestFixtures, guestColorHex } from './fixtures.mjs'
import { Guest } from './guest.mjs'
import { plain as log } from './log.mjs'
import { concurrencyWarning } from './machine.mjs'
import { findMarkedPids, killPids } from './procs.mjs'

const JOIN_CONCURRENCY = 2

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

// Holds every guest of one call and the run-owned resources behind them.
export class Roster {
  constructor(options) {
    this.options = options
    this.runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
    this.runDir = createRunDir(this.runId)
    this.options.runId = this.runId
    this.options.runDir = this.runDir
    this.guests = []
    this.counter = 0
    this.token = null
    this.meetingId = null
    this.tearingDown = false
  }

  get callUrl() {
    return this.token ? `${this.options.baseUrl}/join/${this.token}` : null
  }

  #manifest(extra = {}) {
    writeManifest(this.runDir, {
      runId: this.runId,
      baseUrl: this.options.baseUrl,
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

  // Sends `count` more guests into the call. The first call sets the token.
  async add(count, token = null) {
    if (token) this.token = token
    if (!this.token) throw new Error('no invite link — paste the call\'s invite link first')

    const total = this.guests.length + count
    const warning = concurrencyWarning(total)
    if (warning) log.warn(warning)

    const batch = Array.from({ length: count }, () => {
      this.counter += 1
      const n = this.counter
      return { n, index: n - 1, label: `Guest ${n}`, slug: `guest-${n}` }
    })
    log.info(`preparing ${batch.length} guest(s)`)
    const media = await ensureGuestFixtures(batch, this.options)
    const guests = batch.map((guest) => new Guest(guest, media.get(guest.slug), this.options))
    this.guests.push(...guests)
    this.#manifest()

    const failures = await pool(
      guests,
      async (guest) => {
        guest.log.info('launching browser')
        await guest.start()
        await guest.join(this.token)
        this.meetingId ??= guest.meetingId
      },
      JOIN_CONCURRENCY,
    )
    for (const { item, error } of failures) item.log.error(error.message)
    this.#manifest()
    return { added: guests.length - failures.length, failed: failures.length }
  }

  // A guest that leaves is gone: close its browser and drop it from the roster
  // so nothing lingers in the window.
  async remove(slug) {
    const guest = this.bySlug(slug)
    if (!guest) return false
    await guest.teardown().catch((error) => guest.log.warn(`teardown failed: ${error.message}`))
    this.guests = this.guests.filter((candidate) => candidate !== guest)
    this.#manifest()
    return true
  }

  async statusData() {
    const guests = []
    for (const [i, guest] of this.guests.entries()) {
      const inCall = guest.state === 'in-call'
      guests.push({
        index: i,
        slug: guest.user.slug,
        label: guest.label,
        color: guestColorHex(guest.user.n - 1),
        state: guest.state,
        mic: inCall ? await guest.micState().catch(() => 'unknown') : null,
        cam: inCall ? await guest.camState().catch(() => 'unknown') : null,
        lastError: guest.lastError,
      })
    }
    return { meetingId: this.meetingId, inviteLink: this.callUrl, guests }
  }

  // One guest checks that the other tiles really render — buttons are not proof.
  async verifyData() {
    const verifier = this.inCall()[0]
    if (!verifier) return null
    const remote = await verifier.verifyRemote().catch(() => null)
    return { verifier: verifier.label, remote, at: Date.now() }
  }

  async teardownAll() {
    if (this.tearingDown) return
    this.tearingDown = true
    log.info('closing guests…')
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
