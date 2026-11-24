// Traffic log for every /api/* request. Each request records one row in the
// "API Log" Airtable table so traffic is visible next to the site's data.
// Page views themselves are static files that never reach a Function — those
// are covered by Cloudflare Web Analytics. This log measures endpoint health,
// broad search-filter use, and popular activity pages.
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
//   - A purge of rows older than RETENTION_DAYS piggybacks on some
//     *successful* flushes (so never while rate-limited), oldest first, at
//     most once per PURGE_MIN_GAP_MS per isolate, and keeps going on later
//     flushes while a backlog remains. Keeps the table from eating the
//     base's record limit. No cron needed.
//
// So the log can't silently understate traffic: whenever rows had to be
// dropped (flood, rate limit, Airtable rejection), the next successful flush
// writes a "LOG GAP" row saying roughly how many requests went unrecorded.
// Filter Method = "GAP" to see them. Rows still in the buffer when an
// isolate is evicted are lost without a marker, though — this is a traffic
// log, not an audit trail.
//
// Store endpoint templates and approved filter labels. Request details that
// could identify a visitor are used only in memory where needed.

import { airtableFetch } from '../_shared/airtable.js'
import { APPROVED_FILTER_OPTIONS } from '../_shared/activity-schema.js'

const LOG_TABLE_ID = 'tblwtk9Q0bfg8uAYG' // "API Log" table (not secret)

const RETENTION_DAYS = 7 // keep modest: log rows share the base's record cap
const PURGE_PROBABILITY = 0.25 // chance a successful flush also prunes
const PURGE_MAX_BATCHES = 3 // ≤3 delete calls × 10 rows = ≤30 rows per prune
const PURGE_MIN_GAP_MS = 30000 // even with a backlog, prune at most this often per isolate

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
  status: 'Status',
  duration: 'Duration (ms)',
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
  ['type', 'Type', APPROVED_FILTER_OPTIONS.activityType],
  ['intensity', 'Intensity', APPROVED_FILTER_OPTIONS.intensity],
  ['cost', 'Cost', APPROVED_FILTER_OPTIONS.cost],
  ['format', 'Format', APPROVED_FILTER_OPTIONS.format],
  ['daysOfWeek', 'Day', APPROVED_FILTER_OPTIONS.daysOfWeek],
]
const MAX_FILTER_CHIPS = 8
const ENDPOINTS = new Set(['/api/activities', '/api/filter-options', '/api/report', '/api/submit'])
const METHODS = new Set(['GET', 'HEAD', 'POST', 'OPTIONS'])

// An activity-detail request, e.g. /api/activity/recAbC123… — capturing the
// record ID lets the log row link to the Activities table.
const ACTIVITY_PATH_RE = /^\/api\/activity\/(rec[a-zA-Z0-9]{14,17})$/

// Loose heuristic — good enough to separate "people browsing" from "scripts
// and crawlers" at a glance. An empty user agent is treated as a bot too.
const BOT_RE = /bot|crawl|spider|slurp|scrape|preview|fetch|monitor|probe|scan|headless|python|curl|wget|httpx|libwww|java\/|go-http/i

// Isolate-level shared state: requests served by the same isolate pool their
// rows here. JavaScript's single-threaded event loop makes push/splice safe.
const buffer = []
let lastFlushAt = 0
let backoffUntil = 0
let droppedCount = 0 // requests we couldn't log — reported via a LOG GAP row
let purgeBacklog = false // last prune found a full page: keep pruning until clear
let lastPurgeAt = 0 // start of the last prune; also keeps prunes from overlapping
let shedFlusherAt = 0 // last time a shed row restarted the flusher (a time, not a flag)

// Other functions can ask to be nudged whenever an API request passes
// through. The QR scan logger uses this: rows it could not write during one
// request get another chance on the visitor's next ordinary page load.
const nudges = []
export function onApiRequest(fn) {
  nudges.push(fn)
}

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
  for (const nudge of nudges) {
    try {
      nudge(context)
    } catch {
      // someone else's housekeeping must never affect logging or the response
    }
  }
  try {
    const { env, request } = context
    if (!env.AIRTABLE_WRITE_PAT || !env.AIRTABLE_BASE_ID) return
    if (buffer.length >= BUFFER_MAX) {
      droppedCount++ // flood — shed this row, but remember it happened
      // Shedding must not leave the buffer with nobody to empty it. After a
      // 429 every waiting flusher gives up before the 60 s backoff ends; if
      // the buffer filled in the meantime, each later request landed here
      // and returned, and this instance never logged again. So make sure a
      // flusher is alive, at most one per flusher lifetime.
      const now = Date.now()
      if (now - shedFlusherAt >= 4 * FLUSH_DELAY_MS) {
        shedFlusherAt = now
        const restart = flushSoon(env)
        if (typeof context.waitUntil === 'function') context.waitUntil(restart)
        else restart.catch(() => {})
      }
      return
    }

    buffer.push(buildFields(request, status, durationMs))
    const task = flushSoon(env)
    if (typeof context.waitUntil === 'function') context.waitUntil(task)
    else task.catch(() => {})
  } catch {
    // Logging must never affect the response.
  }
}

