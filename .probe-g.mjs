import { Roster } from './src/orchestrator.mjs'
import { resolveLink } from './src/platforms/index.mjs'
setTimeout(() => { console.log('CAP reached, exiting'); process.exit(0) }, 150_000).unref?.()
const target = resolveLink(process.argv[2])
const roster = new Roster({ baseUrl: target.origin, startCam: true, startMic: true, meetMode: 'guest', label: 'Guest' })
try {
  await roster.add(Number(process.argv[3] ?? 1), target)
  for (const g of roster.guests) {
    console.log('RESULT', g.label, '|', g.state, '|', g.lastError ? String(g.lastError).split('(url:')[0].trim().slice(0,90) : 'ok')
  }
  if (roster.guests.some((g) => g.state === 'in-call')) await new Promise((r) => setTimeout(r, 12000))
} catch (e) { console.log('threw:', String(e.message).split('(url:')[0].trim().slice(0,120)) }
finally { await roster.teardownAll() }
process.exit(0)
