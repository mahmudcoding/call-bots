// Join fleet users to a workspace by accepting an invite link — pure HTTP, no
// browsers. Each user logs in and POSTs /workspace-invites/accept; the product's
// accept transaction fans the membership out across all six databases.
import { ApiSession, errorReason } from './httpApi.mjs'
import { plain as log } from './log.mjs'

// Accepts a full invite URL or a bare token. Product invite URLs look like
// https://<host>/invite?token=<t> or https://<host>/invite/<t>; guest/legacy
// shapes carry the token as the last path segment or a ?token= param.
export const extractInviteToken = (input) => {
  const raw = String(input ?? '').trim()
  if (!raw) throw new Error('no invite link or token provided')
  if (!/^https?:\/\//u.test(raw)) return decodeURIComponent(raw)
  let url
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  const q = url.searchParams.get('token')
  if (q) return q
  const seg = url.pathname.split('/').filter(Boolean).pop()
  if (!seg) throw new Error(`could not find a token in ${raw}`)
  return decodeURIComponent(seg)
}

// apiBase e.g. https://airion-cargo.store/stg/api/v1
export const joinUsersToWorkspace = async ({ apiBase, users, token, pace = 700, onProgress }) => {
  const results = []
  let done = 0
  for (const user of users) {
    const session = new ApiSession(apiBase)
    let outcome
    const login = await session.login(user.email, user.password)
    if (!login.ok) {
      outcome = { label: user.label, ok: false, state: 'login_failed', detail: login.reason }
    } else {
      const res = await session.post('/workspace-invites/accept', { token })
      if (res.ok) {
        outcome = { label: user.label, ok: true, state: 'joined' }
      } else {
        const key = errorReason(res.body, res.status)
        const already = /ALREADY|MEMBER|CONFLICT/iu.test(key)
        outcome = {
          label: user.label,
          ok: already,
          state: already ? 'already_member' : 'accept_failed',
          detail: key,
        }
      }
    }
    results.push({ ...outcome, session: outcome.ok ? session : null, user })
    done += 1
    if (onProgress) onProgress(done, users.length, outcome)
    await new Promise((r) => setTimeout(r, pace))
  }
  return results
}

// After joining, read a user's workspace list to learn the joined workspace id.
// Matches on the invite's resulting membership: returns the workspace whose id
// is new relative to `knownBefore`, else the best single candidate.
export const discoverJoinedWorkspace = async (session, { preferName } = {}) => {
  const res = await session.get('/users/me/workspaces')
  if (!res.ok || !res.body) return null
  // response shape is defensive: find arrays of {id,name,type}
  const spaces = []
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (typeof node.id === 'string' && /^W/u.test(node.id) && node.type !== 'personal') {
      spaces.push({ id: node.id, name: node.name ?? '', type: node.type })
    }
    for (const v of Object.values(node)) walk(v)
  }
  walk(res.body)
  if (spaces.length === 0) return null
  if (preferName) {
    const byName = spaces.find((s) => s.name?.toLowerCase() === preferName.toLowerCase())
    if (byName) return byName
  }
  // prefer a company (non-personal) workspace; first is fine for a fresh fleet
  return spaces[0]
}

export const logJoinSummary = (results) => {
  const joined = results.filter((r) => r.state === 'joined').length
  const already = results.filter((r) => r.state === 'already_member').length
  const failed = results.filter((r) => !r.ok)
  log.info(`workspace join: ${joined} joined, ${already} already members, ${failed.length} failed`)
  for (const f of failed) log.warn(`  ${f.label}: ${f.state} (${f.detail})`)
  return { joined, already, failed: failed.length }
}
