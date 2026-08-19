// One-shot setup for a fresh machine: scaffolds users.yaml and runs doctor.
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const { projectRoot, resolveConfigPath } = await import('../src/config.mjs')
const { runDoctor } = await import('../src/doctor.mjs')

const configFile = resolveConfigPath(null)
if (!existsSync(configFile)) {
  mkdirSync(dirname(configFile), { recursive: true })
  copyFileSync(join(projectRoot, 'users.example.yaml'), configFile)
  console.log(`created ${configFile} — edit it with real staging accounts (shared QA password)\n`)
} else {
  console.log(`config already present: ${configFile}\n`)
}

const healthy = await runDoctor(null)
process.exit(healthy ? 0 : 1)
