import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'

import { UPDATE, sparkleDownloadUrl } from './update-config.mjs'

export const sha256File = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export const prepareSparkle = async (cacheDir, step = () => {}) => {
  mkdirSync(cacheDir, { recursive: true })
  const archive = join(cacheDir, `Sparkle-${UPDATE.sparkleVersion}.tar.xz`)

  if (existsSync(archive) && (await sha256File(archive)) !== UPDATE.sparkleSha256) {
    rmSync(archive)
  }
  if (!existsSync(archive)) {
    step(`downloading Sparkle ${UPDATE.sparkleVersion}`)
    const partial = `${archive}.part`
    execFileSync(
      'curl',
      [
        '--fail', '--location', '--retry', '5', '--retry-all-errors',
        '--continue-at', '-', '--output', partial, sparkleDownloadUrl(),
      ],
      { stdio: 'inherit' },
    )
    if ((await sha256File(partial)) !== UPDATE.sparkleSha256) {
      rmSync(partial)
      throw new Error('Sparkle checksum mismatch after download')
    }
    renameSync(partial, archive)
  } else {
    step(`using cached Sparkle ${UPDATE.sparkleVersion}`)
  }

  const actualHash = await sha256File(archive)
  if (actualHash !== UPDATE.sparkleSha256) {
    rmSync(archive)
    throw new Error(
      `Sparkle checksum mismatch: expected ${UPDATE.sparkleSha256}, got ${actualHash}`,
    )
  }

  const root = join(cacheDir, `sparkle-${UPDATE.sparkleVersion}`)
  const framework = join(root, 'Sparkle.framework')
  const generateAppcast = join(root, 'bin', 'generate_appcast')
  const generateKeys = join(root, 'bin', 'generate_keys')
  const signUpdate = join(root, 'bin', 'sign_update')

  if (![framework, generateAppcast, generateKeys, signUpdate].every(existsSync)) {
    step(`extracting Sparkle ${UPDATE.sparkleVersion}`)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
    execFileSync('tar', ['-xJf', archive, '-C', root], { stdio: 'pipe' })
  }

  return { framework, generateAppcast, generateKeys, root, signUpdate }
}
