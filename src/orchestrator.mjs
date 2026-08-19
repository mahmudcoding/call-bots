import {
  activeMeetings,
  createGuestLink,
  findParticipantCount,
  findStringField,
  listGuestLinks,
} from './appApi.mjs'
import { RUN_MARKER, createRunDir, writeManifest } from './browser.mjs'
import { ensureFixtures, ensureGuestFixtures, guestColorHex, userColorHex } from './fixtures.mjs'
import { GuestUser } from './guestuser.mjs'
import { plain as log } from './log.mjs'
import { findMarkedPids, killPids } from './procs.mjs'
import { SimUser } from './simuser.mjs'
import { parseGuestToken } from './selectors.mjs'

const JOIN_CONCURRENCY = 2

const pool = async (items, worker, concurrency) => {
  const queue = [...items.entries()]
  const failures = []
  const lanes = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (queue.length > 0) {
      const [index, item] = queue.shift()
      try {
        await worker(item, index)
      } catch (error) {
        if (item && typeof item === 'object') item.lastError = error.message
        failures.push({ item, error })
      }
    }
  })
  await Promise.all(lanes)
  return failures
}

export class Roster {
  constructor(config, options) {
    this.config = config
    this.options = options
    this.runId = `${new Date().toISOString().replace(/[:.]/gu, '-')}-${process.pid}`
    this.runDir = createRunDir(this.runId)
    this.options.runId = this.runId
    this.options.runDir = this.runDir
    this.options.baseUrl = config.baseUrl
    this.simUsers = []
    this.guests = []
    this.guestToken = null
    this.guestCounter = 0
    this.wsId = null
    this.callId = null
    this.createdCall = false
    this.tearingDown = false
  }

  // Everyone in the call: accounts first, then guests.
  get members() {
    return [...this.simUsers, ...this.guests]
  }

