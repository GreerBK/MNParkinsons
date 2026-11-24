const GATE_ORIGIN = 'https://airtable-gate.invalid'

function gateFor(env) {
  const binding = env.AIRTABLE_GATE
  if (!binding || !env.AIRTABLE_BASE_ID) return null
  return binding.get(binding.idFromName(env.AIRTABLE_BASE_ID))
}

function unavailable() {
  return Response.json({ error: 'Activity database gateway is unavailable' }, {
    status: 503,
    headers: { 'Retry-After': '5', 'X-Airtable-Request-Sent': 'false' },
  })
}

// A Pages binding shares one request budget per base across every route and
// Cloudflare location. Direct Airtable requests support unbound local setups.
export async function airtableFetch(env, url, init = {}, { maxQueueMs } = {}) {
  if (!env.AIRTABLE_GATE || !env.AIRTABLE_BASE_ID) {
    return env.AIRTABLE_GATE_REQUIRED === 'true' ? unavailable() : fetch(url, init)
  }

  const headers = new Headers(init.headers)
  if (maxQueueMs !== undefined) headers.set('X-Airtable-Max-Queue-Ms', String(maxQueueMs))
  try {
    return await gateFor(env).fetch(String(url), { ...init, headers })
  } catch {
    // A response lost in transit can leave the upstream outcome ambiguous.
    // Let callers distinguish that from the explicit unsent responses above.
    return Response.json({ error: 'Activity database gateway did not respond' }, { status: 503 })
  }
}

// Fixed-window actions for cross-location throttling and short registration
// claims. A caller can use a local fallback when developing without a binding.
export async function claimAirtableAction(env, scope, key, windowMs, limit = 1) {
  if (!env.AIRTABLE_GATE || !env.AIRTABLE_BASE_ID) return env.AIRTABLE_GATE_REQUIRED === 'true' ? undefined : null

  try {
    const response = await gateFor(env).fetch(`${GATE_ORIGIN}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope, key, windowMs, limit }),
      signal: AbortSignal.timeout(2500),
    })
    if (response.status === 204) return true
    if (response.status === 429) return false
  } catch {
    // A gateway outage is different from a request exceeding the limit.
  }
}

async function qrObservation(env, code, init) {
  try {
    const gate = gateFor(env)
    if (!gate) return undefined
    const response = await gate.fetch(`${GATE_ORIGIN}/qr-cache/${encodeURIComponent(code)}`, {
      ...init,
      signal: AbortSignal.timeout(1000),
    })
    if (response.ok) return await response.json()
  } catch {
    // The caller can still use its remembered destination when available.
  }
}

export function readAirtableQrObservation(env, code) {
  return qrObservation(env, code)
}

export function publishAirtableQrObservation(env, code, observation, ttlSeconds) {
  return qrObservation(env, code, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ observation, ttlSeconds }),
  })
}
