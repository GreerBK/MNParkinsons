// Tracked QR codes: /q/<code> records the scan, then redirects.
//
// Every printed QR code gets its own row in the "QR Codes" Airtable table.
// The code points here rather than straight at the site, which buys two
// things: each scan lands in the "QR Scans" table (so we can tell the clinic
// poster from the symposium flyer), and the Destination can be changed in
// Airtable after the code is printed.
//
//   /q/udall-flyer       → logs the scan, 302 to the row's Destination (home
//                          page when blank) with ?src=udall-flyer attached
//   /q/udall-flyer.png   → the QR code picture for that link (not a scan)
//   /q/udall-flyer.svg   → same, as a vector for large print
//
// Codes do not have to be set up first. Any well-formed code works: the
// first time a person scans one that has no row yet, the row is created for
// them (Name = the code, home page as the destination). So making a new
// tracked code is just making up a link. The price is the odd junk row from
// a mistyped address, which is fine to delete.
//
// Three rules shape everything below:
//
//   1. A scan must ALWAYS end up on the site, and quickly. The visitor waits
//      at most LOOKUP_WAIT_MS for Airtable; after that they are sent to the
//      last destination we knew for the code, or to the home page. Counting
//      carries on in the background.
//   2. This route must never spend the Airtable base's shared limits: 5
//      requests a second (then a 30-second lockout for the whole site) and a
//      cap on total records. So every Airtable call has a time limit, lookups
//      are shared and rationed, one 429 silences this route for half a
//      minute, and every kind of row it can write has a ceiling.
//   3. Nothing may get stuck. All shared state is a timestamp or a small
//      counter that expires by itself, never an "in progress" flag: Cloudflare
//      can cut a request's background work off at any await.
//
// Scans are stored permanently (unlike the API Log, which is pruned), with
// the same privacy line as the log: coarse Cloudflare geo and the anonymous
// daily visitor code, never an IP address. Visits that are clearly not a
// person opening the link (crawlers, link previews, scripts) are redirected
// but not stored at all.

import qrcode from 'qrcode-generator'
import { centralDay, clean, onApiRequest, visitorHash } from '../api/_middleware.js'

// The one address printed codes point at. QR pictures always encode this
// origin, whatever host the picture was opened on: a code saved from a
// preview deployment must not point at the preview.
const SITE_ORIGIN = 'https://mnparkinsons.org'
// Other names the production site answers on. A Destination on any of them
// is still "our site" (it gets the ?src= tag and the /q/ loop guard).
const SITE_HOSTS = new Set(['mnparkinsons.org', 'www.mnparkinsons.org', 'mnparkinsons.pages.dev'])

const CODES_TABLE_ID = 'tblgaqbbtNDczqxcs' // "QR Codes" table (not secret)
const SCANS_TABLE_ID = 'tblicawiiqBb5et6g' // "QR Scans" table (not secret)

// Field names — keep in sync if renamed in Airtable.
const CODE_FIELD = 'Code'
const DESTINATION_FIELD = 'Destination'
const NAME_FIELD = 'Name' // best effort: a new row is still created without it
const NOTES_FIELD = 'Notes' // best effort, likewise
const S = {
  summary: 'Scan',
  time: 'Time',
  code: 'QR Code',
  city: 'City',
  region: 'Region',
  country: 'Country',
  visitor: 'Visitor',
}

// The shape doubles as injection-proofing: a code that passes it is safe to
// place inside the Airtable formula and the cache key below.
const CODE_RE = /^([a-z0-9][a-z0-9-]{0,39})(?:\.(png|svg))?$/

// ── Time limits ────────────────────────────────────────────────────────────
const LOOKUP_WAIT_MS = 2500 // the longest a visitor waits for Airtable before being sent on
const AIRTABLE_TIMEOUT_MS = 8000 // hard limit on any single Airtable call
// Cloudflare gives background work 30 seconds after the response. Everything
// a request starts is planned to finish inside this, measured from its start.
const WINDOW_MS = 27000
const BACKOFF_MS = 31000 // after a 429: Airtable's lockout is 30 seconds
// Every Airtable call this file makes, of any kind, takes a turn through one
// gate, and turns are at least this far apart. So a server instance can never
// send more than about three calls a second from here, whatever the mix of
// lookups, new codes and scan writes, which leaves the rest of the site its
// share of the base's five.
const CALL_GAP_MS = 350
const MAX_QUEUE_MS = 4000 // a call that would wait longer than this for its turn is not made
const POLL_MS = 100

// ── What we remember about codes ───────────────────────────────────────────
const FRESH_MS = 300000 // a known row is trusted this long: a changed Destination takes effect within it
const UNKNOWN_MS = 60000 // "no such code" is trusted this long
const STALE_SECONDS = 7 * 86400 // how long a known row can still be reused when Airtable cannot be asked
const MEMO_MAX = 500

