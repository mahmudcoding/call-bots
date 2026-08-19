import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parse } from 'yaml'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const dataDir = join(projectRoot, '.data')
export const fixturesDir = join(projectRoot, 'fixtures')
export const stateDir = join(dataDir, 'state')
export const runsDir = join(dataDir, 'runs')

export const ensureDirs = () => {
  for (const dir of [dataDir, fixturesDir, stateDir, runsDir]) {
    mkdirSync(dir, { recursive: true })
  }
}

const slugify = (label) => {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '')
  if (!slug) throw new Error(`Label "${label}" produces an empty slug`)
  return slug
}

// Loads and validates users.yaml. Fails with readable messages — this file is
// hand-maintained.
export const loadConfig = (configPath) => {
  const file = resolve(configPath ?? join(projectRoot, 'users.yaml'))
  if (!existsSync(file)) {
    throw new Error(
      `Config not found: ${file}\n` +
        `Copy users.example.yaml to users.yaml and fill in real accounts.`,
    )
  }
  let raw
  try {
    raw = parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`${file} is not valid YAML: ${error.message}`)
  }
  if (!raw || typeof raw !== 'object') throw new Error(`${file}: empty config`)

  const baseUrl = String(raw.baseUrl ?? '').replace(/\/+$/u, '')
  if (!/^https?:\/\/[^/]+$/u.test(baseUrl)) {
    throw new Error(`${file}: baseUrl must be an origin like https://airion-cargo.store`)
  }

  if (!Array.isArray(raw.users) || raw.users.length === 0) {
    throw new Error(`${file}: "users" must be a non-empty list`)
  }

  const users = raw.users.map((entry, i) => {
    const where = `${file}: users[${i}]`
    const email = String(entry?.email ?? '').trim()
    const password = String(entry?.password ?? '')
    if (!email.includes('@')) throw new Error(`${where}: invalid email "${email}"`)
    if (!password || password === 'CHANGE-ME') {
      throw new Error(`${where}: password missing (still "CHANGE-ME"?)`)
    }
    const label = String(entry?.label ?? email.split('@')[0]).trim()
    return { email, password, label, slug: slugify(label), index: i }
  })

  const seen = new Set()
  for (const user of users) {
    if (seen.has(user.slug)) {
      throw new Error(`${file}: duplicate label/slug "${user.slug}" — labels must be unique`)
    }
    seen.add(user.slug)
  }

  return {
    file,
    baseUrl,
    workspace: raw.workspace ? String(raw.workspace).trim() : null,
    users,
  }
}
