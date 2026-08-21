// Proves the per-bot stream monitor pipeline against real WebRTC, no call
// platform needed. Two pages in one context play a call over a BroadcastChannel:
// the "bot" page holds one bidirectional peer connection (sending its fake
// camera and mic, receiving the peer's) — the shape a real bot is in — and the
// peer page is the other participant. A same-page loopback would not do: the
// receiver track inherits the sender track's id (msid), so sent and received
// streams collide on one track id and participant naming becomes a coin toss
// that no real call ever has.
//
// The peer connection exists BEFORE the monitor is injected, exactly like a
// bot that just reached a call. What this pins:
//   - late injection captures pre-existing peer connections (the bot page
//     polls getStats() once a second, as LiveKit does — that polling is the hook);
//   - the injected overlay is minimised and hidden, and installing twice does
//     not toggle it back (re-running the monitor's IIFE is a toggle);
//   - the summary counts distinct tracks per kind and direction;
//   - the snapshot ships participant names (Aloqa-style tile markup) and never
//     ships the heavy per-stream `raw` stats.
//
//   node scripts/test-rtc.mjs
import { chromium } from 'playwright'

import { CAPTURE_SHIM_PATH, CODEC_SHIM_PATH, launchChannel } from '../src/browser.mjs'
import { installMonitor, rtcSnapshot, rtcSummary } from '../src/rtc.mjs'

const results = []
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`)
}

const ORIGIN = 'https://rtc.test'

// Aloqa-shaped markup: a local tile named "Bot 1" holding the camera preview,
// a remote tile named "Alice" holding the received video and audio. The
// monitor's naming stack resolves both through the participant-tile contract.
const BOT_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>rtc fixture — bot</title>
<div data-testid="participant-tile" data-local="true">
  <div data-testid="participant-name">Bot 1</div>
  <video id="preview" autoplay muted playsinline></video>
</div>
<div data-testid="participant-tile" data-local="false">
  <div data-testid="participant-name">Alice</div>
  <video id="remoteVideo" autoplay muted playsinline></video>
  <audio id="remoteAudio" autoplay></audio>
</div>
<script>
(async () => {
  const media = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 360 }, audio: true,
  })
  document.getElementById('preview').srcObject = media
  const pc = new RTCPeerConnection()
  for (const track of media.getTracks()) pc.addTrack(track, media)
  pc.ontrack = (e) => {
    const el = document.getElementById(e.track.kind === 'video' ? 'remoteVideo' : 'remoteAudio')
    el.srcObject = new MediaStream([e.track])
    el.play().catch(() => {})
  }
  const bus = new BroadcastChannel('rtc-fixture')
  pc.onicecandidate = (e) => {
    if (e.candidate) bus.postMessage({ kind: 'candidate', to: 'peer', candidate: e.candidate.toJSON() })
  }
  bus.onmessage = async ({ data }) => {
    if (data.to !== 'bot') return
    if (data.kind === 'offer') {
      await pc.setRemoteDescription(data.description)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      bus.postMessage({ kind: 'answer', to: 'peer', description: pc.localDescription.toJSON() })
    } else if (data.kind === 'answer') {
      await pc.setRemoteDescription(data.description)
    } else if (data.kind === 'candidate') {
      await pc.addIceCandidate(data.candidate).catch(() => {})
    }
  }
  // Renegotiation the way LiveKit does it: the bot answers the first offer,
  // then owns every negotiation after that. Gated on the call being up so the
  // negotiationneeded burst from the initial addTrack cannot glare with the
  // peer's opening offer.
  pc.onnegotiationneeded = async () => {
    if (!window.__fixtureReady || pc.signalingState !== 'stable') return
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    bus.postMessage({ kind: 'offer', to: 'peer', description: pc.localDescription.toJSON() })
  }
  // LiveKit polls stats itself; that polling is what lets a late-injected
  // monitor register connections that existed before it. Reproduce it.
  setInterval(() => { pc.getStats().catch(() => {}) }, 1000)
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') window.__fixtureReady = true
  }
  window.__listening = true
})().catch((error) => { window.__fixtureError = String(error) })
</script>`