// ── Rations (per server instance unless noted) ─────────────────────────────
// A ration is a bucket of `capacity` tokens that regains one every
// `refillMs`. Each kind of Airtable work draws from its own bucket.
const ration = (capacity, refillMs) => ({ capacity, refillMs, tokens: capacity, at: 0 })
// Lookups that are not already remembered. At most 3 at once and one more a
// second, so made-up addresses can never use up the base's 5 requests/second.
const personLookups = ration(3, 1000)
const otherLookups = ration(1, 3000) // crawlers, previews and HEAD get a thinner share
// Rows created for never-seen codes: a burst brake here, plus DAILY_CREATE_MAX
// below, which is counted in Airtable and so holds across every instance.
const createRation = ration(5, 12000)
const DAILY_CREATE_MAX = 20 // new QR Codes rows per 24 hours before self-creation pauses
const TWIN_CHECK_DELAY_MS = 1200
// Scan rows. One "visitor" (network address + browser) may add 150 at once
// and then one every 5 minutes: roomy enough for a hall of people on one
// venue Wi-Fi, far too slow for a loop. And no instance writes more than 600
// an hour, whoever is asking.
const VISITOR_SCANS = [150, 300000]
const VISITOR_KEYS_MAX = 2000
const visitorScans = new Map() // "code|visitor" → ration
const instanceScans = ration(600, 6000)

// ── Writing scans ──────────────────────────────────────────────────────────
// Rows pool in memory and go out up to 10 per Airtable call (its batch
// limit), never more than one call per FLUSH_GAP_MS from this instance.
const FLUSH_DELAY_MS = 1500 // let a burst pool into one call
const FLUSH_GAP_MS = 1000
// With this many rows waiting (a crowd, or the end of a lockout) the one-a-
// second politeness is dropped and rows go out as fast as the gate allows,
// so a backlog clears while the requests that can still write it are alive.
const BACKLOG_ROWS = 30
const FLUSH_POLL_MS = 100
// A write run says "still here" before each Airtable call. The longest it can
// then be silent is a wait at the gate plus one call's time limit; silence
// beyond that means its request was cut off, and another request takes over.
const FLUSH_STALE_MS = MAX_QUEUE_MS + AIRTABLE_TIMEOUT_MS + 3000
const RETRY_PAUSE_MS = 4000 // after a 5xx or network error
const KICK_GAP_MS = 3000
const MARKER_GAP_MS = 600000 // at most one "NOT RECORDED" row per 10 minutes
const BUFFER_MAX = 200

const buffer = [] // { fields, code, solo? }
let dropped = 0 // scans not stored (limits, full buffer, failed writes) since the last marker row
let lastMarkerAt = 0
let flushOwner = 0 // serial number of the write run that currently has the buffer
let flushBeatAt = 0 // when that run last said "still here"; 0 = no run
let flushSerial = 0
let lastWriteAt = 0
let lastKickAt = 0
let writeHoldUntil = 0 // pause after a failed write
let backoffUntil = 0 // Airtable said 429: no calls of any kind from this route until then
let nextCallAt = 0 // the next free turn through the Airtable gate

const memo = new Map() // code → { entry, at }: entry is { id, destination } or null ("no such row")
const lookups = new Map() // code → when a lookup for it started (still running)
const creating = new Map() // code → when a create for it started (still running)
// How long such a start-time is believed. Past it, the request that began the
// work is taken to have been cut off, and the next one starts over.
const LOOKUP_STALE_MS = MAX_QUEUE_MS + AIRTABLE_TIMEOUT_MS + 1000
const CREATE_STALE_MS = 20000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const WAITING = Symbol('waiting')

function take(bucket, now) {
  if (bucket.at === 0) bucket.at = now
  const gained = Math.floor((now - bucket.at) / bucket.refillMs)
  if (gained > 0) {
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + gained)
    bucket.at += gained * bucket.refillMs
  }
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

function takeFor(buckets, key, [capacity, refillMs], now) {
  let bucket = buckets.get(key)
  if (!bucket) {
    if (buckets.size >= VISITOR_KEYS_MAX) buckets.delete(buckets.keys().next().value)
    bucket = ration(capacity, refillMs)
    buckets.set(key, bucket)
  }
  return take(bucket, now)
}

function keepAlive(context, promise) {
  if (typeof context.waitUntil === 'function') context.waitUntil(promise)
}

