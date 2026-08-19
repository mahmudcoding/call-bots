// One-shot setup for a fresh machine: scaffolds users.yaml and runs doctor.
import { copyFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const { projectRoot } = await import('../src/config.mjs')
const { runDoctor } = await import('../src/doctor.mjs')

const configFile = join(projectRoot, 'users.yaml')
if (!existsSync(configFile)) {
  copyFileSync(join(projectRoot, 'users.example.yaml'), configFile)
  console.log(`created ${configFile} — edit it with real staging accounts (shared QA password)\n`)
} else {
  console.log(`users.yaml already present\n`)
}

const healthy = await runDoctor(null)
process.exit(healthy ? 0 : 1)
