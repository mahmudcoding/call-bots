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
