import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

// Cross-platform "find/kill processes whose command line carries our marker".
// Used by `calls-sim clean` and the post-teardown sweep; process.kill works on
// Windows too (TerminateProcess under the hood).

export const findMarkedPids = async (marker) => {
  try {
    if (process.platform === 'win32') {
      const script =
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${marker}*' } ` +
        '| ForEach-Object { $_.ProcessId }'
      const { stdout } = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script])
      return stdout.split(/\r?\n/u).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0)
    }
    const { stdout } = await run('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 })
    return stdout
      .split('\n')
      .filter((line) => line.includes(marker) && !line.includes('ps -axo'))
      .map((line) => Number(line.trim().split(/\s+/u)[0]))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

export const killPids = (pids) => {
  let killed = 0
  for (const pid of pids) {
    if (pid === process.pid || pid === process.ppid) continue // never self-kill
    try {
      process.kill(pid, 'SIGKILL')
      killed += 1
    } catch {
      /* already gone or not ours */
    }
  }
  return killed
}
