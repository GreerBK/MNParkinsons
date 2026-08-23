// Traffic log for every /api/* request. Each request records one row in the
// "API Log" Airtable table so traffic is visible next to the site's data.
// Page views themselves are static files that never reach a Function — those
// are covered by Cloudflare Web Analytics; this log answers "who is calling
// the API, from where, for what, and did it work".
//
// Logging must NEVER break, slow, or alter an API response — and because
// Airtable allows only ~5 requests/second PER BASE (shared with the real API
// routes, with a ~30s lockout if exceeded), it must also never compete with
// them for that budget. So the logger is deliberately meek:
//
//   - Rows buffer in isolate memory and flush up to 10 per Airtable call
//     (Airtable's batch limit), a few seconds behind, never more than one
//     flush per FLUSH_MIN_GAP_MS across the isolate.
//   - Any 429 from Airtable opens a circuit breaker: the batch is re-queued
//     and all log traffic pauses for BACKOFF_MS. The log yields; it never
//     retries into a rate-limit storm.
//   - The buffer is capped. Under a flood, overflow rows are dropped —
//     losing log rows is always preferred over touching the shared budget.
//   - A purge of rows older than RETENTION_DAYS piggybacks on a small
//     fraction of *successful* flushes (so never while rate-limited),
//     keeping the table from eating the base's record limit. No cron needed.
//
// So the log can't silently understate traffic: whenever rows had to be
// dropped (flood, rate limit, Airtable rejection), the next successful flush
// writes a "LOG GAP" row saying roughly how many requests went unrecorded.
// Filter Method = "GAP" to see them. Rows still in the buffer when an
// isolate is evicted are lost without a marker, though — this is a traffic
// log, not an audit trail.
//
// Privacy: no IP addresses and no request bodies are ever logged — only
// coarse Cloudflare geo (country/region/city), the URL, and the user agent.

const LOG_TABLE_ID = 'tblwtk9Q0bfg8uAYG' // "API Log" table (not secret)

const RETENTION_DAYS = 7 // keep modest: log rows share the base's record cap
const PURGE_PROBABILITY = 0.1 // chance a successful flush also prunes
const PURGE_MAX_BATCHES = 3 // ≤3 delete calls × 10 rows = ≤30 rows per prune

const FLUSH_DELAY_MS = 4000 // let a burst's rows pool into one batch
const FLUSH_MIN_GAP_MS = 2000 // ≥2s between Airtable calls from this isolate
const BACKOFF_MS = 60000 // silence after any 429 (Airtable lockout is ~30s)
const BUFFER_MAX = 40 // beyond this a flood is underway — shed rows

// Field names in the API Log table — keep in sync if renamed in Airtable.
const F = {
  summary: 'Request',
  time: 'Time',
  method: 'Method',
  path: 'Path',
  query: 'Query',
  status: 'Status',
  duration: 'Duration (ms)',
  country: 'Country',
  region: 'Region',
  city: 'City',
  userAgent: 'User agent',
  referer: 'Referer',
  likelyBot: 'Likely bot',
  verifiedBot: 'Verified bot',
  activity: 'Activity', // link to the viewed activity → powers per-activity view counts
  filtersUsed: 'Filters used', // one multi-select chip per applied finder filter
}

