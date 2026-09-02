// Google Meet profiles hold real browser sessions, so their public surface is
// deliberately much smaller than the data Chrome keeps on disk. These checks
// pin safe metadata, atomic one-profile-per-bot reservations, and cleanup.
import { EventEmitter } from 'node:events'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MeetProfileStore, chromeHoldsProfile, inspectMeetProfile } from '../src/meet-profiles.mjs'
import { Guest } from '../src/guest.mjs'
import { meetAccountLabels } from '../src/orchestrator.mjs'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}
const throws = (fn, pattern) => {
  try { fn() } catch (error) { return pattern.test(error.message) }
  return false
}

const root = mkdtempSync(join(tmpdir(), 'call-bots-meet-profiles-'))
const launches = []
const fakeSpawn = (executable, args, options) => {
  const child = new EventEmitter()
  child.unref = () => {}
  launches.push({ executable, args, options, child })
  return child
}
const store = new MeetProfileStore({
  root,
  chromePath: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  spawnProcess: fakeSpawn,
})

const finishSetup = (setup, name, email) => {
  const profileDir = join(root, setup.id)
  mkdirSync(join(profileDir, 'Default'), { recursive: true })
  writeFileSync(join(profileDir, 'Default', 'Preferences'), JSON.stringify({
    account_info: [{ account_id: 'secret-gaia-id', email, full_name: name }],
  }))
  launches.at(-1).child.emit('exit', 0)
  return profileDir
}

