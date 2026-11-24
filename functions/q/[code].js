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
// The one rule that matters: a scan must ALWAYS end up on the site. An
// Airtable outage or a missing token still redirects to the home page; the
// scan just goes uncounted.
//
// Scans are stored permanently (unlike the API Log, which is pruned), with
// the same privacy line as the log: coarse Cloudflare geo and the anonymous
// daily visitor code, never an IP address.

import qrcode from 'qrcode-generator'
import { BOT_RE, centralDay, clean, visitorHash } from '../api/_middleware.js'

const CODES_TABLE_ID = 'tblgaqbbtNDczqxcs' // "QR Codes" table (not secret)
const SCANS_TABLE_ID = 'tblicawiiqBb5et6g' // "QR Scans" table (not secret)

// Field names — keep in sync if renamed in Airtable.
const CODE_FIELD = 'Code'
const DESTINATION_FIELD = 'Destination'
const NAME_FIELD = 'Name'
const NOTES_FIELD = 'Notes'
const S = {
  summary: 'Scan',
  time: 'Time',
  code: 'QR Code',
  city: 'City',
  region: 'Region',
  country: 'Country',
  likelyBot: 'Likely bot',
  visitor: 'Visitor',
}

// The shape doubles as injection-proofing: a code that passes it is safe to
// place inside the Airtable formula and the cache key below.
const CODE_RE = /^([a-z0-9][a-z0-9-]{0,39})(?:\.(png|svg))?$/

const KNOWN_TTL_SECONDS = 300 // a changed Destination takes effect within this
const UNKNOWN_TTL_SECONDS = 60 // how long "no such code" is remembered (robots only)

// Self-created rows are rationed per server instance, so a script walking
// made-up addresses can't fill the base with rows or spend its rate limit.
// Robots never create rows at all.
const CREATE_MAX = 5
const CREATE_WINDOW_MS = 60000
const recentCreates = []
const pendingCreates = new Map() // code → promise, so a burst creates one row
const IMAGE_TTL_SECONDS = 86400

// Scan rows pool in isolate memory and go out a moment later in one Airtable
// call, for the same reason the API log batches: Airtable allows ~5
// requests/second per BASE, shared with the site's real API routes.
const FLUSH_DELAY_MS = 1500
const FLUSH_GAP_MS = 2000
const BACKOFF_MS = 60000
const BUFFER_MAX = 40
const buffer = []
let flushing = false
let backoffUntil = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function onRequest(context) {
  const { request, params } = context
  const url = new URL(request.url)
  const home = new URL('/', url.origin)

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }

  const match = String(params.code || '').toLowerCase().match(CODE_RE)
  if (!match) return redirect(home)
  const [, code, imageType] = match

  if (imageType) return qrImage(context, `${url.origin}/q/${code}`, code, imageType)

  const entry = await lookupCode(context, code)
  // HEAD is a link checker, not a person with a phone.
  const countable = request.method === 'GET'

  if (!entry) {
    // First scan of a code nobody has set up: send the person on at once and
    // create its row (then log the scan) in the background.
    if (countable && !isLikelyBot(request)) {
      recordScan(context, code, createCode(context, code))
      return redirect(destinationFor('', url.origin, code))
    }
    return redirect(home)
  }

  if (countable) recordScan(context, code, entry.id)
  return redirect(destinationFor(entry.destination, url.origin, code))
}

function isLikelyBot(request) {
  const userAgent = request.headers.get('user-agent') || ''
  return userAgent === '' || Boolean(request.cf?.verifiedBotCategory) || BOT_RE.test(userAgent)
}

function redirect(target) {
  return new Response(null, {
    status: 302,
    headers: { Location: String(target), 'Cache-Control': 'no-store' },
  })
}

// Where a scan lands. Same-site destinations get ?src=<code>, which then
// rides along as the Referer on that visit's API calls, so the API Log shows
// what people who scanned a given code went on to search for.
function destinationFor(raw, origin, code) {
  const home = new URL('/', origin)
  let target = home
  const text = String(raw || '').trim()
  if (text) {
    try {
      // "mnparkinsons.org/#/submit" typed without a scheme is still a link.
      const absolute = /^https?:\/\//i.test(text) || /^[/#?]/.test(text) ? text : `https://${text}`
      const parsed = new URL(absolute, origin)
      if (parsed.protocol === 'https:' || parsed.origin === origin) target = parsed
    } catch {
      target = home
    }
  }
  if (target.origin === origin) {
    if (target.pathname.startsWith('/q/')) target = home // never loop back here
    target.searchParams.set('src', code)
  }
  return target
}

const cacheKeyFor = (code) => `https://qr-lookup.invalid/v1/${code}`

function rememberCode(context, code, entry) {
  try {
    const ttl = entry ? KNOWN_TTL_SECONDS : UNKNOWN_TTL_SECONDS
    const put = caches.default
      .put(cacheKeyFor(code), Response.json({ entry }, { headers: { 'Cache-Control': `public, max-age=${ttl}` } }))
      .catch(() => {})
    if (typeof context.waitUntil === 'function') context.waitUntil(put)
  } catch {
    // no edge cache (local tests): every scan just asks Airtable
  }
}

// Ask Airtable for the code's row: an entry, null for "no such row", or
// undefined when Airtable could not be asked.
async function fetchCode(env, code) {
  try {
    const listUrl = new URL(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${CODES_TABLE_ID}`)
    listUrl.searchParams.set('filterByFormula', `LOWER(TRIM({${CODE_FIELD}}))='${code}'`)
    listUrl.searchParams.set('maxRecords', '1')
    listUrl.searchParams.append('fields[]', DESTINATION_FIELD)
    const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${env.AIRTABLE_PAT}` } })
    if (!res.ok) return undefined
    const record = ((await res.json()).records || [])[0]
    return record ? { id: record.id, destination: record.fields?.[DESTINATION_FIELD] || '' } : null
  } catch {
    return undefined
  }
}

