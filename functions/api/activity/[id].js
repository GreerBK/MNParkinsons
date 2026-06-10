// Airtable record IDs are "rec" + 14–17 alphanumerics. Validating the shape
// before building the upstream URL prevents crafted IDs (e.g. encoded "../")
// from steering the authenticated request at other Airtable API endpoints.
const RECORD_ID_RE = /^rec[a-zA-Z0-9]{14,17}$/

const EDGE_CACHE_SECONDS = 300
const BROWSER_CACHE_SECONDS = 60

const notFound = () =>
  Response.json({ error: 'Activity not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

export async function onRequestGet(context) {
  const { env, params, request } = context
  const pat = env.AIRTABLE_PAT
  const baseId = env.AIRTABLE_BASE_ID
  const tableId = env.AIRTABLE_TABLE_ID

  if (!pat) return Response.json({ error: 'Server configuration error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })

  const id = String(params.id || '')
  if (!RECORD_ID_RE.test(id)) return notFound()

  // Serve repeat views of the same activity from the edge cache.
  let cache = null
  try {
    cache = caches.default
    const hit = await cache.match(request)
    if (hit) return hit
  } catch {
    cache = null
  }

  let res
  try {
    res = await fetch(`https://api.airtable.com/v0/${baseId}/${tableId}/${id}`, {
      headers: { Authorization: `Bearer ${pat}` },
    })
  } catch {
    return Response.json(
      { error: 'Could not reach the activity database. Please try again shortly.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    )
  }
  if (res.status === 404 || res.status === 403) return notFound()
  if (!res.ok) {
    return Response.json(
      { error: 'Could not reach the activity database. Please try again shortly.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } }
    )
  }

  const record = await res.json()
  // The list endpoint only ever exposes Active records — apply the same rule
  // here so direct links can't surface Pending/Inactive rows.
  if (record?.fields?.['Status'] !== 'Active') return notFound()

  const response = Response.json(record, {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': `public, max-age=${BROWSER_CACHE_SECONDS}, s-maxage=${EDGE_CACHE_SECONDS}`,
    },
  })

  if (cache) {
    const put = cache.put(request, response.clone()).catch(() => {})
    if (context.waitUntil) context.waitUntil(put)
    else await put
  }

  return response
}
