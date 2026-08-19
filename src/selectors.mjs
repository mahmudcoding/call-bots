// Every selector and URL shape the app depends on, in one place. Verified
// against aloqa-frontend develop @ 97a1746bb. If a deploy changes the UI, this
// is the only file that should need editing.

export const SEL = {
  // guest entry (/join/<token>) — anonymous, no account.
  // The form carries no testids; the name attribute and the form submit are the
  // stable seam, and the submit label varies with the room's entry mode.
  guestName: 'input[name="display_name"]',
  guestSubmit: 'form button[type="submit"]',
  guestSurface: '[data-testid="guest-call-surface"]',
  guestBlocked: '[data-testid="guest-join-blocked"]',

  // in-call surface (shared with the member UI)
  leaveButton: '[data-testid="call-controls-leave"]',
  leaveConfirm: '[data-testid="call-leave-confirm-submit"]',

  // device toggles: the PAIR wrapper holds the testid, the toggle is its first
  // button, and aria-pressed="true" means the device is OFF
  micPair: '[data-testid="mic-control-pair"]',
  camPair: '[data-testid="cam-control-pair"]',
  micRequest: '[data-testid="call-controls-mic-request"]',
  camRequest: '[data-testid="call-controls-camera-request"]',
  screenShare: '[data-testid="call-controls-screen-share"]',

  // participant grid
  shareLayout: '[data-grid-layout="screen-share"]',
  tile: '[data-testid="participant-tile"]',
}

const TOKEN_RE = /^[A-Za-z0-9._~-]{16,512}$/u

export const guestJoinPath = (token) => `/join/${encodeURIComponent(token)}`

// The invite link is the only input the app needs: it carries both the server
// to talk to and the token that admits a guest.
export const parseInviteLink = (input) => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('paste the call\'s invite link')

  if (!/^https?:\/\//u.test(raw)) {
    throw new Error('that is not a full link — copy the invite link including https://')
  }
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`not a valid link: ${raw.slice(0, 60)}`)
  }
  if (url.pathname === '/invite' || url.pathname.startsWith('/invite/')) {
    throw new Error('that is a workspace invite — paste the call\'s invite link (…/join/<token>)')
  }
  const match = url.pathname.match(/^\/(?:join|guest\/c)\/([^/?#]+)\/?$/u)
  if (!match) {
    throw new Error(`expected a call invite link like …/join/<token>, got ${url.pathname}`)
  }
  const token = decodeURIComponent(match[1])
  if (!TOKEN_RE.test(token)) throw new Error('that invite token looks malformed')
  return { origin: url.origin, token }
}