export async function onRequest(context) {
  const { request, params } = context
  const url = new URL(request.url)
  const home = new URL('/', url.origin)
  const deadline = Date.now() + WINDOW_MS

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  const match = String(params.code || '').toLowerCase().match(CODE_RE)
  if (!match) return redirect(home)
  const [, code, imageType] = match

  if (imageType) return qrImage(context, `${SITE_ORIGIN}/q/${code}`, code, imageType)

  kickFlush(context, deadline) // rows an earlier request could not write get another chance

  const person = isPerson(request)
  const { entry, late } = await lookupCode(context, code, person, deadline)
  // `late` is Airtable still answering after the visitor has been sent on.
  // Let it finish, so the answer is at least remembered for the next scan.
  if (late) keepAlive(context, late)

  if (entry) {
    if (person) {
      // A remembered row is good enough to redirect with. If the real answer
      // arrives and says the row is gone, there is nothing to count against.
      const id = late ? late.then((real) => (real ? real.id : real === null ? '' : entry.id)) : entry.id
      recordScan(context, code, id, deadline)
    }
    return redirect(destinationFor(entry.destination, url.origin, code))
  }

  // No such row, or Airtable could not say in time. Robots get the bare home
  // page; a person is sent on at once and the counting (creating the code's
  // row first if it truly does not exist) happens in the background.
  if (!person) return redirect(home)
  const id =
    entry === null
      ? createCode(context, code, deadline)
      : late
        ? late.then((real) => (real ? real.id : real === null ? createCode(context, code, deadline) : ''))
        : ''
  recordScan(context, code, id, deadline)
  return redirect(destinationFor('', url.origin, code))
}

// ── Person or robot ────────────────────────────────────────────────────────
//
// Only a person opening the link is counted, and only a person can make a
// new code's row appear. "Person" here means: a GET that looks like a browser
// loading a page. That takes more than not calling yourself a bot, because
// chat apps fetch a pasted link to build its preview (WhatsApp and Signal do
// it from the sender's own phone) and plenty of scripts send no bot name.

