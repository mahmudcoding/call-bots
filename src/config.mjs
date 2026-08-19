import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// The .app points writable state at a user-owned folder; without the env var
// everything stays inside the project.
export const baseDir = process.env.CALL_BOTS_HOME
  ? resolve(process.env.CALL_BOTS_HOME)
  : projectRoot
export const dataDir = join(baseDir, '.data')
export const fixturesDir = join(baseDir, 'fixtures')
export const runsDir = join(dataDir, 'runs')

export const ensureDirs = () => {
  for (const dir of [dataDir, fixturesDir, runsDir]) mkdirSync(dir, { recursive: true })
}
