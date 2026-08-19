// Minimal cookie-jar HTTP client for the staging gateway (/stg/api/v1). The
// login endpoint sets httpOnly access/refresh cookies rather than returning a
// bearer token, so we keep a per-session cookie jar and replay it.

const parseSetCookie = (headers) => {
  const jar = new Map()
  // undici exposes multiple Set-Cookie via getSetCookie()
  const cookies =
    typeof headers.getSetCookie === 'function'
      ? headers.getSetCookie()
      : [headers.get('set-cookie')].filter(Boolean)
  for (const line of cookies) {
    const [pair] = line.split(';')
    const eq = pair.indexOf('=')
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim())
  }
  return jar
}

export class ApiSession {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/u, '')
    this.jar = new Map()
  }

  #cookieHeader() {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  async request(method, path, { body, timeout = 15_000 } = {}) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(this.jar.size ? { cookie: this.#cookieHeader() } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual',
        signal: controller.signal,
      })
      for (const [k, v] of parseSetCookie(response.headers)) this.jar.set(k, v)
      let payload = null
      const text = await response.text()
      if (text) {
        try {
          payload = JSON.parse(text)
        } catch {
          payload = { raw: text.slice(0, 200) }
        }
      }
      return { status: response.status, ok: response.ok, body: payload }
    } finally {
      clearTimeout(timer)
    }
  }

  get(path, opts) {
    return this.request('GET', path, opts)
  }

  post(path, body, opts) {
    return this.request('POST', path, { ...opts, body })
  }

  async login(email, password) {
    this.jar.clear()
    const res = await this.post('/auth/login/user', { email, password })
    if (res.status === 202) return { ok: false, reason: 'two_factor_required' }
    if (!res.ok) {
      return { ok: false, reason: res.body?.key ?? res.body?.code ?? `http_${res.status}`, status: res.status }
    }
    return { ok: true, user: res.body }
  }
}

// Aloqa error key -> short human reason
export const errorReason = (body, status) =>
  body?.key ?? body?.error?.code ?? body?.code ?? `http_${status}`
