import { claimAirtableAction } from './airtable.js'

const localWindows = new Map()
const MAX_LOCAL_WINDOWS = 2000
const HOUR_MS = 3600000
const encoder = new TextEncoder()

export async function readFormObject(request, maxBytes) {
  const reader = request.body?.getReader()
  if (!reader) return {}
  try {
    const decoder = new TextDecoder('utf-8', { fatal: true })
    let length = 0
    let text = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > maxBytes) {
        await reader.cancel().catch(() => {})
        return { tooLong: true }
      }
      text += decoder.decode(value, { stream: true })
    }
    const data = JSON.parse(text + decoder.decode())
    return data && typeof data === 'object' && !Array.isArray(data) ? { data } : {}
  } catch {
    return {}
  } finally {
    reader.releaseLock()
  }
}

export async function claimFormAttempt({ request, env }, bucket, limit) {
  const ip = request.headers.get('CF-Connecting-IP')
  if (!ip) return true
  let key
  let claim
  try {
    const signingKey = await crypto.subtle.importKey(
      'raw', encoder.encode(env.AIRTABLE_WRITE_PAT), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )
    const digest = await crypto.subtle.sign('HMAC', signingKey, encoder.encode(ip))
    key = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    claim = await claimAirtableAction(env, bucket, key, HOUR_MS, limit)
  } catch {
    return undefined
  }
  if (claim !== null) return claim

  // Local admission is synchronous after digesting the address, so
  // concurrent requests in this isolate cannot overwrite a count.
  const windowKey = `${env.AIRTABLE_BASE_ID}:${bucket}:${key}`
  const now = Date.now()
  let window = localWindows.get(windowKey)
  if (!window || window.expires <= now) {
    localWindows.delete(windowKey)
    if (localWindows.size >= MAX_LOCAL_WINDOWS) localWindows.delete(localWindows.keys().next().value)
    window = { count: 0, expires: now + HOUR_MS }
    localWindows.set(windowKey, window)
  }
  if (window.count >= limit) return false
  window.count++
  return true
}

export function airtableBusy(status) {
  return status === 429 || status === 503
}
