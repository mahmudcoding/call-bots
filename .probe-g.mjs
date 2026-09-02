import { Roster } from './src/orchestrator.mjs'
import { resolveLink } from './src/platforms/index.mjs'
setTimeout(() => { console.log('CAP reached, exiting'); process.exit(0) }, 75_000).unref?.()
const target = resolveLink(process.argv[2])
const roster = new Roster({ baseUrl: target.origin, startCam: true, startMic: true, meetMode: 'guest', label: 'Guest' })
try {
  await roster.add(1, target)
  const g = roster.guests[0]
  console.log('RESULT', g.state, '|', g.lastError ? String(g.lastError).split('(url:')[0].trim().slice(0,110) : 'ok')
  if (g.state === 'in-call') console.log('   mic', await g.micState(), 'cam', await g.camState())
} catch (e) { console.log('threw:', String(e.message).split('(url:')[0].trim().slice(0,120)) }
finally { await roster.teardownAll() }
process.exit(0)