try {
  console.log('\nprofile setup and safe state')
  const firstSetup = store.setup()
  check('Add account opens an isolated Chrome profile',
    firstSetup.status === 'setting-up' && launches.length === 1 &&
      launches[0].args.some((arg) => arg === `--user-data-dir=${join(root, firstSetup.id)}`))
  const firstDir = finishSetup(firstSetup, 'Meet Tester', 'tester-one@example.test')
  const first = store.list()[0]
  check('closing Chrome records the Google display name and readiness',
    first.displayName === 'Meet Tester' && first.status === 'ready', JSON.stringify(first))
  check('the profile root and metadata are private',
    (statSync(root).mode & 0o777) === 0o700 &&
      (statSync(join(root, 'profiles.json')).mode & 0o777) === 0o600)
  const publicState = JSON.stringify(store.summary())
  const metadata = readFileSync(join(root, 'profiles.json'), 'utf8')
  check('public state never exposes email, profile path, cookies, or credentials',
    !publicState.includes('tester-one@example.test') && !publicState.includes(root) &&
      !/cookie|credential|secret-gaia/iu.test(publicState), publicState)
  check('persisted metadata contains only the safe account name',
    metadata.includes('Meet Tester') && !metadata.includes('tester-one@example.test') &&
      !metadata.includes(firstDir) && !/secret-gaia/iu.test(metadata))

  const inspected = inspectMeetProfile(firstDir)
  check('profile inspection returns only sign-in state and display name',
    JSON.stringify(inspected) === '{"signedIn":true,"displayName":"Meet Tester"}',
    JSON.stringify(inspected))

  const secondSetup = store.setup()
  finishSetup(secondSetup, 'Meet Tester', 'tester-two@example.test')
  check('two signed-in profiles provide capacity for two concurrent bots',
    store.summary().available === 2)
  const duplicateProfiles = store.list()
  const localNames = meetAccountLabels(duplicateProfiles)
  check('duplicate display names receive only a local account-number suffix',
    localNames[0] === 'Meet Tester' && localNames[1] === 'Meet Tester · Google 2' &&
      duplicateProfiles.every((profile) => profile.displayName === 'Meet Tester'),
    JSON.stringify(localNames))

  console.log('\natomic reservations')
  const leases = store.reserveMany(2, 'test-batch')
  check('one distinct profile is reserved per bot',
    leases.length === 2 && leases[0].id !== leases[1].id)
  check('reserved profiles are reported in use and no longer available',
    store.summary().available === 0 && store.list().every((profile) => profile.status === 'in-use'))
  check('an insufficient batch is rejected without a partial reservation',
    throws(() => store.reserveMany(1, 'too-many'), /0 ready, 1 requested/u) &&
      store.list().filter((profile) => profile.status === 'in-use').length === 2)
  check('an in-use profile cannot be removed',
    throws(() => store.remove(leases[0].id), /in use/iu))

  leases[0].release()
  check('release makes a successful profile reusable', store.summary().available === 1)
  leases[1].markNeedsSignIn()
  leases[1].release()
  check('a signed-out profile becomes needs-sign-in after release',
    store.list().find((profile) => profile.id === leases[1].id)?.status === 'needs-sign-in')

  console.log('\nGuest teardown release paths')
  let teardownReleases = 0
  const teardownGuest = new Guest(
    { n: 1, index: 0, label: 'Meet Tester', slug: 'release-on-stop' },
    null,
    {},
    { id: 'stop', displayName: 'Meet Tester', accountNumber: 1, release: () => { teardownReleases += 1 } },
  )
  await teardownGuest.teardown()
  await teardownGuest.teardown()
  check('Stop, per-bot removal, and batch removal release a lease exactly once',
    teardownReleases === 1, String(teardownReleases))
  let failureReleases = 0
  const failedGuest = new Guest(
    { n: 2, index: 1, label: 'Meet Tester', slug: 'release-on-failure' },
    null,
    {},
    { id: 'failure', displayName: 'Meet Tester', accountNumber: 2, release: () => { failureReleases += 1 } },
  )
  await failedGuest.closeAfterFailure()
  check('a failed Meet join releases its account immediately', failureReleases === 1)

  console.log('\nremoval and restart')
  const removedDir = leases[0].userDataDir
  store.remove(leases[0].id)
  check('Remove deletes only that saved local profile',
    !statExists(removedDir) && store.list().length === 1)
  const reopened = new MeetProfileStore({
    root,
    chromePath: () => '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    spawnProcess: fakeSpawn,
  })
  check('safe profile metadata survives an app restart',
    reopened.list().length === 1 && reopened.list()[0].status === 'needs-sign-in' &&
      reopened.list()[0].displayName === 'Meet Tester')

  // Removing an account must not renumber the ones below it: a bot card names
  // its account by number while the session runs, and a shifting number would
  // point at somebody else's session mid-call.
  const numbers = new MeetProfileStore({ root, chromePath: () => '/chrome', spawnProcess: fakeSpawn })
  const kept = numbers.list()[0].number
  const added = numbers.setup()
  check('a new account takes the next free number, not the next index',
    numbers.list().find((profile) => profile.id === added.id)?.number === kept + 1,
    JSON.stringify(numbers.list()))
  numbers.remove(numbers.list()[0].id)
  check('and keeps that number after the one above it is removed',
    numbers.list()[0].number === kept + 1, JSON.stringify(numbers.list()))

  console.log('\na Chrome window somebody left open')
  // The bug this covers: the sign-in window is detached so it outlives the app,
  // but the record of it was only ever in memory. After a restart the store
  // handed a bot a profile that Chrome still held, and Playwright answered with
  // a screenful of ProcessSingleton.
  {
    const held = new Set()
    const root = mkdtempSync(join(tmpdir(), 'call-bots-meet-held-'))
    const locks = new MeetProfileStore({
      root,
      chromePath: () => '/chrome',
      spawnProcess: fakeSpawn,
      inspect: () => ({ signedIn: true, displayName: 'Lock Tester' }),
      heldByChrome: (dir) => held.has(dir),
    })
    const one = locks.setup()
    launches.at(-1).child.emit('exit', 0)
    check('an account nobody has open is ready', locks.list()[0].status === 'ready')

    // Same store, no restart needed to prove it: the setups map is empty and
    // only the lock on disk says the window is there.
    held.add(join(root, one.id))
    check('an account whose Chrome window is still open is not ready',
      locks.list()[0].status === 'signed-in', JSON.stringify(locks.list()))
    check('and is not counted towards capacity', locks.summary().available === 0)
    check('so a bot is never handed it',
      throws(() => locks.reserveMany(1), /0 ready/u))
    check('removing it says which window to close',
      throws(() => locks.remove(one.id), /close its Google Chrome window/u))

    held.delete(join(root, one.id))
    check('closing that window hands it back', locks.list()[0].status === 'ready')
    rmSync(root, { recursive: true, force: true })
  }

  // The trap in reading that lock: it is a symlink to <hostname>-<pid>, which
  // is not a real path, so existsSync() follows it, finds nothing and reports
  // no lock at all.
  {
    const root = mkdtempSync(join(tmpdir(), 'call-bots-meet-lock-'))
    check('a directory with no lock reads as free', chromeHoldsProfile(root) === false)
    symlinkSync(`somehost-${process.pid}`, join(root, 'SingletonLock'))
    check('a lock naming a live process reads as held', chromeHoldsProfile(root) === true)
    rmSync(join(root, 'SingletonLock'))
    // A pid no longer running is a lock Chrome left behind when it died; it
    // clears that itself next start, and treating it as held would strand the
    // account forever.
    symlinkSync('somehost-2147480000', join(root, 'SingletonLock'))
    check('a lock naming a dead process is ignored', chromeHoldsProfile(root) === false)
    rmSync(root, { recursive: true, force: true })
  }

  console.log('\nsign-in detection and session checks')
  // Chrome on macOS outlives its last window, so a store that waits for the
  // process to exit sits at "0 ready" forever while the user stares at a
  // finished sign-in. Readiness has to come off the profile on disk.
  const signals = []
  const live = new MeetProfileStore({
    root: mkdtempSync(join(tmpdir(), 'call-bots-meet-live-')),
    chromePath: () => '/chrome',
    spawnProcess: fakeSpawn,
    inspect: () => signedIn,
    onChange: () => signals.push(Date.now()),
  })
  let signedIn = { signedIn: false, displayName: null }
  const watched = live.setup()
  check('a fresh setup starts out not ready', live.list()[0].status === 'setting-up')
  check('opening a setup announces itself to the dashboard', signals.length >= 1)
  signedIn = { signedIn: true, displayName: 'Live Tester' }
  await new Promise((resolve) => setTimeout(resolve, 2_200))
  const watchedNow = live.list().find((profile) => profile.id === watched.id)
  check('signing in is noticed while Chrome is still open',
    watchedNow.status === 'signed-in' && watchedNow.displayName === 'Live Tester',
    JSON.stringify(watchedNow))
  check('and the dashboard is told the moment it happens', signals.length >= 2)
  // Still not reservable: real Chrome holds this profile's lock until it quits,
  // and a bot reopening it now would fail.
  check('but is not offered to a bot until that window closes',
    live.summary().available === 0, JSON.stringify(live.summary()))
  launches.at(-1).child.emit('exit', 0)
  check('closing the window makes it ready',
    live.list().find((profile) => profile.id === watched.id)?.status === 'ready')

  // Closing Call Bots must not take a half-finished sign-in with it.
  check('the sign-in window is detached from the app that opened it',
    launches.at(-1).options?.detached === true, JSON.stringify(launches.at(-1).options))
  check('and is opened in the language the bots read Meet in',
    launches.at(-1).args.includes('--lang=en-US'))

  // A spawn that never started is not a finished setup: keeping the record
  // leaves a needs-sign-in row standing over an empty directory.
  const broken = new MeetProfileStore({
    root: mkdtempSync(join(tmpdir(), 'call-bots-meet-broken-')),
    chromePath: () => '/chrome',
    spawnProcess: fakeSpawn,
    inspect: () => ({ signedIn: false, displayName: null }),
  })
  const doomed = broken.setup()
  launches.at(-1).child.emit('error', new Error('ENOENT'))
  check('a Chrome that never started leaves no account behind',
    broken.list().every((profile) => profile.id !== doomed.id), JSON.stringify(broken.list()))

  // A saved session Google has since expired looks identical on disk. Check is
  // what finds it before a batch does.
  const checks = new MeetProfileStore({
    root: mkdtempSync(join(tmpdir(), 'call-bots-meet-check-')),
    chromePath: () => '/chrome',
    spawnProcess: fakeSpawn,
    inspect: () => ({ signedIn: true, displayName: 'Check Tester' }),
  })
  const checked = checks.setup()
  launches.at(-1).child.emit('exit', 0)
  check('Check leaves a live session alone',
    (await checks.verify(checked.id, { launch: async () => true })).status === 'ready')
  check('Check demotes a session Google no longer accepts',
    (await checks.verify(checked.id, { launch: async () => false })).status === 'needs-sign-in')
  check('and a demoted account no longer counts towards capacity',
    checks.summary().available === 0, JSON.stringify(checks.summary()))
} finally {
  rmSync(root, { recursive: true, force: true })
}

function statExists(path) {
  try { statSync(path); return true } catch { return false }
}

const failed = results.filter((result) => !result.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
