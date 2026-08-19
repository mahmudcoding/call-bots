import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const COLORS = [36, 33, 35, 32, 34, 31, 96, 93, 95, 92]
const useColor = process.stdout.isTTY

const stamp = () => new Date().toISOString().slice(11, 19)

// The dashboard subscribes here to stream every log line over SSE.
const listeners = new Set()
export const onLog = (listener) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const emit = (entry) => {
  for (const listener of listeners) {
    try {
      listener(entry)
    } catch {
      /* a broken listener must not break logging */
    }
  }
}

export const mkLogger = (label, index = 0) => {
  const color = COLORS[index % COLORS.length]
  const prefix = useColor ? `[${color}m[${label}][0m` : `[${label}]`
  const line = (level, args) => {
    const text = args
      .map((value) => (typeof value === 'string' ? value : JSON.stringify(value)))
      .join(' ')
    emit({ at: Date.now(), label, level, text })
    const method = level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'
    const levelTag = level === 'info' ? '' : ` ${level.toUpperCase()}`
    console[method](`${stamp()} ${prefix}${levelTag}`, ...args)
  }
  return {
    info: (...args) => line('info', args),
    warn: (...args) => line('warn', args),
    error: (...args) => line('error', args),
  }
}

export const plain = mkLogger('calls-sim')

// Saves a screenshot for a failed wait so every failure is diagnosable:
// selector + page URL + screenshot path all end up in the thrown message.
export const failureShot = async (page, runDir, label, name) => {
  try {
    mkdirSync(runDir, { recursive: true })
    const file = join(runDir, `${label}-${name}-${Date.now()}.png`)
    await page.screenshot({ path: file, timeout: 5000 })
    return file
  } catch {
    return null
  }
}