const PEER_PAGE = `<!doctype html>
<meta charset="utf-8">
<title>rtc fixture — peer</title>
<script>
(async () => {
  const media = await navigator.mediaDevices.getUserMedia({
    video: { width: 640, height: 360 }, audio: true,
  })
  const pc = new RTCPeerConnection()
  for (const track of media.getTracks()) pc.addTrack(track, media)
  const bus = new BroadcastChannel('rtc-fixture')
  pc.onicecandidate = (e) => {
    if (e.candidate) bus.postMessage({ kind: 'candidate', to: 'bot', candidate: e.candidate.toJSON() })
  }
  bus.onmessage = async ({ data }) => {
    if (data.to !== 'peer') return
    if (data.kind === 'answer') await pc.setRemoteDescription(data.description)
    else if (data.kind === 'offer') {
      // The bot renegotiates (a codec switch does); answer whatever it asks.
      await pc.setRemoteDescription(data.description)
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      bus.postMessage({ kind: 'answer', to: 'bot', description: pc.localDescription.toJSON() })
    } else if (data.kind === 'candidate') await pc.addIceCandidate(data.candidate).catch(() => {})
  }
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  bus.postMessage({ kind: 'offer', to: 'bot', description: pc.localDescription.toJSON() })
})().catch((error) => { window.__fixtureError = String(error) })
</script>`