// Every phone and desktop browser's user agent starts like this.
const BROWSER_RE = /^Mozilla\/5\.0 \(/
// Crawlers and tools that borrow that opening still name themselves. Unlike
// the API log's list this one leaves out "scan": QR reader apps put it in
// their browser's user agent, and they are exactly who we are counting.
const ROBOT_RE =
  /\(compatible;|bot(?![a-z])|crawl|spider|slurp|scrape|preview|fetch|monitor|probe|headless|lighthouse|python|curl|wget|httpx|libwww|java\/|go-http/i

function isPerson(request) {
  if (request.method !== 'GET') return false // HEAD is a link checker
  const headers = request.headers
  const userAgent = headers.get('user-agent') || ''
  // CUBOT is a phone brand, not a robot.
  if (!BROWSER_RE.test(userAgent) || ROBOT_RE.test(userAgent.replace(/cubot/gi, ''))) return false
  if (request.cf?.verifiedBotCategory) return false // Cloudflare-verified crawler
  // A browser opening a page asks for HTML. Scripts and fetchers that fake a
  // browser name mostly ask for "anything" or nothing.
  if (!(headers.get('accept') || '').includes('text/html')) return false
  // Modern browsers say what kind of load this is; anything but a page
  // navigation (an <img>, a fetch() call) is not someone opening the link.
  const mode = headers.get('sec-fetch-mode')
  if (mode && mode !== 'navigate') return false
  // A browser guessing ahead of what the user typed has not opened it yet.
  const purpose = `${headers.get('sec-purpose') || ''} ${headers.get('purpose') || ''} ${headers.get('x-moz') || ''}`
  if (/prefetch|prerender/i.test(purpose)) return false
  return true
}

function redirect(target) {
  return new Response(null, {
    status: 302,
    headers: { Location: String(target), 'Cache-Control': 'no-store' },
  })
}

// Where a scan lands. Destinations on our own site get ?src=<code>, which
// then rides along as the Referer on that visit's API calls, so the API Log
// shows what visits that started from a given code went on to search for.
//
// The Destination cell is typed by hand and Airtable does not check it, so
// anything that is not clearly a usable address falls back to the home page:
// a scan must never land on a browser error.
function destinationFor(raw, origin, code) {
  const home = new URL('/', origin)
  let target = home
  const text = String(raw || '').trim()
  if (text) {
    try {
      // "mnparkinsons.org/#/submit" typed without a scheme is still a link.
      const absolute = /^https?:\/\//i.test(text) || /^[/#?]/.test(text) ? text : `https://${text}`
      const parsed = new URL(absolute, origin)
      parsed.username = ''
      parsed.password = ''
      // An old http:// link to our own site: same page, over https.
      if (parsed.protocol === 'http:' && SITE_HOSTS.has(parsed.hostname)) parsed.protocol = 'https:'
      // A real host name has a dot and a top-level domain. This is what stops
      // "submit" or "activity/rec…" from becoming https://submit/.
      const publicHost = /\.[a-z][a-z0-9-]*$/i.test(parsed.hostname)
      if (parsed.origin === origin || (parsed.protocol === 'https:' && publicHost)) target = parsed
    } catch {
      target = home
    }
  }
  if (target.origin === origin || (target.protocol === 'https:' && SITE_HOSTS.has(target.hostname))) {
    if (isQrPath(target.pathname)) target = home // never loop back here
    target.searchParams.set('src', code)
  }
  return target
}

function isQrPath(pathname) {
  let path = pathname
  try {
    path = decodeURIComponent(pathname)
  } catch {
    // keep the raw path
  }
  path = path.toLowerCase()
  return path === '/q' || path.startsWith('/q/')
}

// ── Talking to Airtable ────────────────────────────────────────────────────

// One Airtable call: through the gate, with a hard time limit. Never rejects.
// Resolves to { status, timedOut, body }. Status 0 means there is no answer:
// with timedOut the call was sent and Airtable did not reply in time (so it
// may or may not have taken effect); without it, nothing was sent at all.
async function airtable(env, token, path, init, deadline) {
  const unsent = { status: 0, timedOut: false, body: null }
  const asked = Date.now()
  if (asked < backoffUntil) return unsent // the base is rate limited: this route stays silent
  const turn = Math.max(asked, nextCallAt)
  if (turn - asked > MAX_QUEUE_MS || turn + 500 > deadline) return unsent // too busy, or out of time: do without
  nextCallAt = turn + CALL_GAP_MS
  if (turn > asked) {
    await sleep(turn - asked)
    if (Date.now() < backoffUntil) return unsent
  }
  const limit = Math.min(AIRTABLE_TIMEOUT_MS, deadline - Date.now())
  if (limit < 500) return unsent
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), limit)
  try {
    const headers = { Authorization: `Bearer ${token}` }
    if (init.body) headers['Content-Type'] = 'application/json'
    const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${path}`, {
      ...init,
      headers,
      signal: controller.signal,
    })
    // The base is rate limited: stand down entirely. Every Airtable call in
    // this file comes through here, so none of them can retry into the storm.
    if (res.status === 429) backoffUntil = Date.now() + BACKOFF_MS
    let body = null
    try {
      body = await res.json()
    } catch {
      body = null
    }
    return { status: res.status, timedOut: false, body }
  } catch {
    return { status: 0, timedOut: controller.signal.aborted, body: null }
  } finally {
    clearTimeout(timer)
  }
}

const normal = (value) => String(value || '').trim().toLowerCase()
const codeFormula = (code) => `LOWER(TRIM({${CODE_FIELD}}))='${code}'`

// Rows of QR Codes matching `formula`, oldest first. undefined when Airtable
// could not be asked. "Oldest first" matters: if a code ever has two rows,
// every instance settles on the same one.
async function listCodes(env, formula, max, deadline) {
  const query = new URLSearchParams({ filterByFormula: formula, maxRecords: String(max) })
  query.append('fields[]', CODE_FIELD)
  query.append('fields[]', DESTINATION_FIELD)
  const { status, body } = await airtable(env, env.AIRTABLE_PAT, `${CODES_TABLE_ID}?${query}`, {}, deadline)
  if (status !== 200 || !body || !Array.isArray(body.records)) return undefined
  return body.records
    .map((record) => ({
      id: record.id,
      created: Date.parse(record.createdTime) || 0,
      code: normal(record.fields?.[CODE_FIELD]),
      destination: record.fields?.[DESTINATION_FIELD] || '',
    }))
    .sort((a, b) => a.created - b.created || (a.id < b.id ? -1 : 1))
}

// The code's row: { id, destination }, null for "no such row", or undefined
// when Airtable could not be asked.
async function fetchCode(env, code, deadline) {
  const rows = await listCodes(env, codeFormula(code), 5, deadline)
  if (!rows) return undefined
  return rows.length ? { id: rows[0].id, destination: rows[0].destination } : null
}

// ── Remembering answers ────────────────────────────────────────────────────
//
// Two layers: a small map in this instance's memory, and Cloudflare's edge
// cache, which every instance in the same data centre shares. Each answer
// carries the time it was learned. Fresh answers are used as they are; an old
// answer about a known row is kept for days as a fallback, so a slow or
// rate-limited Airtable costs a scan its count at worst, never its redirect.

const cacheKeyFor = (code) => `https://qr-lookup.invalid/v2/${code}`
const isFresh = (known, now) => now - known.at < (known.entry ? FRESH_MS : UNKNOWN_MS)

function memoSet(code, entry, at) {
  memo.delete(code)
  memo.set(code, { entry, at })
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value)
}

async function readEdge(code) {
  try {
    const hit = await caches.default.match(cacheKeyFor(code))
    if (!hit) return undefined
    const data = await hit.json()
    const entry = data ? data.entry : undefined
    const sound = entry === null || (entry && typeof entry.id === 'string' && typeof entry.destination === 'string')
    if (sound && typeof data.at === 'number') return { entry, at: data.at }
  } catch {
    // no edge cache (local tests), or an entry we cannot read
  }
  return undefined
}

function rememberCode(context, code, entry) {
  const at = Date.now()
  memoSet(code, entry, at)
  try {
    const ttl = entry ? STALE_SECONDS : UNKNOWN_MS / 1000
    const put = caches.default
      .put(cacheKeyFor(code), Response.json({ entry, at }, { headers: { 'Cache-Control': `public, max-age=${ttl}` } }))
      .catch(() => {})
    keepAlive(context, put)
  } catch {
    // no edge cache: the memory map still serves this instance
  }
}

async function forgetCode(code) {
  memo.delete(code)
  try {
    await caches.default.delete(cacheKeyFor(code))
  } catch {
    // nothing to forget
  }
}

// Find the code's row without ever holding the visitor up for long.
//
// Resolves to { entry, late }:
//   entry  the row { id, destination } (possibly a remembered one), null when
//          there is definitely no such row, or undefined when Airtable could
//          not say within LOOKUP_WAIT_MS.
//   late   present when Airtable is still being asked; resolves to the real
//          answer (row, null, or undefined if it never came).
async function lookupCode(context, code, person, deadline) {
  const { env } = context
  if (!env.AIRTABLE_PAT || !env.AIRTABLE_BASE_ID) return { entry: undefined }

  let known = memo.get(code)
  if (!known || !isFresh(known, Date.now())) {
    // Another instance in this data centre may have asked more recently.
    const shared = await readEdge(code)
    if (shared && (!known || shared.at > known.at)) {
      known = shared
      memoSet(code, known.entry, known.at)
    }
  }
  if (known && isFresh(known, Date.now())) return { entry: known.entry }
  const remembered = known && known.entry ? known.entry : undefined

  const answer = askAirtable(context, code, person, deadline)
  const first = await Promise.race([answer, sleep(LOOKUP_WAIT_MS).then(() => WAITING)])
  if (first === WAITING) return { entry: remembered, late: answer }
  return { entry: first === undefined ? remembered : first }
}

// Ask Airtable about a code: one question per code at a time, within the
// lookup ration, and not at all while the base is rate limited. Requests that
// arrive while a question is already out wait for its answer instead of
// asking again: that is what keeps a room of people scanning one code at the
// same moment from becoming a burst of Airtable calls.
function askAirtable(context, code, person, deadline) {
  const now = Date.now()
  const flight = lookups.get(code)
  if (flight && now - flight < LOOKUP_STALE_MS) {
    return follow(lookups, code, flight, Math.min(deadline, flight + LOOKUP_STALE_MS), false)
  }
  if (now < backoffUntil || !take(person ? personLookups : otherLookups, now)) return Promise.resolve(undefined)
  expire(lookups, LOOKUP_STALE_MS, now)
  lookups.set(code, now)
  return fetchCode(context.env, code, deadline).then((found) => {
    if (found !== undefined) rememberCode(context, code, found)
    if (lookups.get(code) === now) lookups.delete(code)
    return found
  })
}

// Wait for another request's answer about `code` to show up in the memory
// map. Deliberately not "await the other request's promise": each request
// only ever waits on its own timers, so nothing here depends on how the
// runtime treats promises shared between requests, and a request that is cut
// off cannot leave others waiting on a promise that never settles.
// Resolves to the entry; with needRow, only an actual row counts.
async function follow(flights, code, flight, until, needRow) {
  while (Date.now() < until) {
    const known = memo.get(code)
    if (known && known.at >= flight && (known.entry || !needRow)) return known.entry
    if (flights.get(code) !== flight) break // the other request finished without an answer
    await sleep(POLL_MS)
  }
  return needRow ? null : undefined
}

// Drop start-times of work that should have finished long ago (its request
// was cut off), so the maps cannot grow.
function expire(flights, maxAge, now) {
  if (flights.size < 100) return
  for (const [key, startedAt] of flights) if (now - startedAt > maxAge) flights.delete(key)
}

// ── Creating a row for a new code ──────────────────────────────────────────

// Resolves to the record ID to count the scan against, or '' when no row
// could be made (rations, ceiling, Airtable trouble). Never rejects.
async function createCode(context, code, deadline) {
  const { env } = context
  try {
    if (!env.AIRTABLE_WRITE_PAT || !env.AIRTABLE_PAT || !env.AIRTABLE_BASE_ID) return ''
    const now = Date.now()
    const flight = creating.get(code)
    if (flight && now - flight < CREATE_STALE_MS) {
      // Another scan of the same new code is already creating it: use its row.
      const row = await follow(creating, code, flight, Math.min(deadline, flight + CREATE_STALE_MS), true)
      return row ? row.id : ''
    }
    if (now < backoffUntil || !take(createRation, now)) return ''
    expire(creating, CREATE_STALE_MS, now)
    creating.set(code, now)
    try {
      return await createRow(context, code, deadline)
    } finally {
      if (creating.get(code) === now) creating.delete(code)
    }
  } catch (err) {
    console.warn('qr code create failed', err && err.message)
    return ''
  }
}

async function createRow(context, code, deadline) {
  const { env } = context
  // One read answers two questions. Does the row exist after all? ("No such
  // code" may have been a remembered answer, and another instance may have
  // created it since.) And how many rows were added in the last 24 hours?
  // That count lives in Airtable, so it is one ceiling for every instance:
  // the thing that keeps made-up addresses from filling the base.
  const recently = `DATETIME_DIFF(NOW(),CREATED_TIME(),'hours')<24`
  const seen = await listCodes(env, `OR(${codeFormula(code)},${recently})`, 100, deadline)
  if (!seen) return ''
  const existing = seen.find((row) => row.code === code)
  if (existing) {
    rememberCode(context, code, { id: existing.id, destination: existing.destination })
    return existing.id
  }
  const dayAgo = Date.now() - 86400000
  if (seen.filter((row) => row.created > dayAgo).length >= DAILY_CREATE_MAX) return ''

  const post = (fields) =>
    airtable(env, env.AIRTABLE_WRITE_PAT, CODES_TABLE_ID, { method: 'POST', body: JSON.stringify({ fields }) }, deadline)
  let made = await post({
    [NAME_FIELD]: code,
    [CODE_FIELD]: code,
    [NOTES_FIELD]: `Added automatically the first time this code was scanned (${centralDay()}).`,
  })
  // A renamed or deleted Name or Notes column must not stop new codes from
  // registering: fall back to the one field that matters.
  if (made.status === 422) made = await post({ [CODE_FIELD]: code })
  const id = made.status === 200 && made.body && typeof made.body.id === 'string' ? made.body.id : ''
  if (!id) {
    console.warn(`qr code create: Airtable returned ${made.status}`)
    return ''
  }

  // Two instances can both get this far for the same brand-new code (a QR on
  // a slide, first scanned by a whole room). Give the other one a moment to
  // land, then keep the oldest row and withdraw ours if it is the younger.
  let winner = { id, destination: '' }
  await sleep(TWIN_CHECK_DELAY_MS)
  const rows = await listCodes(env, codeFormula(code), 5, deadline)
  if (rows && rows.length > 1 && rows[0].id !== id && rows.some((row) => row.id === id)) {
    winner = { id: rows[0].id, destination: rows[0].destination }
    const gone = new URLSearchParams()
    gone.append('records[]', id)
    await airtable(env, env.AIRTABLE_WRITE_PAT, `${CODES_TABLE_ID}?${gone}`, { method: 'DELETE' }, deadline)
  }
  rememberCode(context, code, winner)
  return winner.id
}

// ── Recording a scan ───────────────────────────────────────────────────────

// Buffer the scan and schedule the write, without ever throwing: logging
// must never get between a visitor and the page they scanned for.
// `id` may be a promise (a row still being looked up or created); an empty
// ID means there is no row to count against, and the scan is dropped.
function recordScan(context, code, id, deadline) {
  try {
    const { env, request } = context
    if (!env.AIRTABLE_WRITE_PAT || !env.AIRTABLE_BASE_ID) return

    const cf = request.cf || {}
    const fields = {
      [S.summary]: `${code} · ${centralDay()}`,
      [S.time]: new Date().toISOString(),
    }
    if (cf.city) fields[S.city] = clean(cf.city, 100)
    if (cf.region) fields[S.region] = clean(cf.region, 100)
    if (cf.country) fields[S.country] = clean(cf.country, 100)

    const task = Promise.all([visitorHash(env, request), id]).then(([hash, recordId]) => {
      if (!recordId) return
      const now = Date.now()
      const allowed =
        takeFor(visitorScans, `${code}|${hash}`, VISITOR_SCANS, now) && take(instanceScans, now) && buffer.length < BUFFER_MAX
      if (!allowed) {
        // Over a limit: not stored, but remembered, so a "NOT RECORDED" row
        // can say roughly how many went missing. Even when shedding, make
        // sure something is still working the buffer down.
        dropped++
        kickFlush(context, deadline)
        return
      }
      fields[S.code] = [recordId]
      if (hash) fields[S.visitor] = hash
      buffer.push({ fields, code })
      return flushSoon(env, deadline)
    })
    keepAlive(context, task.catch(() => {}))
  } catch {
    // never affect the redirect
  }
}

const pendingWork = (now) => buffer.length > 0 || (dropped > 0 && now - lastMarkerAt >= MARKER_GAP_MS)

// Start a flusher if there is unwritten work and nobody has done so in the
// last few seconds. Called on every scan, and by the API middleware on every
// API request (see the registration at the bottom of this section), so rows
// that one request could not write are picked up by the next visitor's
// ordinary browsing instead of waiting for another scan.
function kickFlush(context, deadline) {
  try {
    const { env } = context
    if (!env.AIRTABLE_WRITE_PAT || !env.AIRTABLE_BASE_ID) return
    const now = Date.now()
    if (!pendingWork(now) || now - lastKickAt < KICK_GAP_MS) return
    lastKickAt = now
    keepAlive(context, flushSoon(env, deadline).catch(() => {}))
  } catch {
    // never affect the response
  }
}

onApiRequest((context) => kickFlush(context, Date.now() + WINDOW_MS))

// Wait for the burst to pool, then stay until the rows are written or this
// request's time is nearly up. (Simply leaving when another request was
// already writing is how rows used to be left behind with nobody to write
// them.) Only one request writes at a time; the others watch.
async function flushSoon(env, deadline) {
  await sleep(FLUSH_DELAY_MS)
  for (;;) {
    const now = Date.now()
    // A write is only started if its full time limit still fits.
    if (!pendingWork(now) || now + AIRTABLE_TIMEOUT_MS > deadline) return
    const hold = Math.max(backoffUntil, writeHoldUntil)
    if (now < hold) {
      if (hold + AIRTABLE_TIMEOUT_MS > deadline) return // cannot outwait it: a later request will write these
      await sleep(hold - now)
    } else if (now - flushBeatAt < FLUSH_STALE_MS) {
      await sleep(FLUSH_POLL_MS) // another request is writing
    } else {
      await runFlush(env, deadline)
    }
  }
}

// A stand-in row for scans that were not stored, so a quiet table never
// means "nobody scanned" when it was really "limits or errors".
function markerFields(count) {
  return {
    [S.summary]: `NOT RECORDED · about ${count} scan${count === 1 ? '' : 's'}`,
    [S.time]: new Date().toISOString(),
  }
}

// Up to `max` rows from the front of the buffer, stopping before any row that
// has to be sent alone.
function takeBatch(max) {
  let n = 0
  while (n < max && n < buffer.length && !buffer[n].solo) n++
  return buffer.splice(0, n)
}

async function runFlush(env, deadline) {
  const me = ++flushSerial
  flushOwner = me
  flushBeatAt = Date.now() // a time, not a flag: if this request is cut off mid-write, the claim simply expires
  try {
    for (;;) {
      const wait = lastWriteAt + (buffer.length >= BACKLOG_ROWS ? 0 : FLUSH_GAP_MS) - Date.now()
      if (wait > 0) await sleep(wait)
      const now = Date.now()
      if (flushOwner !== me || !pendingWork(now)) return
      if (now < backoffUntil || now < writeHoldUntil || now + AIRTABLE_TIMEOUT_MS > deadline) return
      flushBeatAt = now // still here

      const alone = buffer.length > 0 && buffer[0].solo
      const withMarker = !alone && dropped > 0 && now - lastMarkerAt >= MARKER_GAP_MS
      const lost = withMarker ? dropped : 0
      const rows = alone ? buffer.splice(0, 1) : takeBatch(withMarker ? 9 : 10)
      const records = rows.map((row) => ({ fields: row.fields }))
      if (withMarker) {
        records.unshift({ fields: markerFields(lost) })
        dropped -= lost
      }
      lastWriteAt = now
      const { status, timedOut } = await airtable(
        env,
        env.AIRTABLE_WRITE_PAT,
        SCANS_TABLE_ID,
        { method: 'POST', body: JSON.stringify({ records }) },
        deadline
      )

      if (status >= 200 && status < 300) {
        if (withMarker) lastMarkerAt = Date.now()
        continue
      }
      if (withMarker) dropped += lost // the marker was not written either
      if (status === 429) {
        buffer.unshift(...rows) // not saved: keep them for after the lockout (airtable() opened the backoff)
        return
      }
      if (status === 0 && timedOut) {
        // No answer in time. The rows may or may not have been saved, and
        // sending them again could count every scan twice: let them go.
        dropped += rows.length
        writeHoldUntil = Date.now() + RETRY_PAUSE_MS
        return
      }
      if (status === 0 || status >= 500) {
        buffer.unshift(...rows) // Airtable hiccup: try again shortly
        writeHoldUntil = Date.now() + RETRY_PAUSE_MS
        return
      }
      // Airtable refused the rows themselves. Usually one row points at a code
      // row that has since been deleted; send each alone so the others get in.
      console.warn(`qr scan log: Airtable returned ${status}`)
      if (rows.length > 1) {
        for (const row of rows) row.solo = true
        buffer.unshift(...rows)
      } else if (rows.length === 1) {
        dropped += 1
        await forgetCode(rows[0].code) // whatever we remembered about its code is wrong
      } else {
        lastMarkerAt = Date.now() // even the marker was refused: do not keep trying
      }
    }
  } catch (err) {
    console.warn('qr scan log failed', err && err.message)
    writeHoldUntil = Date.now() + RETRY_PAUSE_MS // never spin on an unexpected error
  } finally {
    if (flushOwner === me) flushBeatAt = 0
  }
}

// ── QR code pictures ───────────────────────────────────────────────────────

const QUIET_ZONE = 4 // modules of white border the QR spec asks for
const PNG_TARGET_PX = 1000 // ≈3.3 inches at 300 dpi; use the SVG beyond that
const IMAGE_TTL_SECONDS = 86400

async function qrImage(context, text, code, type) {
  const { request } = context
  let cache = null
  try {
    cache = caches.default
    const hit = await cache.match(request)
    if (hit) return hit
  } catch {
    cache = null
  }

  // Error correction "Q" survives a crease or a coffee ring on a flyer.
  const qr = qrcode(0, 'Q')
  qr.addData(text)
  qr.make()
  const count = qr.getModuleCount()
  const dark = (row, col) => qr.isDark(row, col)

  const body = type === 'svg' ? qrSvg(count, dark) : await qrPng(count, dark)
  const response = new Response(body, {
    headers: {
      'Content-Type': type === 'svg' ? 'image/svg+xml' : 'image/png',
      'Content-Disposition': `inline; filename="qr-${code}.${type}"`,
      'Cache-Control': `public, max-age=${IMAGE_TTL_SECONDS}`,
      'X-Content-Type-Options': 'nosniff',
      // An SVG opened directly is a document; make sure it can't run anything.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    },
  })
  if (cache && request.method === 'GET') {
    const put = cache.put(request, response.clone()).catch(() => {})
    keepAlive(context, put)
  }
  return response
}

function qrSvg(count, dark) {
  const size = count + QUIET_ZONE * 2
  let path = ''
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!dark(row, col)) continue
      let run = 1
      while (col + run < count && dark(row, col + run)) run++
      path += `M${col + QUIET_ZONE} ${row + QUIET_ZONE}h${run}v1h-${run}z`
      col += run - 1
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * 10}" height="${size * 10}" shape-rendering="crispEdges">` +
    `<rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`
  )
}

