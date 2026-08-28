// Proves the LiveKit-native codec switch (__botLkSwitch__) against real
// RTCPeerConnections and a faithful fake of livekit-client's LocalParticipant —
// the exact semantics the bugs lived in (ALK-3724): publishTrack overwrites
// track.sender and tolerates duplicate publications of one source, unpublish
// only turns the old transceiver 'inactive'. No media needs to flow:
// everything under test is structural — which senders exist, which are
// stopped, what currentDirection says — so the loopback negotiates
// descriptions only and never exchanges ICE.
//
// What this pins:
//   - a switch republishes exactly one publication and sweeps the leftover
//     its own unpublish parked on the connection;
//   - duplicate publications of one source all go out with the switch;
//   - a stray sender still encoding (the double-ladder case) is detached and
//     stopped, while backup-codec senders and publishes in flight survive;
//   - a publish that half-fails (sender created, then the throw) is healed by
//     the fallback, and its abandoned sender does not outlive the switch;
//   - a capture that degraded is restored to its constrained size before the
//     republish, so the new ladder is built from full height;
//   - concurrent switch calls run one at a time.
//
//   node scripts/test-lkswitch.mjs
import { chromium } from 'playwright'

import { CODEC_SHIM_PATH, launchChannel } from '../src/browser.mjs'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const ORIGIN = 'https://lkswitch.test'

// The fake room lives entirely in the page. It mirrors the livekit-client
// behaviours the switch depends on — including the ones the bugs came from —
// and records what a real Room cannot be asked about (publish concurrency,
// restart calls).
const PAGE = `<!doctype html>
<meta charset="utf-8">
<title>lkswitch fixture</title>
<script>
window.__setup = async () => {
  const pc = new RTCPeerConnection()
  const answerer = new RTCPeerConnection()

  // Description-only loopback: currentDirection settles on setLocal/setRemote
  // completing, which is all the sweep reads. Serialized by the callers.
  const negotiate = async () => {
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    await answerer.setRemoteDescription(offer)
    const answer = await answerer.createAnswer()
    await answerer.setLocalDescription(answer)
    await pc.setRemoteDescription(answer)
  }

  const grab = async (constraints) => {
    const stream = await navigator.mediaDevices.getUserMedia({ video: constraints })
    return stream.getVideoTracks()[0]
  }

  // The slice of LocalVideoTrack the switch touches. restartTrack re-acquires
  // at the track's own constraints, like the real one.
  const localTrack = (mst, constraints) => ({
    mediaStreamTrack: mst,
    constraints,
    sender: undefined,
    simulcastCodecs: new Map(),
    restarts: 0,
    async restartTrack() {
      this.restarts += 1
      this.mediaStreamTrack = await grab(this.constraints)
    },
  })

  let sid = 0
  const state = {
    failNextPublish: false,
    publishDelayMs: 0,
    publishing: 0,
    maxConcurrentPublish: 0,
  }
  const participant = {
    trackPublications: new Map(),
    pendingPublishPromises: new Map(),
    async publishTrack(track, opts) {
      const work = (async () => {
        state.publishing += 1
        state.maxConcurrentPublish = Math.max(state.maxConcurrentPublish, state.publishing)
        try {
          if (state.publishDelayMs) await new Promise((r) => setTimeout(r, state.publishDelayMs))
          const transceiver = pc.addTransceiver(track.mediaStreamTrack, { direction: 'sendonly' })
          track.sender = transceiver.sender
          if (state.failNextPublish) {
            // The half-failed publish: the sender exists and holds the track,
            // the negotiation never ran, the publication never registered.
            state.failNextPublish = false
            throw new Error('AddTrackRequest timed out (fixture)')
          }
          const publication = {
            source: opts.source,
            track,
            trackSid: 'TR_' + (sid += 1),
            options: opts,
          }
          participant.trackPublications.set(publication.trackSid, publication)
          await negotiate()
          return publication
        } finally {
          state.publishing -= 1
        }
      })()
      participant.pendingPublishPromises.set(track, work)
      try {
        return await work
      } finally {
        participant.pendingPublishPromises.delete(track)
      }
    },
    async unpublishTrack(track) {
      const entry = [...participant.trackPublications.entries()].find(([, p]) => p.track === track)
      if (!entry) return undefined
      const [key, publication] = entry
      const sender = track.sender
      track.sender = undefined
      if (sender) {
        for (const transceiver of pc.getTransceivers()) {
          if (transceiver.sender === sender) transceiver.direction = 'inactive'
        }
        try { pc.removeTrack(sender) } catch {}
      }
      participant.trackPublications.delete(key)
      await negotiate()
      return publication
    },
  }

  const room = { state: 'connected', localParticipant: participant, options: {} }
  // findRoom walks React fibers; hand it one of the shapes it accepts.
  document.body['__reactFiber$fixture'] = { stateNode: room }

  window.__fx = {
    pc, answerer, negotiate, grab, localTrack, participant, state, room,
    // Everything still able to send video on the publisher connection.
    liveVideoSenders: () =>
      pc.getTransceivers().filter(
        (t) => !t.stopped && t.sender?.track && t.sender.track.readyState === 'live'
          && t.sender.track.kind === 'video',
      ).length,
    unstopped: () => pc.getTransceivers().filter((t) => !t.stopped).length,
  }
  return true
}
</script>`

