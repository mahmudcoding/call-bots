// Every selector, attribute, and URL pattern the tool relies on, in one place.
// Verified against aloqa-frontend develop @ 97a1746bb (2026-08). If staging
// deploys a UI change, this is the only file that should need edits.

export const SEL = {
  // login (/login) — fields carry no testids; name attrs are the stable seam
  loginEmail: 'input[name="email"]',
  loginPassword: 'input[name="password"]',
  loginSubmit: 'form button[type="submit"]',

  // lobby (deep link /w/{ws}/call/{id})
  lobbyPage: '[data-testid="lobby-page"]',
  lobbyJoin: '[data-testid="lobby-join"]', // uses aria-disabled, never disabled
  lobbyCamPill: '[data-testid="lobby-device-bar"] [data-camera-enabled]',
  lobbyMicPill: '[data-testid="lobby-device-bar"] [data-mic-enabled]',
  passwordGate: '[data-testid="call-password-gate"]',

  // in-call surface
  callSurface: '[data-testid="call-surface"]',
  leaveButton: '[data-testid="call-controls-leave"]',
  leaveConfirm: '[data-testid="call-leave-confirm-submit"]',
  endForEveryone: '[data-testid="call-controls-end-for-everyone"]',
  endConfirm: '[data-testid="call-end-confirm-submit"]',

  // device toggles: the PAIR wrapper has the testid, the toggle is its first
  // button. aria-pressed="true" means the device is OFF (pressed={isMuted}).
  micPair: '[data-testid="mic-control-pair"]',
  camPair: '[data-testid="cam-control-pair"]',
  // when a host force-mutes, the toggle is replaced by a request button
  micRequest: '[data-testid="call-controls-mic-request"]',
  camRequest: '[data-testid="call-controls-camera-request"]',
  screenShare: '[data-testid="call-controls-screen-share"]',

  // participant grid
  shareLayout: '[data-grid-layout="screen-share"]',
  tile: '[data-testid="participant-tile"]',
  remoteTileVideo:
    '[data-testid="participant-tile"][data-local="false"] [data-testid="participant-video"]',

  // guest entry (/join/<token>) — anonymous participants, no account.
  // The form carries no testids; name attr + form submit are the stable seam,
  // and the submit label varies ("Join call"/"Ask to join"/"Continue").
  guestName: 'input[name="display_name"]',
  guestPassword: 'input[name="meeting_password"]',
  guestSubmit: 'form button[type="submit"]',
  guestSurface: '[data-testid="guest-call-surface"]',
  guestBlocked: '[data-testid="guest-join-blocked"]',
  guestAutoJoin: '[data-testid="guest-auto-join-pending"]',
  // host-side guest link inside the Add-to-call modal
  guestLinkUrl: '[data-testid="guest-links-created-url"]',
  guestLinkSection: '[data-testid="guest-links-section"]',

  // calls hub (create flow). "Start now" has no testid; it is structurally the
  // first button inside the header bar, which is locale-proof.
  callsHubHeaderBar: '[data-testid="calls-hub-header-bar"]',
  // legacy quick-start card — kept as fallback in case staging serves the old
  // CallsHomePage layout
  groupCallCard: '[data-testid="call-card"][data-call-type="group"]',
  startEntryOpen: '[data-testid="calls-start-entry-open"]',
  startSubmit: '[data-testid="calls-start-submit"]',
}

export const API = {
  authMe: '/api/v1/auth/me',
  meetingsCurrent: '/api/v1/meetings/current',
  meetingBase: '/api/v1/meeting',
  meetingLeave: (id) => `/api/v1/meeting/${id}/leave`,
  meetingEnd: (id) => `/api/v1/meeting/${id}/end`,
  meetingParticipants: (id) => `/api/v1/meeting/${id}/participants`,
  workspaceActiveMeetings: (wsId) => `/api/v1/workspace/${wsId}/meetings/active`,
}

export const callDeepLinkPath = (wsId, callId) => `/w/${wsId}/call/${callId}`
export const guestJoinPath = (token) => `/join/${encodeURIComponent(token)}`

// Accepts a full guest URL or a bare 64-hex token.
export const parseGuestToken = (input) => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('no guest link provided')
  if (!/^https?:\/\//u.test(raw)) return decodeURIComponent(raw)
  try {
    const url = new URL(raw)
    const seg = url.pathname.split('/').filter(Boolean).pop()
    if (!seg) throw new Error('empty')
    return decodeURIComponent(seg)
  } catch {
    throw new Error(`could not read a guest token from "${input}"`)
  }
}
export const callsHubPath = (wsId) => `/w/${wsId}/calls`
export const loginPath = (next) => `/login?next=${encodeURIComponent(next)}`

// Accepts a full URL or a path, both /call/ (live deep link) and /calls/
// (history page) shapes, and returns { wsId, callId }.
export const parseCallUrl = (input, baseUrl) => {
  let path
  try {
    path = new URL(input, baseUrl).pathname
  } catch {
    throw new Error(`Not a valid call URL or path: ${input}`)
  }
  const match = path.match(/^\/w\/([A-Za-z0-9_-]+)\/calls?\/([A-Za-z0-9_-]+)\/?$/u)
  if (!match) {
    throw new Error(
      `Cannot parse call URL "${input}" — expected .../w/<workspaceId>/call/<callId>`,
    )
  }
  return { wsId: match[1], callId: match[2] }
}
