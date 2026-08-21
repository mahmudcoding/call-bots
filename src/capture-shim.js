// Injected into every bot page at document-start (see launchGuest in
// browser.mjs). A bot's "screen" is synthetic footage, so getDisplayMedia
// here never needs the operating system at all: the override below builds
// the share from an in-page canvas — the same clip the screen page plays,
// captioned with the bot's name and a live clock — via captureStream().
//
// Why not Chromium's tab capture (the --auto-select-tab-capture-source flag,
// still passed as a fallback)? Because even a tab share brushes macOS's
// Screen Recording permission machinery, and an app the user once denied
// gets the "grant access in System Settings" nag dialog on every share —
// for a permission the share never actually needed. A canvas stream cannot
// trigger that dialog, on any machine, in any permission state.
//
// A sibling init script seeds window.__botCaptureInit__ with the bot's label
// and the clip URL. Tracks made here are tagged in
// window.__botScreenTrackIds__ so codec role detection (codec-shim.js, the
// monitor pipeline) can tell them apart from the camera without the
// capture-source label real tab tracks would carry.
(() => {
  const proto = window.MediaDevices?.prototype
  const original = proto?.getDisplayMedia
  if (typeof original !== 'function') return
  const seed = window.__botCaptureInit__ ?? {}
  window.__botScreenTrackIds__ = window.__botScreenTrackIds__ ?? new Set()

  proto.getDisplayMedia = async function (constraints) {
    try {
      const width = 1920
      const height = 1080
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')

      // The clip is optional: with it missing or slow, the share is still a
      // live, captioned surface rather than a black rectangle.
      let video = null
      if (seed.videoUrl) {
        video = document.createElement('video')
        video.muted = true
        video.loop = true
        video.playsInline = true
        video.src = seed.videoUrl
        await new Promise((resolve) => {
          const done = () => resolve()
          video.addEventListener('canplay', done, { once: true })
          video.addEventListener('error', () => {
            video = null
            done()
          }, { once: true })
          setTimeout(done, 3000)
        })
        if (video) await video.play().catch(() => { video = null })
      }

      const label = String(seed.label ?? 'Call Bots')
      const draw = () => {
        if (video && video.readyState >= 2) {
          ctx.drawImage(video, 0, 0, width, height)
        } else {
          const shade = 22 + Math.round(6 * Math.sin(Date.now() / 900))
          ctx.fillStyle = `rgb(${shade},${shade + 4},${shade + 10})`
          ctx.fillRect(0, 0, width, height)
        }
        const clock = new Date().toLocaleTimeString()
        const caption = `${label} · ${clock}`
        ctx.font = '600 34px -apple-system, BlinkMacSystemFont, sans-serif'
        const pad = 18
        const w = ctx.measureText(caption).width + pad * 2
        ctx.fillStyle = 'rgba(10,12,17,0.72)'
        ctx.beginPath()
        ctx.roundRect(28, height - 92, w, 56, 14)
        ctx.fill()
        ctx.fillStyle = '#f2f4f8'
        ctx.textBaseline = 'middle'
        ctx.fillText(caption, 28 + pad, height - 64)
      }
      draw()
      const timer = setInterval(draw, 66)

      const stream = canvas.captureStream(15)
      const track = stream.getVideoTracks()[0]
      track.contentHint = 'detail'
      window.__botScreenTrackIds__.add(track.id)
      const stop = track.stop.bind(track)
      track.stop = () => {
        clearInterval(timer)
        video?.pause?.()
        stop()
      }
      track.addEventListener('ended', () => clearInterval(timer))
      return stream
    } catch {
      // Anything unexpected falls back to the browser's own capture — the
      // tab-title flag still auto-picks the share page there.
      return original.call(this, constraints)
    }
  }
})()
