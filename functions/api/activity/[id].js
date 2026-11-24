import { activityPage, isActivityId } from '../../_shared/activity-records.js'

const EDGE_CACHE_SECONDS = 300
const BROWSER_CACHE_SECONDS = 60

const notFound = () =>
  Response.json({ error: 'Activity not found' }, { status: 404, headers: { 'Cache-Control': 'no-store' } })

export async function onRequestGet(context) {
  const { env, params } = context
  if (!env.AIRTABLE_PAT || !env.AIRTABLE_BASE_ID || !env.AIRTABLE_TABLE_ID) {
    return Response.json({ error: 'Server configuration error' }, { status: 500, headers: { 'Cache-Control': 'no-store' } })
  }

  const id = String(params.id || '')
  if (!isActivityId(id)) return notFound()

  // Serve repeat views of the same activity from the edge cache.
  const cacheKey = new Request(
    `https://edge-cache.internal/public-activity/v2/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_ID}/${id}`
  )
  let cache = null
  try {
    cache = caches.default
    const hit = await cache.match(cacheKey)
    if (hit) return hit
  } catch {
    cache = null
  }

  let record
  try {
    const { records } = await activityPage(env, { id })
    record = records[0]
  } catch (error) {
    const busy = error.status === 429 || error.status === 503
    const headers = { 'Cache-Control': 'no-store' }
    if (busy) headers['Retry-After'] = error.retryAfter || '30'
    return Response.json(
      { error: 'Could not reach the activity database. Please try again shortly.' },
      { status: busy ? 503 : 502, headers }
    )
  }
  if (!record) return notFound()

  const response = Response.json(record, {
    headers: {
      'Content-Type': 'application/json',
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': `public, max-age=${BROWSER_CACHE_SECONDS}, s-maxage=${EDGE_CACHE_SECONDS}`,
    },
  })

  if (cache) {
    const put = cache.put(cacheKey, response.clone()).catch(() => {})
    if (context.waitUntil) context.waitUntil(put)
    else await put
  }

  return response
}
