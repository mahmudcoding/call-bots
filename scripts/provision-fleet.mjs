// Provision N dedicated staging accounts for the calls simulator.
//   register (product API) -> verify email (one exact-ID SQL UPDATE) -> login check
// Idempotent and resumable via .data/fleet-manifest.json. Credentials come from
// a gitignored provision.env. Workspace membership is a separate app feature.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import pg from 'pg'
import { stringify } from 'yaml'

import { ApiSession, errorReason } from '../src/httpApi.mjs'

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const manifestPath = join(projectRoot, '.data', 'fleet-manifest.json')

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const COUNT = Number(arg('count', '10'))
const PACE_MS = Number(arg('pace', '1500'))
const PASSWORD = 'password'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const stamp = () => new Date().toISOString().slice(11, 19)
const log = (...a) => console.log(stamp(), ...a)

// user1@aloqa.calls / "Call User 1" / label "User 1"
const fleetUser = (n) => ({
  n,
  email: `user${n}@aloqa.calls`,
  name: `Call User ${n}`,
  label: `User ${n}`,
})

const loadEnv = () => {
  const file = join(projectRoot, 'provision.env')
  if (!existsSync(file)) {
    throw new Error('provision.env not found — it holds staging DB/API credentials (gitignored)')
  }
  const env = {}
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/u)
    if (m && !line.trimStart().startsWith('#')) env[m[1]] = m[2]
  }
  return env
}

const readManifest = () => {
  if (existsSync(manifestPath)) {
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch {
      /* fall through to fresh */
    }
  }
  return { registered: {}, verified: false, loginOk: {} }
}
const writeManifest = (m) => {
  mkdirSync(dirname(manifestPath), { recursive: true })
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`)
}

const main = async () => {
  const env = loadEnv()
  const apiBase = env.API_BASE ?? 'https://airion-cargo.store/stg/api/v1'
  const users = Array.from({ length: COUNT }, (_, i) => fleetUser(i + 1))
  const manifest = readManifest()

  // 1. Register through the product endpoint --------------------------------
  log(`registering ${users.length} account(s) at ${apiBase}`)
  const api = new ApiSession(apiBase)
  let created = 0
  let existed = 0
  for (const user of users) {
    if (manifest.registered[user.email]) {
      existed += 1
      continue
    }
    const res = await api.post('/auth/register/user', {
      name: user.name,
      email: user.email,
      password: PASSWORD,
      repeat_password: PASSWORD,
      language: 'en',
    })
    const key = res.body?.key
    if (res.ok) {
      manifest.registered[user.email] = res.body?.id ?? true
      created += 1
    } else if (key === 'AUTH_EMAIL_ALREADY_EXISTS') {
      manifest.registered[user.email] = manifest.registered[user.email] ?? 'existing'
      existed += 1
    } else if (key === 'AUTH_VERIFICATION_EMAIL_NOT_SENT') {
      // account row is created; only the (undeliverable) email failed
      manifest.registered[user.email] = res.body?.id ?? 'created-unsent'
      created += 1
    } else {
      log(`  ! ${user.email}: ${errorReason(res.body, res.status)}`)
    }
    if (created % 10 === 0 && created) {
      writeManifest(manifest)
      log(`  registered ${created} new (${existed} already existed)…`)
    }
    await sleep(PACE_MS)
  }
  writeManifest(manifest)
  log(`register done: ${created} new, ${existed} pre-existing`)

  // 2. Verify emails — the only direct DB write ------------------------------
  const emails = users.map((u) => u.email)
  const client = new pg.Client({
    host: env.PGHOST,
    port: Number(env.PGPORT ?? 5433),
    user: env.PGUSER,
    password: env.PGPASSWORD,
    database: env.PGDATABASE ?? 'auth_db',
    ssl: { rejectUnauthorized: false },
  })
  await client.connect()
  try {
    const res = await client.query(
      'UPDATE users SET email_verified = TRUE WHERE email = ANY($1::text[]) AND email_verified = FALSE',
      [emails],
    )
    log(`email_verified flipped for ${res.rowCount} account(s)`)
    const present = await client.query(
      'SELECT count(*)::int AS n FROM users WHERE email = ANY($1::text[])',
      [emails],
    )
    log(`accounts present in auth_db: ${present.rows[0].n}/${users.length}`)
    manifest.verified = true
    writeManifest(manifest)
  } finally {
    await client.end()
  }

  // 3. Login check -----------------------------------------------------------
  log('verifying logins…')
  let loginOk = 0
  for (const user of users) {
    const session = new ApiSession(apiBase)
    const result = await session.login(user.email, PASSWORD)
    manifest.loginOk[user.email] = result.ok
    if (result.ok) loginOk += 1
    else log(`  ! login ${user.email}: ${result.reason}`)
    await sleep(300)
  }
  writeManifest(manifest)
  log(`logins ok: ${loginOk}/${users.length}`)

  // 4. Emit config -----------------------------------------------------------
  // Carry over a joined workspace only when users.yaml is already a fleet file
  // (re-run case); converting from the lane file must drop its stale workspace.
  const existingWorkspace = (() => {
    const p = join(projectRoot, 'users.yaml')
    if (!existsSync(p)) return null
    const text = readFileSync(p, 'utf8')
    if (!text.includes('@aloqa.calls')) return null
    const m = text.match(/^workspace:\s*(\S+)/mu)
    return m ? m[1] : null
  })()
  const config = {
    baseUrl: 'https://airion-cargo.store',
    ...(existingWorkspace ? { workspace: existingWorkspace } : {}),
    users: users.map((u) => ({ email: u.email, password: PASSWORD, label: u.label })),
  }
  const yaml =
    `# ${users.length} dedicated calls-sim accounts (provisioned ${new Date().toISOString().slice(0, 10)}).\n` +
    `# Gitignored. Join them to a workspace from the app's Workspace panel.\n\n` +
    stringify(config)
  writeFileSync(join(projectRoot, 'users.yaml'), yaml)
  log(`wrote users.yaml (${users.length} users)`)

  const appConfig = join(
    process.env.HOME,
    'Library/Application Support/AloqaCallsSim/users.yaml',
  )
  if (existsSync(dirname(appConfig))) {
    writeFileSync(appConfig, yaml)
    log(`updated app config ${appConfig}`)
  }

  log(loginOk === users.length ? 'PROVISION COMPLETE ✓' : `done with ${users.length - loginOk} login failures`)
}

main().catch((error) => {
  console.error(`\nprovision failed: ${error.message}`)
  process.exit(1)
})