// Finder filter params (as sent to /api/activities) → chip label prefixes.
// Each applied filter becomes its own "Label: value" chip in a multi-select,
// so a chart on that field counts every filter individually even when one
// request applies several at once.
const FILTER_PARAMS = [
  ['type', 'Type'],
  ['intensity', 'Intensity'],
  ['cost', 'Cost'],
  ['format', 'Format'],
  ['daysOfWeek', 'Day'],
]
const MAX_FILTER_CHIPS = 8
// The flush writes with typecast:true so not-yet-seen filter values become
// new chips automatically — this pattern keeps hand-crafted URL junk from
// minting garbage chips. Values that fail it are simply not recorded.
const CHIP_VALUE_RE = /^[\w /:'&().,-]{1,120}$/

// An activity-detail request, e.g. /api/activity/recAbC123… — capturing the
// record ID lets the log row link to the Activities table.
const ACTIVITY_PATH_RE = /^\/api\/activity\/(rec[a-zA-Z0-9]{14,17})$/

// Loose heuristic — good enough to separate "people browsing" from "scripts
// and crawlers" at a glance. An empty user agent is treated as a bot too.
const BOT_RE = /bot|crawl|spider|slurp|scrape|preview|fetch|monitor|probe|scan|headless|python|curl|wget|httpx|libwww|java\/|go-http/i

// All control characters (a decoded query could smuggle \r\n to fake extra
// log lines in the cell, so unlike report.js this strips newlines/tabs too).
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g

// Isolate-level shared state: requests served by the same isolate pool their
// rows here. JavaScript's single-threaded event loop makes push/splice safe.
const buffer = []
let lastFlushAt = 0
let backoffUntil = 0
let droppedCount = 0 // requests we couldn't log — reported via a LOG GAP row

export async function onRequest(context) {
  const started = Date.now()
  let response
  try {
    response = await context.next()
  } catch (err) {
    // The route itself crashed — record it as a 500, then let Pages produce
    // its normal error response.
    logRequest(context, 500, Date.now() - started)
    throw err
  }
  logRequest(context, response.status, Date.now() - started)
  return response
}

// Buffer the row and schedule a delayed flush, without ever throwing.
function logRequest(context, status, durationMs) {
  try {
    const { env, request } = context
    if (!env.AIRTABLE_WRITE_PAT || !env.AIRTABLE_BASE_ID) return
    if (buffer.length >= BUFFER_MAX) {
      droppedCount++ // flood — shed this row, but remember it happened
      return
    }

    buffer.push(buildFields(request, status, durationMs))

    const flusher = flushSoon(env)
    if (typeof context.waitUntil === 'function') context.waitUntil(flusher)
    else flusher.catch(() => {})
  } catch {
    // Logging must never affect the response.
  }
}

function clean(value, max) {
  return String(value).replace(CONTROL_CHARS_RE, '').slice(0, max)
}

function buildFields(request, status, durationMs) {
  const url = new URL(request.url)
  const cf = request.cf || {}
  const userAgent = request.headers.get('user-agent') || ''
  const referer = request.headers.get('referer') || ''
  // Cloudflare cryptographically verifies major crawlers (Googlebot, Bingbot,
  // …) and names the category here — unlike the user agent, this can't lie.
  const verifiedBot = cf.verifiedBotCategory ? String(cf.verifiedBotCategory) : ''
  const path = clean(url.pathname, 250)
  // Decode parameter-by-parameter so "q=tai%20chi%26balance" logs readably
  // but a %26 inside a value can't masquerade as an extra "&" delimiter.
  const query = [...url.searchParams]
    .map(([key, value]) => (value === '' ? key : `${key}=${value}`))
    .join(' & ')

  const likelyBot = userAgent === '' || verifiedBot !== '' || BOT_RE.test(userAgent)

  const fields = {
    [F.summary]: `${request.method} ${path} · ${status}`,
    [F.time]: new Date().toISOString(),
    [F.method]: request.method,
    [F.path]: path,
    [F.status]: status,
    [F.duration]: Math.max(0, Math.round(durationMs)),
    [F.likelyBot]: likelyBot,
  }
  // A person successfully viewed an activity page — link the row to that
  // activity so its "Views (last 7 days)" count picks it up. The 200 check
  // guarantees the record exists (the route just fetched it), so the link
  // can't make Airtable reject the batch.
  const activityView = url.pathname.match(ACTIVITY_PATH_RE)
  if (activityView && status === 200 && !likelyBot) fields[F.activity] = [activityView[1]]
  // Record which finder filters were applied (activities endpoint only).
  if (url.pathname === '/api/activities') {
    const chips = new Set()
    for (const [param, label] of FILTER_PARAMS) {
      for (const value of url.searchParams.getAll(param)) {
        const v = clean(value, 120).trim()
        if (v && CHIP_VALUE_RE.test(v) && chips.size < MAX_FILTER_CHIPS) {
          chips.add(`${label}: ${v}`)
        }
      }
    }
    if (chips.size) fields[F.filtersUsed] = [...chips]
  }
  if (verifiedBot) fields[F.verifiedBot] = clean(verifiedBot, 100)
  if (query) fields[F.query] = clean(query, 250)
  if (cf.country) fields[F.country] = clean(cf.country, 100)
  if (cf.region) fields[F.region] = clean(cf.region, 100)
  if (cf.city) fields[F.city] = clean(cf.city, 100)
  if (userAgent) fields[F.userAgent] = clean(userAgent, 300)
  if (referer) fields[F.referer] = clean(referer, 300)
  return fields
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Wait for the burst to pool, then flush whenever the pacing rules allow.
// Bounded loop so we stay well inside waitUntil's grace period; rows we
// give up on are picked up by the next request's flusher.
async function flushSoon(env) {
  for (let i = 0; i < 4; i++) {
    await sleep(FLUSH_DELAY_MS)
    if (buffer.length === 0) return
    const now = Date.now()
    if (now < backoffUntil || now - lastFlushAt < FLUSH_MIN_GAP_MS) continue
    await flush(env)
    if (buffer.length === 0) return
  }
}

// A stand-in row for requests that couldn't be logged, so a quiet-looking
// log never means "quiet site" when it was really "logger overwhelmed".
function gapFields(count) {
  return {
    [F.summary]: `LOG GAP · about ${count} request${count === 1 ? '' : 's'} not recorded`,
    [F.time]: new Date().toISOString(),
    [F.method]: 'GAP',
  }
}

async function flush(env) {
  lastFlushAt = Date.now()
  // If rows were dropped since the last successful write, lead the batch
  // with a gap marker (counts are approximate — that's fine).
  const gap = droppedCount
  droppedCount = 0
  const batch = buffer.splice(0, gap > 0 ? 9 : 10)
  if (gap > 0) batch.unshift(gapFields(gap))
  if (batch.length === 0) return
  try {
    const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${LOG_TABLE_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.AIRTABLE_WRITE_PAT}`,
        'Content-Type': 'application/json',
      },
      // typecast lets Airtable auto-create a new "Filters used" chip when a
      // new Activity Type (etc.) appears, instead of rejecting the batch.
      body: JSON.stringify({ records: batch.map((fields) => ({ fields })), typecast: true }),
    })
    if (res.status === 429) {
      // The base is rate limited — stand down entirely and try these rows
      // again after the storm (unless a flood has refilled the buffer).
      backoffUntil = Date.now() + BACKOFF_MS
      if (buffer.length + batch.length <= BUFFER_MAX) buffer.unshift(...batch)
      else droppedCount += batch.length
      return
    }
    if (!res.ok) {
      // Airtable rejected the batch (bad token, schema drift, …) — the rows
      // are gone; make sure the loss shows up in the next gap marker.
      droppedCount += batch.length
      return
    }
    // Only prune when the base just proved healthy, so the purge's extra
    // calls can never pile onto a rate-limit storm.
    if (Math.random() < PURGE_PROBABILITY) await purgeOldRows(env)
  } catch {
    droppedCount += batch.length // network failure — batch lost
  }
}

// Delete up to PURGE_MAX_BATCHES × 10 rows older than RETENTION_DAYS. Runs
// on a fraction of flushes, so cleanup keeps pace with (and stays ahead of)
// write volume: rows only ever need deleting RETENTION_DAYS after being
// written, so lagging behind during a burst is fine.
async function purgeOldRows(env) {
  try {
    const tableUrl = `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${LOG_TABLE_ID}`

    // List with the read token — it's the one guaranteed to have read scope.
    const listUrl = new URL(tableUrl)
    listUrl.searchParams.set(
      'filterByFormula',
      `IS_BEFORE({${F.time}}, DATEADD(NOW(), -${RETENTION_DAYS}, 'days'))`
    )
    listUrl.searchParams.set('pageSize', String(PURGE_MAX_BATCHES * 10))
    listUrl.searchParams.append('fields[]', F.time) // keep the response small
    const res = await fetch(listUrl, {
      headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` },
    })
    if (!res.ok) return
    const ids = ((await res.json()).records || []).map((r) => r.id)

    for (let i = 0; i < ids.length; i += 10) {
      await sleep(FLUSH_MIN_GAP_MS) // pace deletes like everything else
      const deleteUrl = new URL(tableUrl)
      for (const id of ids.slice(i, i + 10)) deleteUrl.searchParams.append('records[]', id)
      const del = await fetch(deleteUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.AIRTABLE_WRITE_PAT}` },
      })
      if (!del.ok) return // e.g. rate limited — the next pass will catch up
    }
  } catch {
    // Best-effort cleanup — never let it surface anywhere.
  }
}
