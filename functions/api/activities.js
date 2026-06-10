// Canonical Airtable field names. These match the live schema as of the
// 2026 cleanup — keep in sync if you rename anything in Airtable.
const FIELDS = {
  name: 'Activity Name',
  location: 'Location',
  address: 'Address',
  activityType: 'Activity Type',
  intensity: 'Intensity',
  costCategory: 'Cost Category',
  format: 'Virtual/In-Person/Hybrid',
  daysOfWeek: 'Days of Week',
}

// Only this constant formula is ever sent to Airtable. User input is applied
// as plain JavaScript filtering below, so there is no way for a search term
// to alter the formula (formula injection) or break the request with quotes.
const ACTIVE_FORMULA = `{Status} = 'Active'`

const EDGE_CACHE_SECONDS = 300 // one shared upstream payload serves every filter combination
const BROWSER_CACHE_SECONDS = 60

const JSON_HEADERS = {
  'Content-Type': 'application/json',
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': `public, max-age=${BROWSER_CACHE_SECONDS}`,
}

// Airtable values can be strings, numbers, or arrays (multipleSelects).
// Coerce to one comparable lowercase string the same way Airtable does
// when a formula reads a multi-select field (comma-joined).
function fieldText(value) {
  if (value == null) return ''
  const s = Array.isArray(value) ? value.map(v => String(v ?? '')).join(', ') : String(value)
  return s.trim().toLowerCase()
}

function includesCI(fieldValue, needle) {
  const n = String(needle || '').trim().toLowerCase()
  return n !== '' && fieldText(fieldValue).includes(n)
}

function equalsCI(fieldValue, wanted) {
  return fieldText(fieldValue) === String(wanted || '').trim().toLowerCase()
}

// Fetch every Active record, going through the edge cache first. All requests
// share one cached payload regardless of their filters, which keeps us far
// away from Airtable's 5 req/s rate limit even under heavy traffic.
async function fetchActiveRecords(env, waitUntil) {
  const cacheKey = new Request(
    `https://edge-cache.internal/airtable-active/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`
  )
  let cache = null
  try {
    cache = caches.default
    const hit = await cache.match(cacheKey)
    if (hit) return await hit.json()
  } catch {
    cache = null // Cache API unavailable (some local dev setups) — fall through
  }

  const airtableBase = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}`
  let allRecords = []
  let offset

  do {
    const url = new URL(airtableBase)
    url.searchParams.set('filterByFormula', ACTIVE_FORMULA)
    url.searchParams.set('pageSize', '100')
    if (offset) url.searchParams.set('offset', offset)

    const res = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` },
    })
    if (!res.ok) throw new Error(`Airtable upstream error: ${res.status}`)

    const data = await res.json()
    allRecords = allRecords.concat(data.records)
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

  if (!env.AIRTABLE_PAT) {
    return Response.json({ error: 'Server configuration error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }

  const { searchParams } = new URL(request.url)
  const q = (searchParams.get('q') || '').trim()
  const type = searchParams.getAll('type')
  const intensity = searchParams.getAll('intensity')
  const cost = searchParams.getAll('cost')
  const format = searchParams.getAll('format')
  const daysOfWeek = searchParams.getAll('daysOfWeek')

  let records
  try {
    records = await fetchActiveRecords(env, context.waitUntil ? context.waitUntil.bind(context) : null)
  } catch {
    return Response.json(
      { error: 'Could not reach the activity database. Please try again shortly.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const matches = records.filter(({ fields: f = {} }) => {
    if (q && !(
      includesCI(f[FIELDS.name], q) ||
      includesCI(f[FIELDS.location], q) ||
      includesCI(f[FIELDS.address], q)
    )) return false
    if (type.length && !type.some(t => includesCI(f[FIELDS.activityType], t))) return false
    if (intensity.length && !intensity.some(i => includesCI(f[FIELDS.intensity], i))) return false
    if (cost.length && !cost.some(c => equalsCI(f[FIELDS.costCategory], c))) return false
    if (format.length && !format.some(v => equalsCI(f[FIELDS.format], v))) return false
    if (daysOfWeek.length && !daysOfWeek.some(d => includesCI(f[FIELDS.daysOfWeek], d))) return false
    return true
  })

  return Response.json({ records: matches }, { headers: JSON_HEADERS })
}
