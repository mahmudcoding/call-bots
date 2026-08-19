import { createInterface } from 'node:readline'

const HELP = `commands:
  status                     roster + verifier tile check + server participant count
  mute <n|all>               mute user n (1-based) or everyone
  unmute <n|all>             unmute
  cam <n|all> <on|off>       camera on/off
  share <n> [stop]           start/stop screen share (experimental)
  leave <n>                  user leaves the call
  rejoin <n>                 user joins again
  shot [n]                   save screenshot(s) into the run dir
  help                       this text
  quit                       everyone leaves, browsers close, exit`


export const startRepl = (roster) =>
  new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.setPrompt('calls-sim> ')

    const pick = (token) => {
      if (token === 'all') return roster.simUsers
      const index = Number(token)
      if (!Number.isInteger(index) || index < 1 || index > roster.simUsers.length) {
        console.log(`no such user "${token}" — use 1..${roster.simUsers.length} or "all"`)
        return []
      }
      return [roster.simUsers[index - 1]]
    }

    const commands = {
      help: async () => console.log(HELP),
      status: async () => console.log(await roster.statusTable()),
      mute: async ([who]) => {
        for (const sim of pick(who)) console.log(`${sim.label}: mic ${await sim.setMic(false)}`)
      },
      unmute: async ([who]) => {
        for (const sim of pick(who)) console.log(`${sim.label}: mic ${await sim.setMic(true)}`)
      },
      cam: async ([who, value]) => {
        if (value !== 'on' && value !== 'off') return console.log('usage: cam <n|all> <on|off>')
        for (const sim of pick(who)) {
          console.log(`${sim.label}: camera ${await sim.setCam(value === 'on')}`)
        }
      },
      share: async ([who, value]) => {
        for (const sim of pick(who)) {
          console.log(`${sim.label}: share ${await sim.setShare(value !== 'stop')}`)
        }
      },
      leave: async ([who]) => {
        for (const sim of pick(who)) {
          await sim.leaveCall()
          console.log(`${sim.label}: ${sim.state}`)
        }
      },
      rejoin: async ([who]) => {
        for (const sim of pick(who)) {
          try {
            await sim.ensureLoggedIn(`/w/${roster.wsId}/call/${roster.callId}`)
            await sim.joinCall(roster.wsId, roster.callId)
            console.log(`${sim.label}: ${sim.state}`)
          } catch (error) {
            console.log(error.message)
          }
        }
      },
      shot: async ([who]) => {
        for (const sim of who ? pick(who) : roster.simUsers) {
          console.log(`${sim.label}: ${await sim.shot()}`)
        }
      },
    }

    rl.on('line', (line) => {
      const [cmd, ...args] = line.trim().split(/\s+/u).filter(Boolean)
      const finish = () => rl.prompt()
      if (!cmd) return finish()
      if (cmd === 'quit' || cmd === 'exit') {
        rl.close()
        return
      }
      const handler = commands[cmd]
      if (!handler) {
        console.log(`unknown command "${cmd}" — try "help"`)
        return finish()
      }
      handler(args)
        .catch((error) => console.log(`error: ${error.message}`))
        .finally(finish)
    })

    rl.on('close', () => resolve())
    console.log('\ninteractive console ready — type "help" for commands, "quit" to end\n')
    rl.prompt()
  })