  #manifest(extra = {}) {
    writeManifest(this.runDir, {
      runId: this.runId,
      baseUrl: this.config.baseUrl,
      wsId: this.wsId,
      callId: this.callId,
      createdCall: this.createdCall,
      users: this.simUsers.map((sim) => ({
        label: sim.label,
        email: sim.user.email,
        state: sim.state,
      })),
      guests: this.guests.map((guest) => ({ label: guest.label, state: guest.state })),
      ...extra,
    })
  }

  async #prepare(users) {
    if (users.length > 6) {
      log.warn(
        `${users.length} users requested — on a 16 GB Mac more than ~6 publishing ` +
          `browsers will contend for CPU and can degrade the media itself.`,
      )
    }
    log.info(`generating/reusing fixtures for ${users.length} user(s)`)
    const media = await ensureFixtures(users, this.options)
    return users.map((user) => new SimUser(user, media.get(user.slug), this.options))
  }

  // Single entry point for both link shapes: a call deep link, or the call's
  // guest invite link (which signed-in users auto-join through and which also
  // hands us the token guests need).
  async joinByLink(users, target) {
    if (target.kind === 'invite') {
      this.guestToken = target.token
    } else {
      this.wsId = target.wsId
      this.callId = target.callId
    }
    this.simUsers = await this.#prepare(users)
    this.#manifest()

    const failures = await pool(
      this.simUsers,
      async (sim) => {
        sim.log.info('launching browser')
        await sim.start()
        if (target.kind === 'invite') {
          await sim.ensureLoggedIn('/w')
          const found = await sim.joinViaInvite(target.token)
          // the first user through tells the roster which call this is
          if (found && !this.callId) {
            this.wsId = found.wsId
            this.callId = found.callId
          }
        } else {
          await sim.ensureLoggedIn(`/w/${target.wsId}/call/${target.callId}`)
          await sim.joinCall(target.wsId, target.callId)
        }
      },
      JOIN_CONCURRENCY,
    )
    for (const { item, error } of failures) {
      item.log.error(error.message)
    }
    this.#manifest()
    return failures.length === 0
  }

  async createAndJoin(users, wsId) {
    this.wsId = wsId
    this.simUsers = await this.#prepare(users)
    this.#manifest()

    const [creator, ...rest] = this.simUsers
    creator.log.info('launching browser (creator)')
    await creator.start()
    await creator.ensureLoggedIn(`/w/${wsId}/calls`)
    this.callId = await creator.createCall(wsId)
    this.createdCall = true
    // the create response carries the guest link, so guests need no host UI
    this.guestToken = creator.guestToken ?? null
    if (!this.guestToken) await this.#fetchGuestToken(creator)
    this.#manifest()

    const url = `${this.config.baseUrl}/w/${wsId}/call/${this.callId}`
    log.info('')
    log.info('================================================================')
    log.info(`  CALL URL (join from your own browser):`)
    log.info(`  ${url}`)
    if (this.guestToken) {
      log.info(`  GUEST INVITE LINK (works for users and guests):`)
      log.info(`  ${this.config.baseUrl}/join/${this.guestToken}`)
    }
    log.info('================================================================')
    log.info('')

    const failures = await pool(
      rest,
      async (sim) => {
        sim.log.info('launching browser')
        await sim.start()
        await sim.ensureLoggedIn(`/w/${wsId}/call/${this.callId}`)
        await sim.joinCall(wsId, this.callId)
      },
      JOIN_CONCURRENCY,
    )
    for (const { item, error } of failures) {
      item.log.error(error.message)
    }
    this.#manifest()
    return failures.length === 0
  }

  // Guest links are readable by the host (and by anyone when the room setting
  // allows). Any in-call sim can try; the first that succeeds wins.
  async #fetchGuestToken(preferred) {
    const candidates = [preferred, ...this.inCall()].filter(Boolean)
    for (const sim of candidates) {
      if (!this.callId || !sim.page) continue
      const list = await listGuestLinks(sim.page, this.callId).catch(() => null)
      const token = findStringField(list?.body ?? null, 'token')
      if (token) {
        this.guestToken = token
        return token
      }
      const created = await createGuestLink(sim.page, this.callId).catch(() => null)
      const newToken = findStringField(created?.body ?? null, 'token')
      if (newToken) {
        this.guestToken = newToken
        return newToken
      }
    }
    return null
  }

  // Adds N anonymous guests to the current call. `link` is optional: the token
  // is normally already known from call creation or the guest-links API.
  async addGuests(count, link = null) {
    if (link) this.guestToken = parseGuestToken(link)
    if (!this.guestToken) await this.#fetchGuestToken(null)
    if (!this.guestToken) {
      throw new Error(
        'no guest link available — only the call host can read one. Launch the ' +
          'session with the call\'s guest invite link (…/join/<token>) instead of ' +
          'the call URL, or paste that link in the Guests field.',
      )
    }
    const batch = Array.from({ length: count }, () => {
      this.guestCounter += 1
      const n = this.guestCounter
      return {
        n,
        index: this.simUsers.length + n - 1,
        label: `Guest ${n}`,
        slug: `guest-${n}`,
        email: null,
      }
    })
    log.info(`generating/reusing fixtures for ${batch.length} guest(s)`)
    const media = await ensureGuestFixtures(batch, this.options)
    const guests = batch.map((guest) => new GuestUser(guest, media.get(guest.slug), this.options))
    this.guests.push(...guests)
    this.#manifest()

    const failures = await pool(
      guests,
      async (guest) => {
        guest.log.info('launching browser (guest)')
        await guest.start()
        await guest.joinGuest(this.guestToken, this.callId)
      },
      JOIN_CONCURRENCY,
    )
    for (const { item, error } of failures) item.log.error(error.message)
    this.#manifest()
    return { added: guests.length - failures.length, failed: failures.length }
  }

  inCall() {
    return this.members.filter((sim) => sim.state === 'in-call')
  }

  bySlug(slug) {
    return this.members.find((sim) => sim.user.slug === slug) ?? null
  }

  get callUrl() {
    if (!this.wsId || !this.callId) return null
    return `${this.config.baseUrl}/w/${this.wsId}/call/${this.callId}`
  }

  // Structured per-user snapshot for the dashboard and the REPL table.
  async statusData() {
    const describe = async (sim, i, isGuest) => {
      const inCall = sim.state === 'in-call'
      return {
        index: i,
        slug: sim.user.slug,
        label: sim.label,
        email: sim.user.email ?? null,
        guest: isGuest,
        color: isGuest ? guestColorHex(sim.user.n - 1) : userColorHex(sim.user.index),
        state: sim.state,
        mic: inCall ? await sim.micState().catch(() => 'unknown') : null,
        cam: inCall ? await sim.camState().catch(() => 'unknown') : null,
        sharing: sim.sharing === true,
        lastError: sim.lastError,
      }
    }
    const users = []
    for (const [i, sim] of this.simUsers.entries()) users.push(await describe(sim, i, false))
    for (const [i, guest] of this.guests.entries()) {
      users.push(await describe(guest, this.simUsers.length + i, true))
    }
    return {
      wsId: this.wsId,
      callId: this.callId,
      callUrl: this.callUrl,
      createdCall: this.createdCall,
      guestLink: this.guestToken ? `${this.config.baseUrl}/join/${this.guestToken}` : null,
      guestCount: this.guests.length,
      users,
    }
  }

  // One designated verifier (first in-call user) checks that remote tiles
  // actually render, plus the server-side participant count.
  async verifyData() {
    const verifier = this.inCall()[0]
    if (!verifier) return null
    const remote = await verifier.verifyRemote().catch(() => null)
    let participantCount = null
    if (this.wsId && this.callId) {
      const active = await activeMeetings(verifier.page, this.wsId).catch(() => null)
      participantCount = active ? findParticipantCount(active.body, this.callId) : null
    }
    return { verifier: verifier.label, remote, participantCount, at: Date.now() }
  }

  async statusTable() {
    const status = await this.statusData()
    const rows = [['#', 'user', 'state', 'mic', 'cam']]
    for (const user of status.users) {
      rows.push([
        String(user.index + 1),
        user.label,
        user.state,
        user.mic ?? '-',
        user.cam ?? '-',
      ])
    }
    const widths = rows[0].map((_, col) => Math.max(...rows.map((row) => row[col].length)))
    const lines = rows.map((row) => row.map((cell, col) => cell.padEnd(widths[col] + 2)).join(''))
    const verify = await this.verifyData()
    if (verify?.remote) {
      const { remote } = verify
      lines.push(
        `verifier=${verify.verifier}: tiles local=${remote.local} remote=${remote.remote} ` +
          `remote-playing=${remote.remotePlaying} frozen=${remote.frozen}`,
      )
      if (remote.names.length > 0) lines.push(`tiles: ${remote.names.join(', ')}`)
    }
    if (verify) {
      lines.push(
        `server participant_count=${verify.participantCount ?? 'unknown'} ` +
          `(workspace active-meetings API)`,
      )
    }
    return lines.join('\n')
  }

  async teardownAll() {
    if (this.tearingDown) return
    this.tearingDown = true
    log.info('tearing down: leaving call and closing browsers…')
    const creator = this.createdCall ? this.simUsers[0] : null
    const bounded = (sim, options) => {
      let timer
      return Promise.race([
        sim.teardown(options).finally(() => clearTimeout(timer)),
        new Promise((resolve) => {
          timer = setTimeout(resolve, 30_000)
        }).then(() => {
          if (sim.state !== 'closed') {
            sim.log.warn('teardown timed out — will be swept by run marker')
          }
        }),
      ]).catch((error) => sim.log.warn(`teardown failed: ${error.message}`))
    }
    // guests first (they hold no call ownership), then members, creator last
    await Promise.all(this.members.filter((sim) => sim !== creator).map((sim) => bounded(sim)))
    if (creator) {
      // creator goes last and ends the call it created, leaving staging tidy
      await bounded(creator, { endCall: true })
    }
    await this.#sweepLeftovers()
    this.#manifest({ finishedAt: new Date().toISOString() })
    log.info('done')
  }

  // Belt and braces: kill anything still carrying THIS run's marker so a
  // wedged browser.close() can never strand a publishing browser.
  async #sweepLeftovers() {
    const pids = await findMarkedPids(`${RUN_MARKER}=${this.runId}`)
    if (pids.length === 0) return
    log.warn(`sweeping ${pids.length} leftover browser process(es)`)
    killPids(pids)
  }
}
