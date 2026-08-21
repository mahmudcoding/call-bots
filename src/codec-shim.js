// Injected into every bot page at document-start (see launchGuest in
// browser.mjs), before the call platform's bundle loads. The bot does not own
// the WebRTC code — the platform's client does — so the only way to choose
// what the bot SENDS is to shape the platform's own negotiation: every time an
// offer or answer is about to be created, each sending transceiver gets its
// codec preferences set by track role (microphone, camera, or screenshare).
//
// NEGOTIATION ONLY, never an encoder pin. encodings[].codec can flip the
// encoder in place, and the sender's own stats look perfect — but an SFU
// (LiveKit) forwards a publication by the codec IT negotiated, so pinned
// packets silently stop reaching every other participant: the tile goes dark
// for the whole call while the bot's panel says all is well. A preference
// that only rides offers and answers cannot break a viewer, because the SFU
// consents to every codec in play. Mid-call changes therefore need a fresh
// negotiation — guest.mjs rejoins the bot (or restarts its share) so the
// preference lands at a join the SFU takes part in.
//
// Reorder, never filter: the preferred codec's capability entries go first and
// everything else stays in the list, so a call that cannot take the codec
// falls back to what it used before instead of rejecting the track.
//
// With no preference set the patches do nothing at all — a default run
// negotiates bit-identically to an uninjected page.
//
// Seeding: a sibling init script sets window.__botCodecInit__ before this file
// runs. Runtime changes arrive through window.__botSetCodec__ (guest.mjs).
(() => {
  if (window.__botSetCodec__) return
  const Native = window.RTCPeerConnection
  if (!Native || !window.RTCRtpSender?.getCapabilities) return

  const ROLES = ['audio', 'video', 'screen']
  const prefs = { audio: null, video: null, screen: null }
  const seed = window.__botCodecInit__
  if (seed && typeof seed === 'object') {
    for (const role of ROLES) {
      if (typeof seed[role] === 'string' && seed[role]) prefs[role] = seed[role].toLowerCase()
    }
  }

  const pcs = new Set()
  // A muted publication can detach the sender's track; remembering the role a
  // transceiver had keeps its preference alive across that.
  const roles = new WeakMap()
  // Transceivers whose CURRENT negotiated codec order was produced under one
  // of our preferences (an offer/answer completed while it was set). Resetting
  // those must actively push the browser default back; everything else is left
  // alone, so an app that never renegotiated keeps its own untouched choice.
  const negotiatedUnder = new WeakMap()
  // The same rule the monitor pipeline uses to tell a share from a camera
  // (rtc.mjs): a capture-source label instead of a device name.
  const SCREEN_RE = /web-contents|screen|window|tab/iu

  const roleOf = (transceiver) => {
    const track = transceiver.sender?.track
    if (track) {
      // Synthetic shares (capture-shim.js) are tagged by id — their canvas
      // tracks carry none of the capture-source labels real tab shares do.
      const isScreen =
        window.__botScreenTrackIds__?.has(track.id) || SCREEN_RE.test(track.label ?? '')
      const role = track.kind === 'audio' ? 'audio' : isScreen ? 'screen' : 'video'
      roles.set(transceiver, role)
      return role
    }
    return roles.get(transceiver) ?? null
  }

  // Capability entries are reordered as-is, never rebuilt by hand: the browser
  // matches them on their full identity, fmtp line included. One capability
  // SET at a time, too — mixing sender-only and receiver-only entries in one
  // list makes Chromium silently answer the whole m-line with port 0, killing
  // the track it was meant to tune. Receiver capabilities are the canonical
  // base (every implementation accepts them for offers and answers alike);
  // sender capabilities are the fallback for a codec only listed there.
  const listFrom = (side, kind, mime) => {
    const caps = side?.getCapabilities?.(kind)?.codecs ?? []
    const preferred = caps.filter((codec) => codec.mimeType.toLowerCase() === mime)
    if (preferred.length === 0) return null
    return [...preferred, ...caps.filter((codec) => !preferred.includes(codec))]
  }

  const ordered = (kind, name) => {
    const mime = `${kind}/${name}`
    return (
      listFrom(window.RTCRtpReceiver, kind, mime) ?? listFrom(window.RTCRtpSender, kind, mime)
    )
  }

  // The bot is being told what to SEND, so the name must be encodable here —
  // a receive-only codec preferred first would negotiate a stream this side
  // cannot produce.
  const sendable = (kind, name) =>
    (window.RTCRtpSender.getCapabilities(kind)?.codecs ?? []).some(
      (codec) => codec.mimeType.toLowerCase() === `${kind}/${name}`,
    )

  const anyPref = () => ROLES.some((role) => prefs[role] !== null)

  // What "auto" has to mean here: subsequent offers reuse the currently
  // negotiated codec order, so clearing preferences with an empty list would
  // leave a previously forced codec in place forever. Going back to auto
  // actively restores the browser's own default order instead.
  const defaults = (kind) => window.RTCRtpReceiver?.getCapabilities?.(kind)?.codecs ?? []

  const applyTo = (pc) => {
    let transceivers
    try {
      transceivers = pc.getTransceivers()
    } catch {
      return 0
    }
    let touched = 0
    for (const transceiver of transceivers) {
      if (transceiver.stopped) continue
      const direction = transceiver.direction
      if (direction !== 'sendrecv' && direction !== 'sendonly') continue
      const role = roleOf(transceiver)
      if (!role) continue
      const name = prefs[role]
      const kind = role === 'audio' ? 'audio' : 'video'
      try {
        if (name === null) {
          // Unwind only what we caused: with our preference in the current
          // negotiated order, push the browser default to displace it at the
          // next exchange; otherwise clear to "no preference" so the app's
          // own negotiated choice stays exactly as it is.
          transceiver.setCodecPreferences(negotiatedUnder.has(transceiver) ? defaults(kind) : [])
        } else {
          const list = ordered(kind, name)
          if (!list) continue
          transceiver.setCodecPreferences(list)
        }
        touched += 1
      } catch {
        // One unusable transceiver must never take the app's negotiation down.
      }
    }
    return touched
  }

  // Applied at the moment the app builds a description, so every negotiation —
  // the first join, a republished camera, a screenshare starting — carries the
  // current preference without anyone having to catch it in time.
  const proto = Native.prototype
  const patch = (method, applies) => {
    const original = proto[method]
    if (typeof original !== 'function') return
    proto[method] = function (...args) {
      try {
        if (anyPref() && (!applies || applies(args))) applyTo(this)
      } catch {
        // The shim shapes negotiation; it must never break it.
      }
      const result = original.apply(this, args)
      // Once a description lands and the exchange is complete, record whose
      // preference the new negotiated order belongs to.
      if (method === 'setLocalDescription' || method === 'setRemoteDescription') {
        const pc = this
        Promise.resolve(result)
          .then(() => {
            if (pc.signalingState === 'stable') markNegotiated(pc)
            return null
          })
          .catch(() => {})
      }
      return result
    }
  }

  const markNegotiated = (pc) => {
    try {
      for (const transceiver of pc.getTransceivers()) {
        if (transceiver.stopped) continue
        const role = roleOf(transceiver)
        if (!role) continue
        if (prefs[role] === null) negotiatedUnder.delete(transceiver)
        else negotiatedUnder.set(transceiver, prefs[role])
      }
    } catch {
      // A connection closing mid-walk is fine to skip.
    }
  }
  patch('createOffer')
  patch('createAnswer')
  patch('setRemoteDescription', () => false)
  // The parameterless form asks the browser to build the description itself.
  patch('setLocalDescription', (args) => args.length === 0 || args[0] == null)

  // Registry of live connections, for runtime switches. The prototype stays
  // shared, so the stream monitor's own constructor wrap chains cleanly over
  // or under this one.
  const Wrapped = function RTCPeerConnection(...args) {
    const pc = new Native(...args)
    pcs.add(pc)
    return pc
  }
  Wrapped.prototype = proto
  try {
    Object.setPrototypeOf(Wrapped, Native)
  } catch {
    // Static helpers stay reachable through the native class if this fails.
  }
  window.RTCPeerConnection = Wrapped
  if ('webkitRTCPeerConnection' in window) window.webkitRTCPeerConnection = Wrapped

  const owners = (role) =>
    [...pcs].filter((pc) => {
      try {
        if (pc.connectionState === 'closed' || pc.signalingState === 'closed') {
          pcs.delete(pc)
          return false
        }
        return pc.getTransceivers().some((t) => !t.stopped && roleOf(t) === role)
      } catch {
        return false
      }
    })

  window.__botSetCodec__ = (role, name) => {
    if (!ROLES.includes(role)) return { ok: false, reason: 'bad-role' }
    const wanted = typeof name === 'string' && name.trim() ? name.trim().toLowerCase() : null
    const kind = role === 'audio' ? 'audio' : 'video'
    if (wanted !== null && !sendable(kind, wanted)) {
      return { ok: false, reason: 'unsupported' }
    }
    prefs[role] = wanted
    const own = owners(role)
    // Whether the CURRENT negotiation even carries the codec — a fresh
    // negotiation could still bring it in, but a call that refuses it in the
    // set it already agreed to is worth reporting over a silent shrug.
    const negotiated =
      wanted === null ||
      own.some((pc) => {
        try {
          return pc.getTransceivers().some(
            (t) =>
              !t.stopped &&
              roleOf(t) === role &&
              (t.sender.getParameters().codecs ?? []).some(
                (codec) => codec.mimeType.toLowerCase() === `${kind}/${wanted}`,
              ),
          )
        } catch {
          return false
        }
      })
    let applied = 0
    for (const pc of own) applied += applyTo(pc)
    // Ask the app to renegotiate the same way the browser would, so the
    // preference reaches the SDP where the app cooperates. Clients driven by
    // onnegotiationneeded treat the synthetic event like a real one; a client
    // that ignores it (LiveKit) is handled above this page — guest.mjs
    // rejoins the bot so the preference lands at a negotiation the SFU takes
    // part in. Only connections that actually send this role are poked; a
    // subscriber connection is left alone.
    for (const pc of own) {
      try {
        pc.dispatchEvent(new Event('negotiationneeded'))
      } catch {
        // Nothing to do — the createOffer patch still catches the next one.
      }
    }
    return { ok: true, applied, pcs: own.length, negotiated }
  }

  // The codec at the top of the negotiated order for a role — the one Chrome
  // sends. Also the only reliable signal that RED is engaged, since stats
  // attribute a RED stream to the opus inside it.
  window.__botCodecTop__ = (role) => {
    for (const pc of owners(role)) {
      for (const transceiver of pc.getTransceivers()) {
        if (transceiver.stopped || roleOf(transceiver) !== role) continue
        const top = (transceiver.sender.getParameters().codecs ?? [])[0]
        if (top?.mimeType) return top.mimeType.split('/')[1]?.toLowerCase() ?? null
      }
    }
    return null
  }

  // What each role's CURRENT negotiation can carry, for the dashboard to grey
  // out choices this call can never take. Empty means "no live sender yet"
  // (a screen share not started), not "nothing works".
  const PLUMBING = ['rtx', 'ulpfec', 'flexfec-03', 'cn', 'telephone-event']
  window.__botCodecNegotiated__ = () => {
    const out = { audio: [], video: [], screen: [] }
    for (const role of ROLES) {
      const names = new Set()
      for (const pc of owners(role)) {
        for (const transceiver of pc.getTransceivers()) {
          if (transceiver.stopped || roleOf(transceiver) !== role) continue
          for (const codec of transceiver.sender.getParameters().codecs ?? []) {
            const name = codec.mimeType.split('/')[1]?.toLowerCase()
            if (name && !PLUMBING.includes(name)) names.add(name)
          }
        }
      }
      out[role] = [...names]
    }
    // On a LiveKit page the negotiated set overstates reality: the client can
    // only PUBLISH opus (optionally RED-wrapped) for audio, however many
    // codecs the SDP agreed to decode. Offer only what can land.
    if (findRoom()) {
      out.audio = out.audio.filter((name) => name === 'opus')
    }
    return out
  }

  window.__botCodecState__ = () => ({ prefs: { ...prefs }, pcs: pcs.size })

  // --- LiveKit-native switching -------------------------------------------
  // On a LiveKit app the ONLY fully consistent codec change is the client's
  // own republish: the publish request tells the SFU the codec, the SFU
  // consents, and every subscriber renegotiates. The Room instance is not on
  // window, but the app renders it through React — a bounded walk over the
  // fiber tree finds the object whose localParticipant can publishTrack.
  let lkRoom = null
  const findRoom = () => {
    if (lkRoom && lkRoom.state === 'connected') return lkRoom
    lkRoom = null
    const isRoom = (v) =>
      v &&
      typeof v === 'object' &&
      v.localParticipant &&
      typeof v.localParticipant.publishTrack === 'function'
    const seen = new Set()
    const scanValue = (v, depth) => {
      if (!v || typeof v !== 'object' || seen.has(v) || depth > 3) return null
      seen.add(v)
      if (isRoom(v)) return v
      if (depth === 3) return null
      for (const key of Object.keys(v)) {
        try {
          const hit = scanValue(v[key], depth + 1)
          if (hit) return hit
        } catch {
          // Getters on app objects may throw; skip them.
        }
      }
      return null
    }
    let budget = 30000
    const walk = (fiber) => {
      if (!fiber || budget-- < 0) return null
      for (const src of [fiber.stateNode, fiber.memoizedProps, fiber.memoizedState]) {
        const hit = scanValue(src, 0)
        if (hit) return hit
      }
      let hook = fiber.memoizedState
      let hops = 0
      while (hook && typeof hook === 'object' && 'next' in hook && hops < 40) {
        const hit = scanValue(hook.memoizedState, 0)
        if (hit) return hit
        hook = hook.next
        hops += 1
      }
      return walk(fiber.child) ?? walk(fiber.sibling)
    }
    for (const el of document.querySelectorAll('*')) {
      const key = Object.keys(el).find(
        (k) => k.startsWith('__reactFiber$') || k.startsWith('__reactContainer$'),
      )
      if (!key) continue
      const room = walk(el[key])
      if (room) {
        lkRoom = room
        break
      }
    }
    return lkRoom
  }

  window.__botLkSwitch__ = async (role, name) => {
    const room = findRoom()
    if (!room) return { ok: false, reason: 'no-room' }
    const source = role === 'audio' ? 'microphone' : role === 'screen' ? 'screen_share' : 'camera'
    const pub = [...(room.localParticipant.trackPublications?.values?.() ?? [])].find(
      (p) => p.source === source && p.track,
    )
    if (!pub) return { ok: false, reason: 'no-publication' }
    const track = pub.track
    const opts = { source }
    if (role === 'audio') {
      // LiveKit publishes audio as opus, optionally wrapped in RED — other
      // audio codecs are not a thing it can be asked for.
      if (name !== null && name !== 'opus' && name !== 'red') {
        return { ok: false, reason: 'unpublishable' }
      }
      opts.red = name === 'red'
    } else {
      opts.videoCodec = name ?? room.options?.publishDefaults?.videoCodec ?? undefined
      if (!opts.videoCodec) delete opts.videoCodec
    }
    try {
      await room.localParticipant.unpublishTrack(track, false)
      await new Promise((resolve) => setTimeout(resolve, 400))
      await room.localParticipant.publishTrack(track, opts)
      return { ok: true }
    } catch (error) {
      // Never leave the bot unpublished: put the track back on defaults.
      try {
        await room.localParticipant.publishTrack(track, { source })
      } catch {
        // The app's own recovery is the last resort.
      }
      return { ok: false, reason: String(error) }
    }
  }
})()
