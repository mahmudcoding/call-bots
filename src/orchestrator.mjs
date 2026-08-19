import { activeMeetings, findParticipantCount } from './appApi.mjs'
import { RUN_MARKER, createRunDir, writeManifest } from './browser.mjs'
import { ensureFixtures, userColorHex } from './fixtures.mjs'
import { plain as log } from './log.mjs'
import { findMarkedPids, killPids } from './procs.mjs'
import { SimUser } from './simuser.mjs'

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
    this.wsId = null
    this.callId = null
    this.createdCall = false
    this.tearingDown = false
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

  async joinExisting(users, wsId, callId) {
    this.wsId = wsId
    this.callId = callId
    this.simUsers = await this.#prepare(users)
    this.#manifest()

    const failures = await pool(
      this.simUsers,
      async (sim) => {
        sim.log.info('launching browser')
        await sim.start()
        await sim.ensureLoggedIn(`/w/${wsId}/call/${callId}`)
        await sim.joinCall(wsId, callId)
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
    this.#manifest()

    const url = `${this.config.baseUrl}/w/${wsId}/call/${this.callId}`
    log.info('')
    log.info('================================================================')
    log.info(`  CALL URL (join from your own browser):`)
    log.info(`  ${url}`)
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

  inCall() {
    return this.simUsers.filter((sim) => sim.state === 'in-call')
  }

  bySlug(slug) {
    return this.simUsers.find((sim) => sim.user.slug === slug) ?? null
  }

  get callUrl() {
    if (!this.wsId || !this.callId) return null
    return `${this.config.baseUrl}/w/${this.wsId}/call/${this.callId}`
  }

  // Structured per-user snapshot for the dashboard and the REPL table.
  async statusData() {
    const users = []
    for (const [i, sim] of this.simUsers.entries()) {
      const inCall = sim.state === 'in-call'
      users.push({
        index: i,
        slug: sim.user.slug,
        label: sim.label,
        email: sim.user.email,
        color: userColorHex(sim.user.index),
        state: sim.state,
        mic: inCall ? await sim.micState().catch(() => 'unknown') : null,
        cam: inCall ? await sim.camState().catch(() => 'unknown') : null,
        sharing: sim.sharing === true,
        lastError: sim.lastError,
      })
    }
    return {
      wsId: this.wsId,
      callId: this.callId,
      callUrl: this.callUrl,
      createdCall: this.createdCall,
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
    await Promise.all(this.simUsers.filter((sim) => sim !== creator).map((sim) => bounded(sim)))
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
