import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import { promisify } from 'node:util'

const run = promisify(execFile)

// How many publishing browsers this machine can realistically carry.
// Each participant is a full Chrome encoding and decoding live video, so the
// ceiling is set by both memory and cores — whichever runs out first.
// Measured on a 16 GB / 12-core Mac: ~6 before the media itself degrades.
export const machineProfile = () => {
  const memGB = os.totalmem() / 1024 ** 3
  const cores = os.cpus().length || 4
  const byMemory = Math.floor(memGB / 2.5)
  const byCores = Math.floor(cores * 0.75)
  const recommendedMax = Math.max(2, Math.min(byMemory, byCores))
  return {
    memGB: Math.round(memGB),
    cores,
    recommendedMax,
    platform: `${os.platform()}/${os.arch()}`,
  }
}

// --- live usage -------------------------------------------------------------
// What the machine is DOING right now, to sit beside what it can carry: CPU
// busy share, memory available (the honest number — on macOS os.freemem()
// excludes purgeable and inactive pages and reads alarmingly low, so vm_stat
// is asked instead), and network throughput from interface byte counters.
// Every field degrades to null rather than ever throwing.

// CPU and network are deltas between calls, over REAL elapsed time — the
// snapshot loop pauses whenever no dashboard is listening, so a fixed cadence
// can never be assumed.
let cpuLast = null
let netLast = null

const cpuSample = () => {
  let idle = 0
  let total = 0
  for (const core of os.cpus()) {
    for (const [kind, ms] of Object.entries(core.times)) {
      total += ms
      if (kind === 'idle') idle += ms
    }
  }
  return { idle, total }
}

const cpuUsage = () => {
  const now = cpuSample()
  const before = cpuLast
  cpuLast = now
  if (!before || now.total <= before.total) return null
  const busy = 1 - (now.idle - before.idle) / (now.total - before.total)
  return Math.min(100, Math.max(0, Math.round(busy * 1000) / 10))
}

const memAvailable = async () => {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('vm_stat', [])
      const pageSize = Number(/page size of (\d+) bytes/u.exec(stdout)?.[1]) || 16384
      let pages = 0
      for (const kind of ['free', 'inactive', 'purgeable', 'speculative']) {
        pages += Number(new RegExp(`Pages ${kind}:\\s+(\\d+)`, 'u').exec(stdout)?.[1]) || 0
      }
      if (pages > 0) return pages * pageSize
    } else if (process.platform === 'linux') {
      const meminfo = await readFile('/proc/meminfo', 'utf8')
      const kb = Number(/MemAvailable:\s+(\d+) kB/u.exec(meminfo)?.[1])
      if (kb > 0) return kb * 1024
    }
  } catch {
    // The os fallback below still answers, just less generously on macOS.
  }
  return os.freemem()
}

// Cumulative received/sent bytes across PHYSICAL interfaces only. Tunnels
// and virtual devices (utun, awdl, bridges) re-carry traffic the physical
// interface already counted — with a VPN up they would double every byte —
// so only hardware-style names are summed: en*/pdp_ip* on macOS, the usual
// en/eth/wl/ww families on Linux. macOS repeats every interface once per
// address; only the Link# rows carry the hardware totals.
const PHYSICAL = { darwin: /^(?:en|pdp_ip)\d/u, linux: /^(?:en|eth|wl|ww)/u }

const netCounters = async () => {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await run('netstat', ['-ibn'], { maxBuffer: 4 * 1024 * 1024 })
      let rx = 0
      let tx = 0
      for (const line of stdout.split('\n')) {
        const cols = line.trim().split(/\s+/u)
        // The Link# marker sits in the Network column; the Address column may
        // be empty (no MAC), shifting everything after it — so the byte
        // counters are read from the row's END, which is stable either way.
        if (cols.length < 10 || !cols[2]?.startsWith('<Link#')) continue
        if (!PHYSICAL.darwin.test(cols[0])) continue
        rx += Number(cols[cols.length - 5]) || 0
        tx += Number(cols[cols.length - 2]) || 0
      }
      return { rx, tx }
    }
    if (process.platform === 'linux') {
      const dev = await readFile('/proc/net/dev', 'utf8')
      let rx = 0
      let tx = 0
      for (const line of dev.split('\n').slice(2)) {
        const [name, rest] = line.split(':')
        if (!rest || !PHYSICAL.linux.test(name.trim())) continue
        const cols = rest.trim().split(/\s+/u)
        rx += Number(cols[0]) || 0
        tx += Number(cols[8]) || 0
      }
      return { rx, tx }
    }
  } catch {
    // No counters, no throughput — the field stays null.
  }
  return null
}

const netUsage = async () => {
  const counters = await netCounters()
  if (!counters) return null
  const now = { at: Date.now(), ...counters }
  const before = netLast
  netLast = now
  if (!before || now.at <= before.at) return null
  const seconds = (now.at - before.at) / 1000
  const down = ((now.rx - before.rx) * 8) / 1000 / seconds
  const up = ((now.tx - before.tx) * 8) / 1000 / seconds
  if (down < 0 || up < 0) return null // counters reset (interface bounce)
  return { down: Math.round(down * 10) / 10, up: Math.round(up * 10) / 10 }
}

// Snapshot assembly can fire in bursts (several broadcasts back to back), so
// one sample is shared for a moment rather than shelling out per caller.
const SYSTEM_TTL_MS = 900
let systemCache = { at: 0, value: null, inFlight: null }

export const systemUsage = async () => {
  const now = Date.now()
  if (systemCache.value && now - systemCache.at < SYSTEM_TTL_MS) return systemCache.value
  if (systemCache.inFlight) return systemCache.inFlight
  systemCache.inFlight = (async () => {
    const [avail, net] = await Promise.all([memAvailable(), netUsage()])
    const value = {
      cpu: cpuUsage(),
      mem: { total: os.totalmem(), avail },
      net,
    }
    systemCache = { at: Date.now(), value, inFlight: null }
    return value
  })().catch(() => {
    systemCache = { at: Date.now(), value: null, inFlight: null }
    return null
  })
  return systemCache.inFlight
}

export const concurrencyWarning = (count, profile = machineProfile()) => {
  if (count <= profile.recommendedMax) return null
  return (
    `${count} participants — above about ${profile.recommendedMax} publishing at once, ` +
    `CPU contention can degrade the media itself on this machine ` +
    `(${profile.memGB} GB RAM, ${profile.cores} cores).`
  )
}