function buildFields(request, status, durationMs) {
  const url = new URL(request.url)
  const cf = request.cf || {}
  const userAgent = request.headers.get('user-agent') || ''
  const verifiedBot = cf.verifiedBotCategory ? String(cf.verifiedBotCategory).slice(0, 100) : ''
  const activityView = url.pathname.match(ACTIVITY_PATH_RE)
  const path = activityView || url.pathname.startsWith('/api/activity/')
    ? '/api/activity/:id'
    : ENDPOINTS.has(url.pathname) ? url.pathname : '/api/other'
  const method = METHODS.has(request.method) ? request.method : 'OTHER'

  // CUBOT is a phone brand whose name happens to contain "bot".
  const likelyBot = userAgent === '' || verifiedBot !== '' || BOT_RE.test(userAgent.replace(/cubot/gi, ''))

  const fields = {
    [F.summary]: `${method} ${path} · ${status}`,
    [F.time]: new Date().toISOString(),
    [F.method]: method,
    [F.path]: path,
    [F.status]: status,
    [F.duration]: Math.max(0, Math.round(durationMs)),
    [F.likelyBot]: likelyBot,
  }
  if (activityView && method === 'GET' && status === 200 && !likelyBot) fields[F.activity] = [activityView[1]]
  if (path === '/api/activities' && method === 'GET') {
    const chips = new Set()
    if (url.searchParams.get('q')?.trim()) chips.add('Keyword search')
    for (const [param, label, options] of FILTER_PARAMS) {
      const applied = new Set(url.searchParams.getAll(param).map(value => value.trim().toLowerCase()))
      for (const option of options) {
        if (chips.size >= MAX_FILTER_CHIPS) break
        if (applied.has(option.toLowerCase())) chips.add(`${label}: ${option}`)
      }
    }
    if (chips.size) fields[F.filtersUsed] = [...chips]
  }
  if (verifiedBot) fields[F.verifiedBot] = verifiedBot
  return fields
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Today's date in Minnesota, as "YYYY-MM-DD", for QR scan labels.
export function centralDay(now = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now)
    const get = (type) => parts.find((p) => p.type === type)?.value
    const y = get('year')
    const m = get('month')
    const d = get('day')
    if (y && m && d) return `${y}-${m}-${d}`
  } catch {
    // fall through
  }
  return now.toISOString().slice(0, 10)
}