// A 1-bit greyscale PNG, built by hand so the Function needs no image
// library: one packed row per QR module row, repeated `scale` times.
async function qrPng(count, dark) {
  const modules = count + QUIET_ZONE * 2
  const scale = Math.max(4, Math.round(PNG_TARGET_PX / modules))
  const px = modules * scale
  const rowBytes = Math.ceil(px / 8)
  const raw = new Uint8Array((rowBytes + 1) * px) // +1: filter byte per row

  for (let m = 0; m < modules; m++) {
    const line = new Uint8Array(rowBytes + 1).fill(0xff) // white; byte 0 fixed below
    line[0] = 0 // filter type "none"
    const row = m - QUIET_ZONE
    if (row >= 0 && row < count) {
      for (let col = 0; col < count; col++) {
        if (!dark(row, col)) continue
        const start = (col + QUIET_ZONE) * scale
        for (let x = start; x < start + scale; x++) line[1 + (x >> 3)] &= ~(0x80 >> (x & 7))
      }
    }
    for (let y = 0; y < scale; y++) raw.set(line, (m * scale + y) * (rowBytes + 1))
  }

  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, px)
  view.setUint32(4, px)
  header[8] = 1 // bit depth
  header[9] = 0 // colour type: greyscale

  const idat = new Uint8Array(
    await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()
  )
  const parts = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', header),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

let crcTable = null
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const chunk = new Uint8Array(12 + data.length)
  const view = new DataView(chunk.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i)
  chunk.set(data, 8)
  view.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)))
  return chunk
}