// Find the code's row. Answers (including "no such code") are kept in the
// edge cache briefly so a busy flyer or a junk-URL flood can't spend the
// base's rate limit. Returns null when unknown OR when Airtable can't be
// asked.
async function lookupCode(context, code) {
  const { env } = context
  if (!env.AIRTABLE_PAT || !env.AIRTABLE_BASE_ID) return null

  try {
    const hit = await caches.default.match(cacheKeyFor(code))
    if (hit) return (await hit.json()).entry
  } catch {
    // fall through to Airtable
  }

  const entry = await fetchCode(env, code)
  if (entry === undefined) return null // don't cache a failure
  rememberCode(context, code, entry)
  return entry
}

// Create the row for a code on its first scan. Resolves to the new (or
// just-found) record ID, or '' when no row could be made; never rejects.
function createCode(context, code) {
  const { env } = context
  if (!env.AIRTABLE_WRITE_PAT || !env.AIRTABLE_PAT || !env.AIRTABLE_BASE_ID) return Promise.resolve('')
  const pending = pendingCreates.get(code)
  if (pending) return pending

  const now = Date.now()
  while (recentCreates.length && now - recentCreates[0] > CREATE_WINDOW_MS) recentCreates.shift()
  if (recentCreates.length >= CREATE_MAX) return Promise.resolve('')
  recentCreates.push(now)

  const task = (async () => {
    try {
      // "Unknown" may have come from the cache: ask Airtable itself before
      // creating, so another server's first scan doesn't get a twin row.
      const existing = await fetchCode(env, code)
      if (existing === undefined) return ''
      if (existing) {
        rememberCode(context, code, existing)
        return existing.id
      }
      const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${CODES_TABLE_ID}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_WRITE_PAT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fields: {
            [NAME_FIELD]: code,
            [CODE_FIELD]: code,
            [NOTES_FIELD]: `Added automatically the first time this code was scanned (${centralDay()}).`,
          },
        }),
      })
      if (!res.ok) {
        console.warn(`qr code create: Airtable returned ${res.status}`)
        return ''
      }
      const id = (await res.json()).id || ''
      if (id) rememberCode(context, code, { id, destination: '' })
      return id
    } catch (err) {
      console.warn('qr code create failed', err && err.message)
      return ''
    } finally {
      pendingCreates.delete(code)
    }
  })()
  pendingCreates.set(code, task)
  return task
}

// Buffer the scan and schedule the write, without ever throwing: logging
// must never get between a visitor and the page they scanned for.
// `recordId` may be a promise (a row still being created); an empty ID
// means there is no row to count against, and the scan is dropped.
function recordScan(context, code, recordId) {
  try {
    const { env, request } = context
    if (!env.AIRTABLE_WRITE_PAT || !env.AIRTABLE_BASE_ID) return
    if (buffer.length >= BUFFER_MAX) return // flood: shed rows, protect the base

    const cf = request.cf || {}
    const fields = {
      [S.summary]: `${code} · ${centralDay()}`,
      [S.time]: new Date().toISOString(),
      [S.likelyBot]: isLikelyBot(request),
    }
    if (cf.city) fields[S.city] = clean(cf.city, 100)
    if (cf.region) fields[S.region] = clean(cf.region, 100)
    if (cf.country) fields[S.country] = clean(cf.country, 100)

    const task = Promise.all([visitorHash(env, request), recordId]).then(([hash, id]) => {
      if (!id) return
      fields[S.code] = [id]
      if (hash) fields[S.visitor] = hash
      if (buffer.length >= BUFFER_MAX) return
      buffer.push(fields)
      return flushSoon(env)
    })
    if (typeof context.waitUntil === 'function') context.waitUntil(task.catch(() => {}))
    else task.catch(() => {})
  } catch {
    // never affect the redirect
  }
}

async function flushSoon(env) {
  await sleep(FLUSH_DELAY_MS) // let a burst pool into one call
  if (flushing || buffer.length === 0 || Date.now() < backoffUntil) return
  flushing = true
  try {
    // At most a few batches per run, so this stays well inside waitUntil's
    // grace period; anything left is picked up by the next scan.
    for (let i = 0; i < 4 && buffer.length > 0; i++) {
      if (i > 0) await sleep(FLUSH_GAP_MS)
      const batch = buffer.splice(0, 10)
      const res = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${SCANS_TABLE_ID}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.AIRTABLE_WRITE_PAT}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ records: batch.map((fields) => ({ fields })) }),
      })
      if (res.status === 429) {
        // The base is rate limited: stand down and retry these rows later.
        backoffUntil = Date.now() + BACKOFF_MS
        if (buffer.length + batch.length <= BUFFER_MAX) buffer.unshift(...batch)
        return
      }
      if (!res.ok) {
        console.warn(`qr scan log: Airtable returned ${res.status}`)
        return // rows lost (bad token, renamed field, deleted code row)
      }
    }
  } catch (err) {
    console.warn('qr scan log failed', err && err.message)
  } finally {
    flushing = false
  }
}

// ── QR code pictures ───────────────────────────────────────────────────────

const QUIET_ZONE = 4 // modules of white border the QR spec asks for
const PNG_TARGET_PX = 1000 // ≈3.3 inches at 300 dpi; use the SVG beyond that

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
    if (typeof context.waitUntil === 'function') context.waitUntil(put)
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
