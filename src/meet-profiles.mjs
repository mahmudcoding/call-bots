import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join, sep } from 'node:path'
import { spawn } from 'node:child_process'

import { googleChromePath } from './browser.mjs'
import { baseDir } from './config.mjs'

const VERSION = 1
const PROFILE_ID = /^[a-f0-9-]{36}$/u
// How often a setup window is checked for a completed sign-in, and how long
// one is followed before the app stops caring. Long enough for someone to find
// a password and a second factor; short enough that a forgotten window does
// not poll for the rest of the day.
const SETUP_POLL_MS = 1_500
const SETUP_WATCH_MS = 30 * 60_000

const cleanName = (value) => {
  const name = String(value ?? '').trim().replace(/\s+/gu, ' ')
  return name ? name.slice(0, 80) : null
}

const readJson = (path) => {
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, 'utf8'))
}

// Chrome keeps the signed-in account's safe display name in profile metadata.
// Never return the neighbouring email, Gaia id, cookies, or tokens.
export const inspectMeetProfile = (userDataDir) => {
  let signedIn = false
  let displayName = null

  try {
    const preferences = readJson(join(userDataDir, 'Default', 'Preferences')) ?? {}
    for (const account of Array.isArray(preferences.account_info)
      ? preferences.account_info
      : []) {
      if (account?.account_id || account?.gaia || account?.email) signedIn = true
      displayName ??= cleanName(account?.full_name) ?? cleanName(account?.given_name)
    }
  } catch {
    // A half-written Preferences file simply means setup is not ready yet.
  }

  try {
    const localState = readJson(join(userDataDir, 'Local State')) ?? {}
    const profile = localState?.profile?.info_cache?.Default ?? {}
    if (profile.gaia_id || profile.user_name) signedIn = true
    displayName ??= cleanName(profile.gaia_name)
  } catch {
    // Same as above: setup can be closed while Chrome is still flushing state.
  }

  return { signedIn, displayName }
}

const normalizeRecords = (value) => {
  if (!value || value.version !== VERSION || !Array.isArray(value.profiles)) return []
  return value.profiles
    .filter((profile) => PROFILE_ID.test(String(profile?.id ?? '')))
    .map((profile, index) => ({
      id: profile.id,
      displayName: cleanName(profile.displayName),
      ready: profile.ready === true,
      // The number people see on a card and in the account list. It is stored,
      // not derived from position, because removing an account renumbers every
      // account below it and a bot's card would then name a different one.
      number: Number(profile.number) > 0 ? Number(profile.number) : index + 1,
      createdAt: Number(profile.createdAt) || Date.now(),
    }))
}

export class MeetProfileStore {
  constructor({
    root = join(baseDir, 'meet-profiles'),
    chromePath = googleChromePath,
    spawnProcess = spawn,
    inspect = inspectMeetProfile,
    // Sign-in finishing is the one thing the dashboard cannot poll for itself,
    // so the store announces it instead.
    onChange = null,
  } = {}) {
    this.root = root
    this.metadataPath = join(root, 'profiles.json')
    this.chromePath = chromePath
    this.spawnProcess = spawnProcess
    this.inspect = inspect
    this.onChange = onChange
    this.reservations = new Map()
    this.setups = new Map()
    this.watchers = new Map()

    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    try { chmodSync(this.root, 0o700) } catch {}
    const saved = readJson(this.metadataPath)
    this.records = normalizeRecords(saved)
  }