// The same fake-capture launch a bot gets (browser.mjs), minus the media files:
// the built-in fake devices are enough to move real bytes both ways.
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
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: route.request().url().includes('/peer') ? PEER_PAGE : BOT_PAGE,
    }),
  )
  const page = await context.newPage()
  await page.goto(`${ORIGIN}/`)
  await page.waitForFunction(() => window.__listening || window.__fixtureError)
  const peer = await context.newPage()
  await peer.goto(`${ORIGIN}/peer`)
  await page.waitForFunction(() => window.__fixtureReady || window.__fixtureError, null, { timeout: 20_000 })
  const fixtureError = await page.evaluate(() => window.__fixtureError ?? null)
  check('the two-page call connects', !fixtureError, fixtureError ?? '')

  console.log('\ninstall')
  const hidden = await installMonitor(page)
  check('install reports the overlay hidden', hidden === true)
  const overlay = await page.evaluate(() => {
    const hosts = document.querySelectorAll('#rtc-stream-monitor-host')
    const host = hosts[0]
    return {
      hosts: hosts.length,
      display: host?.style.display ?? null,
      min: host?.shadowRoot?.getElementById('panel')?.classList.contains('min') ?? false,
    }
  })
  check('the overlay host exists and is display:none', overlay.hosts === 1 && overlay.display === 'none')
  check('the overlay panel is minimised (no paint work)', overlay.min)

  await installMonitor(page)
  const again = await page.evaluate(() => {
    const host = document.querySelector('#rtc-stream-monitor-host')
    return {
      hosts: document.querySelectorAll('#rtc-stream-monitor-host').length,
      display: host?.style.display ?? null,
      min: host?.shadowRoot?.getElementById('panel')?.classList.contains('min') ?? false,
    }
  })
  check('installing twice neither duplicates nor un-hides the overlay',
    again.hosts === 1 && again.display === 'none' && again.min)

  console.log('\nsummary')
  // Rates are deltas between the monitor's own 1s ticks, so the first useful
  // summary lands a few seconds after install.
  let summary = null
  for (let attempt = 0; attempt < 40; attempt += 1) {
    summary = await rtcSummary(page)
    if (summary && summary.pcs >= 1 && summary.down > 0 && summary.up > 0) break
    await page.waitForTimeout(500)
  }
  check('the pre-existing peer connection is captured after late injection',
    summary?.pcs === 1, JSON.stringify(summary))
  check('receive and send rates are measured', Boolean(summary?.down > 0 && summary?.up > 0))
  check('one audio and one video track each way',
    summary?.out?.a === 1 && summary?.out?.v === 1 && summary?.in?.a === 1 && summary?.in?.v === 1,
    JSON.stringify({ in: summary?.in, out: summary?.out }))
  check('RTP mode, not transport fallback', summary?.via === false)

  console.log('\nsnapshot')
  const snap = await rtcSnapshot(page)
  check('a snapshot is returned', Boolean(snap))
  check('the heavy raw stats never reach the wire', !JSON.stringify(snap ?? {}).includes('"raw"'))
  check('outgoing streams are named after the local tile',
    (snap?.outbound?.length ?? 0) > 0 && snap.outbound.every((s) => s.name === 'Bot 1'),
    JSON.stringify(snap?.outbound?.map((s) => [s.kind, s.name])))
  check('incoming streams are named after the remote tile',
    (snap?.inbound?.length ?? 0) > 0 && snap.inbound.every((s) => s.name === 'Alice'),
    JSON.stringify(snap?.inbound?.map((s) => [s.kind, s.name])))
  check('codecs are reported',
    snap?.outbound?.some((s) => s.codec?.name) && snap?.inbound?.some((s) => s.codec?.name))
  check('cumulative bytes are reported',
    snap?.outbound?.some((s) => typeof s.bytes === 'number' && s.bytes > 0) &&
      snap?.inbound?.some((s) => typeof s.bytes === 'number' && s.bytes > 0))
  check('the camera stream is not mistaken for a screen share',
    snap?.outbound?.filter((s) => s.kind === 'video').every((s) => s.role === 'camera'),
    JSON.stringify(snap?.outbound?.map((s) => [s.kind, s.role])))
  check('the browser reports what it can send, for the codec dropdowns',
    snap?.caps?.video?.includes('vp8') && snap?.caps?.audio?.includes('opus') &&
      !snap?.caps?.video?.includes('rtx'),
    JSON.stringify(snap?.caps))

  // A separate context proves the codec shim end to end with the SAME two-step
  // injection browser.mjs performs: the seed, then the shim file. The first
  // context stays shim-free on purpose — it pins the monitor against an
  // untouched page. VP8↔VP9 only: the bundled Chromium may lack H264.
  console.log('\ncodec control')
  const codecContext = await browser.newContext()
  await codecContext.grantPermissions(['camera', 'microphone'], { origin: ORIGIN })
  await codecContext.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: route.request().url().includes('/peer') ? PEER_PAGE : BOT_PAGE,
    }),
  )
  // In the app every page of a context belongs to the bot. Here the peer
  // shares the context only because BroadcastChannel needs it — and it must
  // stay neutral, or its answers would re-reorder codecs with the same
  // preference and a mid-call switch on the bot would prove nothing.
  await codecContext.addInitScript((prefs) => {
    if (!location.pathname.includes('/peer')) window.__botCodecInit__ = prefs
  }, { video: 'vp9' })
  await codecContext.addInitScript({ path: CODEC_SHIM_PATH })
  await codecContext.addInitScript((seed) => {
    window.__botCaptureInit__ = seed
  }, { label: 'Bot 1', videoUrl: null })
  await codecContext.addInitScript({ path: CAPTURE_SHIM_PATH })
  const botPage = await codecContext.newPage()
  await botPage.goto(`${ORIGIN}/`)
  await botPage.waitForFunction(() => window.__listening || window.__fixtureError)
  const codecPeer = await codecContext.newPage()
  await codecPeer.goto(`${ORIGIN}/peer`)
  await botPage.waitForFunction(() => window.__fixtureReady || window.__fixtureError, null, { timeout: 20_000 })
  const codecFixtureError = await botPage.evaluate(() => window.__fixtureError ?? null)
  check('the call still connects with the shim installed', !codecFixtureError, codecFixtureError ?? '')
  await installMonitor(botPage)

  const sentCodecs = async (kind) => {
    const model = await rtcSnapshot(botPage)
    // Carrying rows only — after a renegotiation the old codec's row lingers
    // at 0 kbps for a few seconds and must not vote.
    const streams = (model?.outbound ?? []).filter(
      (s) => s.kind === kind && s.codec?.name && (s.kbps ?? 0) > 0,
    )
    return streams.length > 0 ? streams.map((s) => s.codec.name.toLowerCase()) : null
  }
  const waitCodec = async (kind, name, timeout = 15_000) => {
    const deadline = Date.now() + timeout
    let last = null
    while (Date.now() < deadline) {
      last = await sentCodecs(kind)
      if (last && last.every((codec) => codec === name)) return true
      await botPage.waitForTimeout(500)
    }
    console.log(`        (last ${kind} codecs seen: ${JSON.stringify(last)})`)
    return false
  }

  const seeded = await botPage.evaluate(() => window.__botCodecState__())
  check('the launch seed reaches the shim', seeded?.prefs?.video === 'vp9', JSON.stringify(seeded))
  // The bot ANSWERS the fixture's first offer, and an answerer's reorder
  // cannot steer its own sending — the preference lands at the first
  // negotiation the bot itself drives. Nudge one, the way any renegotiating
  // app eventually would.
  await botPage.evaluate(() => window.__botSetCodec__('video', 'vp9'))
  check('a launch-time preference reaches the wire at the first bot-driven negotiation',
    await waitCodec('video', 'vp9'))
  check('audio is untouched by a video preference', await waitCodec('audio', 'opus'))

  const refused = await botPage.evaluate(() => window.__botSetCodec__('video', 'not-a-codec'))
  check('an unknown codec is refused, not applied',
    refused?.ok === false && refused?.reason === 'unsupported', JSON.stringify(refused))
  const badRole = await botPage.evaluate(() => window.__botSetCodec__('desktop', 'vp8'))
  check('an unknown role is refused too', badRole?.ok === false && badRole?.reason === 'bad-role')

  const switched = await botPage.evaluate(() => window.__botSetCodec__('video', 'vp8'))
  check('a live switch is accepted and lands on the connection',
    switched?.ok === true && switched?.applied >= 1 && switched?.pcs === 1, JSON.stringify(switched))
  check('the codec flips mid-call (the offer path)', await waitCodec('video', 'vp8'))
  check('audio still rides its own preference', await waitCodec('audio', 'opus'))

  const secondSwitch = await botPage.evaluate(() => window.__botSetCodec__('video', 'vp9'))
  check('switching back up is accepted',
    secondSwitch?.ok === true && (await waitCodec('video', 'vp9')))
  const reset = await botPage.evaluate(() => window.__botSetCodec__('video', null))
  check('resetting to the platform default is accepted', reset?.ok === true, JSON.stringify(reset))
  // The proof that the reset really lets go: the encoder pin is lifted and the
  // renegotiated default (VP8 first in Chromium) comes back on its own.
  check('a reset returns the wire to the browser default', await waitCodec('video', 'vp8'))

  // The rest of the audio matrix the dashboard offers. RED wraps opus, so it
  // proves itself at the top of the negotiated order — stats keep naming the
  // opus inside it, which is exactly why the tool settles red differently.
  for (const name of ['g722', 'pcmu', 'pcma']) {
    const switched = await botPage.evaluate((n) => window.__botSetCodec__('audio', n), name)
    check(`audio switches to ${name}`,
      switched?.ok === true && (await waitCodec('audio', name)))
  }
  const redSwitch = await botPage.evaluate(() => window.__botSetCodec__('audio', 'red'))
  let redTop = null
  for (let i = 0; i < 20 && redTop !== 'red'; i += 1) {
    await botPage.waitForTimeout(500)
    redTop = await botPage.evaluate(() => window.__botCodecTop__('audio'))
  }
  check('audio red engages at the top of the negotiation',
    redSwitch?.ok === true && redTop === 'red', `top=${redTop}`)
  await botPage.evaluate(() => window.__botSetCodec__('audio', null))

  // H265 sending is the browser's most temperamental: Chromium advertises it
  // yet does not always elect it from SDP order alone. The guarantee under
  // test is safety — the ask is accepted and the stream keeps carrying,
  // landed or not; what a real call takes is the live platform's decision.
  // The synthetic share: getDisplayMedia must resolve without ever touching
  // the browser's capture picker (no OS permission machinery involved), hand
  // back a live canvas stream, and tag its track for role detection.
  const share = await botPage.evaluate(async () => {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    const track = stream.getVideoTracks()[0]
    await new Promise((resolve) => setTimeout(resolve, 300))
    const result = {
      live: track.readyState === 'live',
      tagged: window.__botScreenTrackIds__?.has(track.id) ?? false,
      width: track.getSettings().width ?? null,
    }
    track.stop()
    return result
  })
  check('a share is synthesised in-page, live and tagged as a screen track',
    share.live && share.tagged && share.width === 1920, JSON.stringify(share))

  const videoCaps = (await rtcSnapshot(botPage))?.caps?.video ?? []
  if (videoCaps.includes('h265')) {
    const h265 = await botPage.evaluate(() => window.__botSetCodec__('video', 'h265'))
    const landed = await waitCodec('video', 'h265', 6000)
    check('an h265 ask is accepted and never breaks the stream',
      h265?.ok === true && ((await sentCodecs('video'))?.length ?? 0) > 0,
      `landed=${landed}`)
    await botPage.evaluate(() => window.__botSetCodec__('video', null))
  }
  await codecContext.close()
} finally {
  await browser.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
