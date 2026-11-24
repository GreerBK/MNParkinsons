import { ACTIVITY_FIELDS as FIELDS, activityPage } from '../_shared/activity-records.js'
import { centralCalendarDate, getActivityWeekdays } from '../../src/activitySchedule.js'

const EDGE_CACHE_SECONDS = 300 // one shared upstream payload serves every filter combination
const BROWSER_CACHE_SECONDS = 60

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': `public, max-age=${BROWSER_CACHE_SECONDS}`,
}

const normalized = value => String(value ?? '').trim().toLowerCase()

function hasChoice(value, selected) {
  const choices = Array.isArray(value) ? value : [value]
  return choices.some(choice => selected.includes(normalized(choice)))
}

// Fetch every Active record, going through the edge cache first. All requests
// share one cached payload regardless of their filters, which keeps us far
// away from Airtable's 5 req/s rate limit even under heavy traffic.
async function fetchActiveRecords(env, waitUntil) {
  const cacheKey = new Request(
    `https://edge-cache.internal/public-activities/v2/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`
  )
  let cache = null
  try {
    cache = caches.default
    const hit = await cache.match(cacheKey)
    if (hit) return await hit.json()
  } catch {
    cache = null // Cache API unavailable (some local dev setups) — fall through
  }

  const allRecords = []
  let offset

  do {
    const data = await activityPage(env, { offset })
    allRecords.push(...data.records)
    offset = data.offset
  } while (offset)

  if (cache) {
    const body = new Response(JSON.stringify(allRecords), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${EDGE_CACHE_SECONDS}`,
      },
    })
    const put = cache.put(cacheKey, body).catch(() => {})
    if (typeof waitUntil === 'function') waitUntil(put)
    else await put
  }

  return allRecords
}

export async function onRequestGet(context) {
  const { request, env } = context

  if (!env.AIRTABLE_PAT || !env.AIRTABLE_BASE_ID || !env.AIRTABLE_TABLE_ID) {
    return Response.json({ error: 'Server configuration error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }

  const { searchParams } = new URL(request.url)
  const q = normalized(searchParams.get('q'))
  const choices = key => searchParams.getAll(key).map(normalized).filter(Boolean)
  const type = choices('type')
  const intensity = choices('intensity')
  const cost = choices('cost')
  const format = choices('format')
  const daysOfWeek = choices('daysOfWeek')
  const today = daysOfWeek.length ? centralCalendarDate() : null

  let records
  try {
    records = await fetchActiveRecords(env, context.waitUntil ? context.waitUntil.bind(context) : null)
  } catch (error) {
    const busy = error.status === 429 || error.status === 503
    const headers = { 'Cache-Control': 'no-store' }
    if (busy) headers['Retry-After'] = error.retryAfter || '30'
    return Response.json(
      { error: 'Could not reach the activity database. Please try again shortly.' },
      { status: busy ? 503 : 502, headers }
    )
  }

  const matches = records.filter(({ fields: f = {} }) => {
    if (q && ![f[FIELDS.name], f[FIELDS.location], f[FIELDS.address]].some(value => normalized(value).includes(q))) {
      return false
    }
    if (type.length && !hasChoice(f[FIELDS.activityType], type)) return false
    const intensityValue = f[FIELDS.intensity]
    const intensityChoices = typeof intensityValue === 'string' ? intensityValue.split(/[,;]/) : intensityValue
    if (intensity.length && !hasChoice(intensityChoices, intensity)) return false
    if (cost.length && !hasChoice(f[FIELDS.costCategory], cost)) return false
    if (format.length && !hasChoice(f[FIELDS.format] || 'In-Person', format)) return false
    if (daysOfWeek.length && !hasChoice(getActivityWeekdays(f, today), daysOfWeek)) return false
    return true
  })

  return Response.json({ records: matches }, { headers: JSON_HEADERS })
}