const browser = await chromium.launch({
  channel: launchChannel(),
  headless: true,
  args: [
    '--use-fake-device-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
  ],
})
try {
  const context = await browser.newContext()
  await context.grantPermissions(['camera', 'microphone'], { origin: ORIGIN })
  await context.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: PAGE }),
  )
  // The same two-step injection browser.mjs performs, with no launch codecs.
  await context.addInitScript((prefs) => {
    window.__botCodecInit__ = prefs
  }, {})
  await context.addInitScript({ path: CODEC_SHIM_PATH })
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/`)
  await page.evaluate(() => window.__setup())

  console.log('\na plain switch')
  const first = await page.evaluate(async () => {
    const fx = window.__fx
    const camera = fx.localTrack(await fx.grab({ width: { ideal: 640 }, height: { ideal: 360 } }), {
      width: { ideal: 640 },
      height: { ideal: 360 },
    })
    fx.camera = camera
    await fx.participant.publishTrack(camera, { source: 'camera' })
    const result = await window.__botLkSwitch__('video', 'vp9')
    return {
      result,
      pubs: fx.participant.trackPublications.size,
      liveSenders: fx.liveVideoSenders(),
    }
  })
  check('the switch succeeds and one publication remains',
    first.result?.ok === true && first.pubs === 1, JSON.stringify(first.result))
  check('exactly one sender is left encoding', first.liveSenders === 1, `live=${first.liveSenders}`)
  check('the unpublish leftover is swept as routine, not as an incident',
    first.result?.swept?.dead === 1 && first.result?.swept?.live === 0,
    `swept=${JSON.stringify(first.result?.swept)}`)
  check('a full-size capture is not restarted', first.result?.restored === false)

  console.log('\nduplicate publications of one source')
  const dupes = await page.evaluate(async () => {
    const fx = window.__fx
    // The mishap bug 1 leaves behind: a second full publication of the camera.
    const stray = fx.localTrack(fx.camera.mediaStreamTrack.clone(), fx.camera.constraints)
    await fx.participant.publishTrack(stray, { source: 'camera' })
    const before = fx.participant.trackPublications.size
    const result = await window.__botLkSwitch__('video', 'vp8')
    return {
      before,
      result,
      pubs: fx.participant.trackPublications.size,
      liveSenders: fx.liveVideoSenders(),
    }
  })
  check('both camera publications existed before the switch', dupes.before === 2)
  check('the switch collapses them to one',
    dupes.result?.ok === true && dupes.pubs === 1 && dupes.liveSenders === 1,
    JSON.stringify({ pubs: dupes.pubs, live: dupes.liveSenders }))

  console.log('\na stray sender still encoding')
  const stray = await page.evaluate(async () => {
    const fx = window.__fx
    // The double-ladder case: a sender no publication owns, negotiated and
    // holding a live track — encoding on the wire, invisible to unpublish.
    const orphan = fx.pc.addTransceiver(fx.camera.mediaStreamTrack.clone(), {
      direction: 'sendonly',
    })
    await fx.negotiate()
    const result = await window.__botLkSwitch__('video', 'vp9')
    return {
      result,
      orphanStopped: orphan.stopped === true || orphan.currentDirection === 'stopped',
      orphanTrack: orphan.sender?.track === null,
      liveSenders: fx.liveVideoSenders(),
      pubs: fx.participant.trackPublications.size,
    }
  })
  check('the stray is detached and stopped',
    stray.orphanStopped && stray.liveSenders === 1 && stray.pubs === 1,
    JSON.stringify(stray))
  check('the sweep counted it as a live stray',
    stray.result?.swept?.live === 1 && (stray.result?.swept?.dead ?? 0) >= 1,
    `swept=${JSON.stringify(stray.result?.swept)}`)

  console.log('\nwhat the sweep must never touch')
  const protectedOnes = await page.evaluate(async () => {
    const fx = window.__fx
    // A backup-codec sender beside the camera (multi-codec simulcast, the
    // VP9+H264 pair Aloqa publishes by design) …
    const backupTransceiver = fx.pc.addTransceiver(fx.camera.mediaStreamTrack.clone(), {
      direction: 'sendonly',
    })
    fx.camera.simulcastCodecs.set('h264', { sender: backupTransceiver.sender })
    await fx.negotiate()
    // … and a screen share of its own, which is what gets switched.
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 180
    canvas.getContext('2d').fillRect(0, 0, 8, 8)
    const screenTrack = canvas.captureStream(5).getVideoTracks()[0]
    const screen = fx.localTrack(screenTrack, {})
    await fx.participant.publishTrack(screen, { source: 'screen_share' })
    const result = await window.__botLkSwitch__('screen', 'vp8')
    const backupAlive =
      !backupTransceiver.stopped &&
      backupTransceiver.sender.track !== null &&
      backupTransceiver.sender.track.readyState === 'live'
    fx.camera.simulcastCodecs.clear()
    if (backupAlive) {
      backupTransceiver.sender.replaceTrack(null)
      backupTransceiver.stop()
      await fx.negotiate()
    }
    return { result, backupAlive, pubs: fx.participant.trackPublications.size }
  })
  check('a screen switch leaves the camera\'s backup-codec sender alone',
    protectedOnes.result?.ok === true && protectedOnes.backupAlive && protectedOnes.pubs === 2,
    JSON.stringify(protectedOnes))

  const bystander = await page.evaluate(async () => {
    const fx = window.__fx
    // A connection that is not the publisher — the subscriber pc in a real
    // call. Its transceiver is negotiated, unowned and stray-shaped, and the
    // sweep must still never reach across to it: its m-lines belong to the
    // far side's plan.
    const other = new RTCPeerConnection()
    const otherAnswerer = new RTCPeerConnection()
    other.addTransceiver(fx.camera.mediaStreamTrack.clone(), { direction: 'sendonly' })
    const offer = await other.createOffer()
    await other.setLocalDescription(offer)
    await otherAnswerer.setRemoteDescription(offer)
    const answer = await otherAnswerer.createAnswer()
    await otherAnswerer.setLocalDescription(answer)
    await other.setRemoteDescription(answer)
    const result = await window.__botLkSwitch__('video', 'vp8')
    const t = other.getTransceivers()[0]
    const untouched =
      !t.stopped && t.sender.track !== null && t.sender.track.readyState === 'live'
    t.sender.track.stop()
    other.close()
    otherAnswerer.close()
    return { result, untouched }
  })
  check('the sweep never reaches a connection that is not the publisher',
    bystander.result?.ok === true && bystander.untouched, JSON.stringify(bystander))

  console.log('\na publish that half-fails')
  const halfFailed = await page.evaluate(async () => {
    const fx = window.__fx
    fx.state.failNextPublish = true
    const result = await window.__botLkSwitch__('video', 'h264')
    return {
      result,
      pubs: fx.participant.trackPublications.size,
      liveSenders: fx.liveVideoSenders(),
    }
  })
  check('the failure is reported and the fallback republishes',
    halfFailed.result?.ok === false && halfFailed.pubs === 2,
    JSON.stringify({ ok: halfFailed.result?.ok, pubs: halfFailed.pubs }))
  check('the abandoned sender does not outlive the switch',
    halfFailed.liveSenders === 2 && (halfFailed.result?.swept?.live ?? 0) >= 1,
    JSON.stringify({ live: halfFailed.liveSenders, swept: halfFailed.result?.swept }))

  console.log('\na degraded capture')
  const degraded = await page.evaluate(async () => {
    const fx = window.__fx
    // A camera that sank under CPU pressure: capturing 320x180 against
    // constraints that ask for 640x360.
    const low = fx.localTrack(await fx.grab({ width: { exact: 320 }, height: { exact: 180 } }), {
      width: { ideal: 640 },
      height: { ideal: 360 },
    })
    // Clean room: take the previous camera out first.
    await fx.participant.unpublishTrack(fx.camera)
    await fx.participant.publishTrack(low, { source: 'camera' })
    const before = low.mediaStreamTrack.getSettings()
    const result = await window.__botLkSwitch__('video', 'vp9')
    const after = low.mediaStreamTrack.getSettings()
    const again = await window.__botLkSwitch__('video', 'vp8')
    return { result, again, before, after, restarts: low.restarts }
  })
  check('the capture is restored to its constrained size before republishing',
    degraded.result?.restored === true && degraded.restarts === 1 &&
      degraded.before.width === 320 && degraded.after.width === 640,
    JSON.stringify({ before: degraded.before, after: degraded.after }))
  check('a healthy capture is left alone on the next switch',
    degraded.again?.ok === true && degraded.again?.restored === false && degraded.restarts === 1)

  const restoreFailed = await page.evaluate(async () => {
    const fx = window.__fx
    // livekit-client stops the old capture BEFORE re-acquiring, so a restore
    // that throws leaves the bot holding a dead track. The switch must still
    // publish (never leave a bot unpublished) and must say what happened,
    // rather than letting a dark bot be rediscovered from the outside.
    const pub = [...fx.participant.trackPublications.values()].find((p) => p.source === 'camera')
    const track = pub.track
    await track.mediaStreamTrack.applyConstraints({ width: 320, height: 180 })
    track.restartTrack = async () => {
      throw new Error('device is gone')
    }
    const result = await window.__botLkSwitch__('video', 'h264')
    return { result, pubs: fx.participant.trackPublications.size }
  })
  check('a restore that fails is reported and the switch still publishes',
    restoreFailed.result?.ok === true && restoreFailed.result?.restored === false &&
      /device is gone/u.test(restoreFailed.result?.restoreError ?? '') &&
      restoreFailed.pubs === 2,
    JSON.stringify(restoreFailed.result))

  console.log('\nconcurrent switches')
  const raced = await page.evaluate(async () => {
    const fx = window.__fx
    fx.state.maxConcurrentPublish = 0
    fx.state.publishDelayMs = 120
    const [a, b] = await Promise.all([
      window.__botLkSwitch__('video', 'vp8'),
      window.__botLkSwitch__('video', 'vp9'),
    ])
    fx.state.publishDelayMs = 0
    return {
      a, b,
      maxConcurrent: fx.state.maxConcurrentPublish,
      pubs: fx.participant.trackPublications.size,
      liveSenders: fx.liveVideoSenders(),
    }
  })
  check('two switches fired together run one at a time',
    raced.maxConcurrent === 1 && raced.a?.ok === true && raced.b?.ok === true,
    `maxConcurrent=${raced.maxConcurrent}`)
  check('and leave one camera publication beside the standing screen share',
    raced.pubs === 2 && raced.liveSenders === 2,
    JSON.stringify({ pubs: raced.pubs, live: raced.liveSenders }))

  console.log('\nthe connection after everything')
  const finale = await page.evaluate(() => {
    const fx = window.__fx
    return { unstopped: fx.unstopped(), liveSenders: fx.liveVideoSenders() }
  })
  // Two live publications (camera + screen) and the answerer's mirrored
  // recvonly rows never grow: every dead transceiver the day produced is gone.
  check('no dead transceivers accumulate across the whole run',
    finale.unstopped === finale.liveSenders,
    JSON.stringify(finale))
} finally {
  await browser.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
