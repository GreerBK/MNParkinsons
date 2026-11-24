const AIRTABLE_ORIGIN = 'https://api.airtable.com'
const INTERNAL_ORIGIN = 'https://airtable-gate.invalid'
const BASE_PATH = /^\/v0\/(?:meta\/bases\/)?app[a-zA-Z0-9]{14}\//
const CALL_SPACING_MS = 260 // four requests in any second, below Airtable's five per base
const MAX_QUEUE_MS = 4000
const UPSTREAM_TIMEOUT_MS = 8000
const BACKOFF_MS = 31000
const CLAIM_SWEEP_MS = 300000
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PATCH', 'DELETE'])
const QR_CACHE_PATH = /^\/qr-cache\/([a-z0-9][a-z0-9-]{0,39})$/
const RECORD_ID = /^rec[a-zA-Z0-9]{14,17}$/

function busy(ms) {
  return Response.json({ error: 'Activity database is busy' }, {
    status: 503,
    headers: { 'Retry-After': String(Math.max(1, Math.ceil(ms / 1000))), 'X-Airtable-Request-Sent': 'false' },
  })
}

export class AirtableGateway {
  constructor(state) {
    this.storage = state.storage
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS claims (
      scope TEXT NOT NULL, identity TEXT NOT NULL, expires INTEGER NOT NULL, count INTEGER NOT NULL,
      PRIMARY KEY (scope, identity)
    )`)
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS claim_expiry ON claims(expires)')
    this.storage.sql.exec(`CREATE TABLE IF NOT EXISTS qr_observations (
      code TEXT PRIMARY KEY, expires INTEGER NOT NULL, observation TEXT NOT NULL
    )`)
    this.storage.sql.exec('CREATE INDEX IF NOT EXISTS qr_observation_expiry ON qr_observations(expires)')
  }

  async fetch(request) {
    const url = new URL(request.url)
    if (url.origin === INTERNAL_ORIGIN) {
      if (url.pathname === '/claim' && request.method === 'POST') return this.claim(request)
      const qrCache = url.pathname.match(QR_CACHE_PATH)
      if (qrCache) {
        if (request.method === 'GET') return this.readQrObservation(qrCache[1], Date.now())
        if (request.method === 'PUT') return this.publishQrObservation(qrCache[1], request)
      }
      return new Response(null, { status: 404 })
    }
    if (
      url.origin !== AIRTABLE_ORIGIN || !BASE_PATH.test(url.pathname) || !ALLOWED_METHODS.has(request.method) ||
      !request.headers.get('Authorization')
    ) {
      return new Response(null, { status: 404 })
    }

    const queuedAt = Date.now()
    const configuredQueue = request.headers.get('X-Airtable-Max-Queue-Ms')
    const maxQueue = configuredQueue === null || !Number.isFinite(Number(configuredQueue))
      ? MAX_QUEUE_MS
      : Math.min(MAX_QUEUE_MS, Math.max(0, Number(configuredQueue)))
    const retryAt = this.storage.kv.get('retryAt') || 0
    if (retryAt > queuedAt) return busy(retryAt - queuedAt)

    const reservedAt = Math.max(queuedAt, this.storage.kv.get('nextSlot') || 0)
    const deadline = queuedAt + maxQueue
    if (reservedAt > deadline) return busy(reservedAt - queuedAt)
    this.storage.kv.put('nextSlot', reservedAt + CALL_SPACING_MS)

    // Timers can wake late or out of order. Check actual send times as well as
    // reserved slots so even delayed requests cannot send a burst.
    let dispatchedAt
    for (;;) {
      const now = Date.now()
      const retry = this.storage.kv.get('retryAt') || 0
      if (retry > now) return busy(retry - now)
      if (request.signal.aborted || now > deadline) return busy(CALL_SPACING_MS)
      const turn = Math.max(reservedAt, (this.storage.kv.get('lastSent') || 0) + CALL_SPACING_MS)
      if (turn > deadline) return busy(turn - now)
      if (turn <= now) {
        this.storage.kv.put('lastSent', now)
        dispatchedAt = now
        break
      }
      await new Promise(resolve => setTimeout(resolve, turn - now))
    }

    const headers = new Headers({ Authorization: request.headers.get('Authorization') })
    const contentType = request.headers.get('Content-Type')
    if (contentType) headers.set('Content-Type', contentType)
    const response = await fetch(url, {
      method: request.method,
      headers,
      body: request.body,
      redirect: 'manual',
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)]),
    })
    if (response.status === 429) this.storage.kv.put('retryAt', Date.now() + BACKOFF_MS)
    const stamped = new Response(response.body, response)
    stamped.headers.set('X-Airtable-Dispatch-Ms', String(dispatchedAt))
    return stamped
  }

  async claim(request) {
    const payload = await request.json().catch(() => null)
    const { scope, key, windowMs, limit } = payload || {}
    if (
      typeof scope !== 'string' || !/^[a-z][a-z0-9-]{0,49}$/.test(scope) ||
      typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(key) ||
      !Number.isSafeInteger(windowMs) || windowMs < 1000 || windowMs > 86400000 ||
      !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
    ) {
      return new Response(null, { status: 400 })
    }

    const now = Date.now()
    const { sql } = this.storage
    this.sweepExpired(now)

    const granted = this.storage.transactionSync(() => {
      const current = [...sql.exec('SELECT expires, count FROM claims WHERE scope = ? AND identity = ?', scope, key)][0]
      if (current && current.expires > now) {
        if (current.count >= limit) return false
        sql.exec('UPDATE claims SET count = count + 1 WHERE scope = ? AND identity = ?', scope, key)
      } else {
        sql.exec('INSERT OR REPLACE INTO claims (scope, identity, expires, count) VALUES (?, ?, ?, 1)', scope, key, now + windowMs)
      }
      return true
    })
    return new Response(null, { status: granted ? 204 : 429 })
  }

  sweepExpired(now) {
    const { kv, sql } = this.storage
    if (now - (kv.get('lastSweep') || 0) < CLAIM_SWEEP_MS) return
    sql.exec('DELETE FROM claims WHERE expires <= ?', now)
    sql.exec('DELETE FROM qr_observations WHERE expires <= ?', now)
    kv.put('lastSweep', now)
  }

  findQrObservation(code, now) {
    const [row] = this.storage.sql.exec('SELECT observation FROM qr_observations WHERE code = ? AND expires > ?', code, now)
    return row ? JSON.parse(row.observation) : undefined
  }

  readQrObservation(code, now) {
    const observation = this.findQrObservation(code, now)
    return observation ? Response.json(observation) : new Response(null, { status: 404 })
  }

  async publishQrObservation(code, request) {
    const payload = await request.json().catch(() => null)
    const { observation, ttlSeconds } = payload || {}
    const { entry, at, life, started } = observation || {}
    const validEntry = entry === null || (
      entry && RECORD_ID.test(entry.id || '') && typeof entry.destination === 'string' && entry.destination.length <= 8192
    )
    const now = Date.now()
    if (
      !validEntry || !Number.isSafeInteger(at) || !Number.isSafeInteger(started) ||
      started > now + 30000 || at > now + 30000 ||
      !Number.isSafeInteger(life) || life < 0 || life > 300000 ||
      !Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > (entry ? 2592000 : 60)
    ) {
      return new Response(null, { status: 400 })
    }

    this.sweepExpired(now)
    const winner = this.storage.transactionSync(() => {
      const current = this.findQrObservation(code, now)
      if (current && current.started >= started) return current
      const next = { entry, at, life, started }
      this.storage.sql.exec(
        'INSERT OR REPLACE INTO qr_observations (code, expires, observation) VALUES (?, ?, ?)',
        code, Math.min(at, now) + ttlSeconds * 1000, JSON.stringify(next),
      )
      return next
    })
    return Response.json(winner)
  }
}

export default { fetch: () => new Response(null, { status: 404 }) }
