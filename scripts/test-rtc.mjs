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

import { launchChannel } from '../src/browser.mjs'
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
    } else if (data.kind === 'candidate') {
      await pc.addIceCandidate(data.candidate).catch(() => {})
    }
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
    else if (data.kind === 'candidate') await pc.addIceCandidate(data.candidate).catch(() => {})
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
} finally {
  await browser.close().catch(() => {})
}

const failed = results.filter((r) => !r.pass)
console.log(`\n${results.length - failed.length}/${results.length} checks passed`)
if (failed.length > 0) process.exit(1)
