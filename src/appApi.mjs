import { API } from './selectors.mjs'

// GETs go through the context's request object (shares cookies, works before
// any app page is loaded). Mutating calls go through in-page fetch so the
// browser attaches the same-origin Origin header the BFF's CSRF check expects.

export const authMe = async (context, baseUrl) => {
  try {
    const response = await context.request.get(`${baseUrl}${API.authMe}`, {
      timeout: 10_000,
    })
    if (!response.ok()) return { ok: false, email: null }
    const body = await response.json().catch(() => null)
    const email = body?.email ?? body?.user?.email ?? body?.data?.email ?? null
    return { ok: true, email: typeof email === 'string' ? email.toLowerCase() : null }
  } catch {
    return { ok: false, email: null }
  }
}

const inPageFetch = (page, { url, method = 'GET' }) =>
  page.evaluate(
    async ({ url: u, method: m }) => {
      const response = await fetch(u, { method: m, credentials: 'include' })
      let body = null
      try {
        body = await response.json()
      } catch {
        /* empty or non-JSON body */
      }
      return { status: response.status, body }
    },
    { url, method },
  )

export const meetingsCurrent = (page) => inPageFetch(page, { url: API.meetingsCurrent })

export const activeMeetings = (page, wsId) =>
  inPageFetch(page, { url: API.workspaceActiveMeetings(wsId) })

export const leaveMeeting = (page, meetingId) =>
  inPageFetch(page, { url: API.meetingLeave(meetingId), method: 'POST' })

export const endMeeting = (page, meetingId) =>
  inPageFetch(page, { url: API.meetingEnd(meetingId), method: 'POST' })

// Response shapes are not pinned by the tool; search the payload for the
// meeting with our id and read its participant count defensively.
const walk = (node, visit) => {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const value of Object.values(node)) walk(value, visit)
}

export const findParticipantCount = (payload, callId) => {
  let count = null
  walk(payload, (node) => {
    if (count !== null) return
    const id = node.id ?? node.meeting_id ?? node.meetingId
    if (id === callId) {
      const value = node.participant_count ?? node.participantCount
      if (typeof value === 'number') count = value
    }
  })
  return count
}

// Mirrors the frontend e2e helper: the create response shape is not
// constructed by us — we only fish the first plausible string id out of it.
export const findStringField = (payload, key) => {
  let found = null
  walk(payload, (node) => {
    if (found !== null) return
    const value = node[key]
    if (typeof value === 'string' && value.length > 0) found = value
  })
  return found
}
