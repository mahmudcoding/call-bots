import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// One home for clips and run data, whether the app, the CLI or a script is
// asking — otherwise imported videos land where nothing looks for them.
const defaultHome = () => {
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support/CallBots')
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData/Roaming'), 'CallBots')
  }
  return join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local/share'), 'call-bots')
}

export const baseDir = process.env.CALL_BOTS_HOME ? resolve(process.env.CALL_BOTS_HOME) : defaultHome()
export const dataDir = join(baseDir, '.data')
export const fixturesDir = join(baseDir, 'fixtures')
export const runsDir = join(dataDir, 'runs')

export const ensureDirs = () => {
  for (const dir of [dataDir, fixturesDir, runsDir]) mkdirSync(dir, { recursive: true })
}