// Wait for the burst to pool, then flush whenever the pacing rules allow.
// Bounded so the whole run stays inside waitUntil's 30-second grace: no
// flush starts after FLUSH_RUN_BUDGET_MS, and the purge (up to ~7 s of paced
// deletes) may only ride on an early flush. Rows we give up on are picked
// up by the next request's flusher.
const FLUSH_RUN_BUDGET_MS = 20000
const PURGE_ALLOWED_UNTIL_MS = 12000
async function flushSoon(env) {
  const started = Date.now()
  for (let i = 0; i < 4; i++) {
    await sleep(FLUSH_DELAY_MS)
    if (buffer.length === 0) return
    const now = Date.now()
    if (now - started > FLUSH_RUN_BUDGET_MS) return
    if (now < backoffUntil || now - lastFlushAt < FLUSH_MIN_GAP_MS) continue
    await flush(env, now - started < PURGE_ALLOWED_UNTIL_MS)
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

async function flush(env, mayPurge = false) {
  lastFlushAt = Date.now()
  // If rows were dropped since the last successful write, lead the batch
  // with a gap marker (counts are approximate — that's fine).
  const gap = droppedCount
  droppedCount = 0
  const batch = buffer.splice(0, gap > 0 ? 9 : 10)
  if (gap > 0) batch.unshift(gapFields(gap))
  if (batch.length === 0) return
  // If this batch is lost, what goes with it is its rows plus the count its
  // gap marker was carrying (the marker itself is not a request).
  const lostWithBatch = gap + batch.length - (gap > 0 ? 1 : 0)
  try {
    const res = await airtableFetch(env, `https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${LOG_TABLE_ID}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.AIRTABLE_WRITE_PAT}`,
        'Content-Type': 'application/json',
      },
      // Only static allowlisted labels can become new select options.
      body: JSON.stringify({ records: batch.map((fields) => ({ fields })), typecast: true }),
    }, { maxQueueMs: 300 })
    if (res.status === 429 || res.headers.get('X-Airtable-Request-Sent') === 'false') {
      // The base is rate limited — stand down entirely and try these rows
      // again after the storm (unless a flood has refilled the buffer).
      const retrySeconds = Number(res.headers.get('Retry-After'))
      backoffUntil = Date.now() + (res.status === 429 ? BACKOFF_MS : Math.max(2000, (retrySeconds || 0) * 1000))
      // The gap marker does not go back in the buffer: there it would look
      // like one more request row, and if this batch were lost on a later
      // attempt the number it carried would vanish. Its count goes back to
      // the counter, and the next flush writes a fresh marker.
      const rows = gap > 0 ? batch.slice(1) : batch
      droppedCount += gap
      if (buffer.length + rows.length <= BUFFER_MAX) buffer.unshift(...rows)
      else droppedCount += rows.length
      return
    }
    if (!res.ok) {
      // Airtable rejected the batch (bad token, schema drift, …) — the rows
      // are gone; make sure the loss shows up in the next gap marker.
      droppedCount += lostWithBatch
      return
    }
    // Only prune when the base just proved healthy, so the purge's extra
    // calls can never pile onto a rate-limit storm. Once a prune finds a
    // full page of old rows, keep pruning on later flushes until it is
    // clear (paced by PURGE_MIN_GAP_MS), so a backlog cannot build up again.
    if (mayPurge && (purgeBacklog || Math.random() < PURGE_PROBABILITY)) await purgeOldRows(env)
  } catch {
    droppedCount += lostWithBatch // network failure — batch lost
  }
}

// Delete up to PURGE_MAX_BATCHES × 10 rows older than RETENTION_DAYS. Runs
// on a fraction of flushes, so cleanup keeps pace with (and stays ahead of)
// write volume: rows only ever need deleting RETENTION_DAYS after being
// written, so lagging behind during a burst is fine.
async function purgeOldRows(env) {
  // Time-based only, so an abandoned run (waitUntil expiring mid-sleep)
  // can never leave a stuck "in progress" flag behind.
  if (Date.now() - lastPurgeAt < PURGE_MIN_GAP_MS) return
  lastPurgeAt = Date.now()
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
    // Oldest first, so the table's horizon actually moves; unsorted, the
    // purge nibbled arbitrary old rows and the oldest lingered for weeks.
    listUrl.searchParams.set('sort[0][field]', F.time)
    listUrl.searchParams.set('sort[0][direction]', 'asc')
    const res = await airtableFetch(env, listUrl, {
      headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` },
    }, { maxQueueMs: 300 })
    if (res.status === 429) {
      // Same rule as the flush: the base is rate limited, stand down.
      backoffUntil = Date.now() + BACKOFF_MS
      return
    }
    if (!res.ok) {
      console.warn(`traffic log purge: list returned ${res.status}`)
      return
    }
    const ids = ((await res.json()).records || []).map((r) => r.id)
    purgeBacklog = ids.length >= PURGE_MAX_BATCHES * 10

    for (let i = 0; i < ids.length; i += 10) {
      await sleep(FLUSH_MIN_GAP_MS) // pace deletes like everything else
      const deleteUrl = new URL(tableUrl)
      for (const id of ids.slice(i, i + 10)) deleteUrl.searchParams.append('records[]', id)
      const del = await airtableFetch(env, deleteUrl, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${env.AIRTABLE_WRITE_PAT}` },
      }, { maxQueueMs: 300 })
      if (del.status === 429) {
        backoffUntil = Date.now() + BACKOFF_MS
        return
      }
      if (!del.ok) {
        console.warn(`traffic log purge: delete returned ${del.status}`)
        return // the next pass will catch up
      }
    }
  } catch (err) {
    // Best-effort cleanup — never let it surface anywhere.
    console.warn('traffic log purge failed', err && err.message)
  }
}