  #save() {
    const body = `${JSON.stringify({ version: VERSION, profiles: this.records }, null, 2)}\n`
    const temporary = `${this.metadataPath}.${process.pid}.tmp`
    writeFileSync(temporary, body, { mode: 0o600 })
    renameSync(temporary, this.metadataPath)
    try { chmodSync(this.metadataPath, 0o600) } catch {}
  }

  #record(id) {
    if (!PROFILE_ID.test(String(id ?? ''))) throw new Error('unknown Google account profile')
    const profile = this.records.find((candidate) => candidate.id === id)
    if (!profile) throw new Error('unknown Google account profile')
    return profile
  }

  #profileDir(id) {
    const path = join(this.root, id)
    if (!path.startsWith(`${this.root}${sep}`)) throw new Error('invalid Google account profile')
    return path
  }

  #public(profile) {
    // "signed-in" is its own state on purpose. The sign-in has landed and the
    // dashboard should say so immediately — but real Chrome still holds this
    // profile's lock, so a bot reopening it would fail. Telling the truth about
    // both is better than showing "setting up" over a finished sign-in or
    // "ready" over a profile nothing can open.
    const status = this.setups.has(profile.id)
      ? profile.ready
        ? 'signed-in'
        : 'setting-up'
      : this.reservations.has(profile.id)
        ? 'in-use'
        : profile.ready
          ? 'ready'
          : 'needs-sign-in'
    return {
      id: profile.id,
      displayName: profile.displayName,
      number: profile.number,
      status,
    }
  }

  #announce() {
    try {
      this.onChange?.()
    } catch {
      // A dashboard that cannot be told is not a reason to fail a sign-in.
    }
  }

  #nextNumber() {
    return this.records.reduce((highest, profile) => Math.max(highest, profile.number ?? 0), 0) + 1
  }

  list() {
    return this.records.map((profile) => this.#public(profile))
  }

  summary() {
    const profiles = this.list()
    return {
      profiles,
      available: profiles.filter((profile) => profile.status === 'ready').length,
      chromeReady: Boolean(this.chromePath()),
    }
  }

  assertAvailable(count) {
    const available = this.list().filter((profile) => profile.status === 'ready').length
    if (available < count) {
      throw new Error(
        `Google Meet needs one signed-in Google account per bot — ${available} ready, ${count} requested. ` +
          'Add or reconnect accounts in Call Bots → Google accounts.',
      )
    }
  }

  reserveMany(count, owner = 'meet') {
    this.assertAvailable(count)
    const profiles = this.records
      .filter(
        (profile) =>
          profile.ready && !this.reservations.has(profile.id) && !this.setups.has(profile.id),
      )
      .slice(0, count)

    return profiles.map((profile, index) => {
      const token = `${owner}:${index}:${randomUUID()}`
      this.reservations.set(profile.id, token)
      let released = false
      return {
        id: profile.id,
        displayName: profile.displayName ?? `Google account ${profile.number}`,
        accountNumber: profile.number,
        userDataDir: this.#profileDir(profile.id),
        markNeedsSignIn: () => {
          profile.ready = false
          this.#save()
          this.#announce()
        },
        release: () => {
          if (released) return
          released = true
          if (this.reservations.get(profile.id) === token) this.reservations.delete(profile.id)
        },
      }
    })
  }

  setup(id = null) {
    const executable = this.chromePath()
    if (!executable) {
      throw new Error('Google Chrome is required to set up Google Meet accounts')
    }

    let profile
    let created = false
    if (id === null || id === undefined || id === '') {
      profile = {
        id: randomUUID(),
        displayName: null,
        ready: false,
        number: this.#nextNumber(),
        createdAt: Date.now(),
      }
      this.records.push(profile)
      this.#save()
      created = true
    } else {
      profile = this.#record(id)
    }

    if (this.reservations.has(profile.id)) {
      throw new Error('that Google account is in use by a bot')
    }
    if (this.setups.has(profile.id)) return this.#public(profile)

    const userDataDir = this.#profileDir(profile.id)
    mkdirSync(userDataDir, { recursive: true, mode: 0o700 })
    try { chmodSync(userDataDir, 0o700) } catch {}

    const rollback = () => {
      if (!created) return
      this.records = this.records.filter((candidate) => candidate !== profile)
      this.#save()
    }

    let child
    try {
      child = this.spawnProcess(
        executable,
        [
          `--user-data-dir=${userDataDir}`,
          '--profile-directory=Default',
          '--new-window',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-mode',
          // The bots reopen this profile with --lang=en-US, and Chrome writes
          // the language it was started with into the profile. Starting setup
          // any other way teaches the profile a language the adapter cannot
          // read back.
          '--lang=en-US',
          'https://meet.google.com/?hl=en',
        ],
        // Detached, or closing Call Bots takes the sign-in window with it —
        // which is exactly when somebody is halfway through a second factor.
        { stdio: 'ignore', detached: true },
      )
    } catch (error) {
      rollback()
      throw new Error(`could not open Google Chrome: ${error.message}`)
    }

    this.setups.set(profile.id, child)

    // Absorb whatever the sign-in has produced so far. Called on a timer AND on
    // exit: the timer is what makes the dashboard light up while the window is
    // still open, and the exit is the final word.
    const absorb = () => {
      const account = this.inspect(userDataDir)
      if (!account.signedIn) return false
      const changed = !profile.ready || (account.displayName && account.displayName !== profile.displayName)
      profile.ready = true
      if (account.displayName) profile.displayName = account.displayName
      if (changed) {
        this.#save()
        this.#announce()
      }
      return true
    }

    const stopWatching = () => {
      const timer = this.watchers.get(profile.id)
      if (!timer) return
      clearInterval(timer)
      this.watchers.delete(profile.id)
    }

    // Chrome on macOS outlives its last window, so waiting for the process to
    // exit means waiting for a Quit that usually never comes — the old build
    // sat at "0 ready" forever because of it. Watch the profile on disk instead.
    const startedAt = Date.now()
    stopWatching()
    const timer = setInterval(() => {
      if (this.setups.get(profile.id) !== child) return stopWatching()
      absorb()
      if (Date.now() - startedAt > SETUP_WATCH_MS) stopWatching()
    }, SETUP_POLL_MS)
    timer.unref?.()
    this.watchers.set(profile.id, timer)

    const finish = () => {
      if (this.setups.get(profile.id) !== child) return
      this.setups.delete(profile.id)
      stopWatching()
      if (!absorb()) {
        // Nothing was signed in. A brand-new profile that never got that far is
        // an empty directory nobody asked for.
        profile.ready = false
        this.#save()
      }
      this.#announce()
    }

    child.once('exit', finish)
    // A spawn that never started is not a finished setup: treating it as one
    // leaves a record standing over an empty directory.
    child.once('error', () => {
      if (this.setups.get(profile.id) !== child) return
      this.setups.delete(profile.id)
      stopWatching()
      rollback()
      this.#announce()
    })
    child.unref?.()
    this.#announce()
    return this.#public(profile)
  }

  // Is this profile's Google session still alive? A stale cookie jar is
  // otherwise only discovered as a failed bot, halfway through a batch.
  async verify(id, { launch = null } = {}) {
    const profile = this.#record(id)
    if (this.reservations.has(id)) throw new Error('that Google account is in use by a bot')
    if (this.setups.has(id)) throw new Error('that Google account is still being set up')

    const onDisk = this.inspect(this.#profileDir(id))
    if (!onDisk.signedIn) {
      profile.ready = false
      this.#save()
      this.#announce()
      return this.#public(profile)
    }
    if (onDisk.displayName) profile.displayName = onDisk.displayName

    // The files say signed in; only Meet can say whether Google still agrees.
    // Injectable so the test suite never has to open a browser.
    const live = launch ? await launch(this.#profileDir(id)) : null
    profile.ready = live === null ? true : live === true
    this.#save()
    this.#announce()
    return this.#public(profile)
  }

  remove(id) {
    const profile = this.#record(id)
    if (this.reservations.has(id)) throw new Error('that Google account is in use by a bot')
    if (this.setups.has(id)) {
      throw new Error('close its Google Chrome setup window before removing it')
    }
    const profileDir = this.#profileDir(id)
    rmSync(profileDir, { recursive: true, force: true })
    this.records = this.records.filter((candidate) => candidate !== profile)
    this.#save()
    this.#announce()
    return true
  }
}

let defaultStore = null
export const meetProfileStore = (options = {}) => (defaultStore ??= new MeetProfileStore(options))
