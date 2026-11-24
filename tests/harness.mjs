// Test harness for the Pages Functions: a pretend Airtable, a pretend
// Cloudflare edge cache, and a clock the tests control.
//
// The functions keep state in module memory (buffers, rations, "what we
// remember about a code"), and most of what can go wrong is about timing:
// slow answers, bursts, rate limits, work cut off half-way. So every test
// loads a fresh copy of the module ("a fresh server instance") and runs on
// mocked time, which makes minutes of waiting take milliseconds and makes
// the order of events exact.

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// Captured before any test mocks the clock.
const realSetTimeout = globalThis.setTimeout
const realSetImmediate = globalThis.setImmediate
let copies = 0
let serial = 0 // record ids never repeat across tests, so a leftover row from one test can never count in another

// The visitor code is an HMAC computed off the main thread. Count the
// operations in flight so tests can wait for exactly those, instead of
// sleeping real milliseconds after every step of the mocked clock.
let hashing = 0
for (const name of ['importKey', 'sign']) {
  const original = crypto.subtle[name].bind(crypto.subtle)
  crypto.subtle[name] = (...args) => {
    hashing++
    return original(...args).finally(() => {
      hashing--
    })
  }
}

export const START = Date.parse('2026-11-24T18:00:00.000Z') // noon Central
export const CODES = 'tblgaqbbtNDczqxcs'
export const SCANS = 'tblicawiiqBb5et6g'
export const ENV = { AIRTABLE_PAT: 'read-token', AIRTABLE_WRITE_PAT: 'write-token', AIRTABLE_BASE_ID: 'appTEST' }

export const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
export const ANDROID =
  'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'
export const HTML = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'

// A fresh copy of a function module: its own memory, like a new server instance.
export function load(relative) {
  return import(`${pathToFileURL(path.join(repo, relative)).href}?copy=${++copies}`)
}

// Mock the clock and install the pretend Airtable and edge cache.
export function setup(t, { latency = 100 } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: START })
  t.mock.method(console, 'warn', () => {})
  // The route spreads its return from a rate-limit silence over a random 0-10
  // seconds, and the API log prunes on a coin flip. Tests need both fixed.
  t.mock.method(Math, 'random', () => 0)
  const air = pretendAirtable(latency)
  const cache = pretendCache()
  const before = { fetch: globalThis.fetch, caches: globalThis.caches }
  globalThis.fetch = air.fetch
  globalThis.caches = { default: cache }
  t.after(() => {
    globalThis.fetch = before.fetch
    if (before.caches === undefined) delete globalThis.caches
    else globalThis.caches = before.caches
  })

  // Let promise chains (and the real, off-thread visitor hashing) catch up.
  const settle = async () => {
    do {
      for (let i = 0; i < 3; i++) await new Promise((resolve) => realSetImmediate(resolve))
      if (hashing > 0) await new Promise((resolve) => realSetTimeout(resolve, 0))
    } while (hashing > 0)
    for (let i = 0; i < 2; i++) await new Promise((resolve) => realSetImmediate(resolve))
  }
  // Move the clock forward in small steps, letting the code react after each.
  const advance = async (ms, step = 50) => {
    for (let left = ms; left > 0; left -= step) {
      t.mock.timers.tick(Math.min(step, left))
      await settle()
    }
  }
  return { air, cache, advance, settle }
}

// One visit to /q/<code>. Returns the response promise (it may not settle
// until the clock is advanced) and the background work handed to waitUntil.
export function visit(route, code, options = {}) {
  const {
    ua = IPHONE,
    accept = HTML,
    ip = '203.0.113.9',
    method = 'GET',
    host = 'mnparkinsons.org',
    headers = {},
    cf = { city: 'Duluth', region: 'Minnesota', country: 'US' },
    env = ENV,
  } = options
  const all = { 'CF-Connecting-IP': ip, ...headers }
  if (ua !== null) all['user-agent'] = ua
  if (accept !== null) all.accept = accept
  const request = new Request(`https://${host}/q/${code}`, { method, headers: all })
  request.cf = cf
  const background = []
  const visitor = { background, done: false, response: null }
  visitor.response = Promise.resolve(
    route.onRequest({ request, env, params: { code }, waitUntil: (promise) => background.push(promise) })
  ).then((response) => {
    visitor.done = true
    return response
  })
  return visitor
}

// ── Pretend Airtable ───────────────────────────────────────────────────────
//
// Knows just enough of the REST API for these functions: listing QR Codes by
// the two formulas the code uses, creating and deleting a QR Codes row,
// creating QR Scans rows (rejecting a whole batch if one row is bad, as the
// real thing does), and accepting writes to any other table.
function pretendAirtable(latency) {
  const air = {
    latency,
    codes: [], // { id, created, fields }
    scans: [], // { id, created, fields }
    other: [], // rows written to any other table
    calls: [], // { at, method, table, body, auth, status }
    codeFields: new Set(['Name', 'Code', 'Destination', 'Notes']),
    scanFields: new Set(['Scan', 'Time', 'QR Code', 'City', 'Region', 'Country', 'Likely bot', 'Visitor']),
    // respond(call) may return { status }, { error: true }, { hang: true },
    // { hang: true, deaf: true } (ignores cancellation, like a request the
    // platform has stopped listening to), and/or { latency }.
    respond: null,
    limiter: false, // enforce 5 requests a second, then 30 seconds of 429
    lockedUntil: 0,
    recent: [],
    lists: 0, // how many times QR Codes has been listed
    codeIds: [], // ids to give the next QR Codes rows created, for tests that need to know which of two sorts first
  }
  // Like real record ids, these are unique but in no particular order.
  const newId = (letter) => {
    const n = ++serial
    const scrambled = (Math.imul(n, 0x9e3779b1) >>> 0).toString(36).padStart(7, '0')
    return `rec${letter}${scrambled}${String(n).padStart(6, '0')}`
  }
  // The real API reports createdTime to the whole second.
  const createdTime = (ms) => new Date(Math.floor(ms / 1000) * 1000).toISOString()
  const reply = (status, body) => ({ status, body })
  const normal = (value) => String(value || '').trim().toLowerCase()

  // Rows the tests set up by hand are a minute old unless they say otherwise:
  // the route treats a row only seconds old as one that may still gain a twin.
  air.addCode = (code, { destination = '', name = code, created = Date.now() - 60000 } = {}) => {
    const row = { id: newId('C'), created, fields: { Name: name, Code: code } }
    if (destination) row.fields.Destination = destination
    air.codes.push(row)
    return row
  }
  air.rowsFor = (code) => air.codes.filter((row) => normal(row.fields.Code) === code)
  air.scansFor = (code) => {
    const ids = new Set(air.rowsFor(code).map((row) => row.id))
    return air.scans.filter((scan) => (scan.fields['QR Code'] || []).some((id) => ids.has(id)))
  }
  air.markers = () => air.scans.filter((scan) => String(scan.fields.Scan).startsWith('NOT RECORDED'))
  air.count = (method, table) => air.calls.filter((call) => call.method === method && call.table === table).length
  air.sent = (method, table) => air.calls.filter((call) => call.method === method && call.table === table)

  function handle(call) {
    const { method, table, url, body } = call
    const now = Date.now()
    if (table === CODES && method === 'GET') {
      const formula = url.searchParams.get('filterByFormula') || ''
      const wanted = (formula.match(/LOWER\(TRIM\(\{Code\}\)\)='([a-z0-9-]+)'/) || [])[1]
      const lastDay = /DATETIME_DIFF\(NOW\(\),CREATED_TIME\(\),'hours'\)<24/.test(formula)
      const max = Number(url.searchParams.get('maxRecords') || 100)
      const names = url.searchParams.getAll('fields[]')
      if (names.some((name) => !air.codeFields.has(name))) return reply(422, { error: { type: 'UNKNOWN_FIELD_NAME' } })
      // The real API promises no order: hand the rows back the other way
      // round on every second call, so nothing can lean on "oldest first".
      const matched = air.codes.filter(
        (row) => normal(row.fields.Code) === wanted || (lastDay && now - row.created < 86400000)
      )
      if (air.lists++ % 2) matched.reverse()
      const records = matched
        .slice(0, max)
        .map((row) => ({
          id: row.id,
          createdTime: createdTime(row.created),
          fields: Object.fromEntries(names.filter((name) => row.fields[name]).map((name) => [name, row.fields[name]])),
        }))
      return reply(200, { records })
    }
    if (table === CODES && method === 'POST') {
      const fields = body.fields || {}
      if (Object.keys(fields).some((name) => !air.codeFields.has(name))) {
        return reply(422, { error: { type: 'UNKNOWN_FIELD_NAME' } })
      }
      const row = { id: air.codeIds.shift() || newId('C'), created: now, fields: { ...fields } }
      air.codes.push(row)
      return reply(200, { id: row.id, createdTime: createdTime(now), fields: row.fields })
    }
    if (table === CODES && method === 'DELETE') {
      const ids = url.searchParams.getAll('records[]')
      air.codes = air.codes.filter((row) => !ids.includes(row.id))
      return reply(200, { records: ids.map((id) => ({ id, deleted: true })) })
    }
    // Like the real API: at most ten records in one create call.
    if (method === 'POST' && body.records && body.records.length > 10) {
      return reply(422, { error: { type: 'INVALID_REQUEST_UNKNOWN' } })
    }
    if (table === SCANS && method === 'POST') {
      const known = new Set(air.codes.map((row) => row.id))
      for (const record of body.records) {
        const fields = record.fields || {}
        if (Object.keys(fields).some((name) => !air.scanFields.has(name))) {
          return reply(422, { error: { type: 'UNKNOWN_FIELD_NAME' } })
        }
        if ((fields['QR Code'] || []).some((id) => !known.has(id))) {
          return reply(422, { error: { type: 'INVALID_RECORDS' } })
        }
      }
      const rows = body.records.map((record) => ({ id: newId('S'), created: now, fields: { ...record.fields } }))
      air.scans.push(...rows)
      return reply(200, { records: rows.map((row) => ({ id: row.id, fields: row.fields })) })
    }
    if (method === 'POST') {
      const records = body.records || [{ fields: body.fields }]
      air.other.push(...records.map((record) => ({ table, created: now, fields: { ...record.fields } })))
      return reply(200, { records: records.map(() => ({ id: newId('X') })) })
    }
    return reply(200, { records: [] })
  }

  air.fetch = (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const call = {
      at: Date.now(),
      method: (init.method || 'GET').toUpperCase(),
      table: url.pathname.split('/')[3],
      url,
      body: init.body ? JSON.parse(init.body) : null,
      auth: init.headers && init.headers.Authorization,
      status: null,
    }
    air.calls.push(call)
    let plan = (air.respond && air.respond(call)) || {}
    if (air.limiter && !plan.status && !plan.hang && !plan.error) {
      air.recent = air.recent.filter((at) => call.at - at < 1000)
      if (call.at < air.lockedUntil || air.recent.length >= 5) {
        if (call.at >= air.lockedUntil) air.lockedUntil = call.at + 30000
        plan = { ...plan, status: 429 }
      } else {
        air.recent.push(call.at)
      }
    }
    return new Promise((resolve, reject) => {
      const cancelled = () => Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })
      const signal = plan.deaf ? null : init.signal
      if (signal && signal.aborted) {
        call.status = 'cancelled'
        return reject(cancelled())
      }
      let timer = null
      const onAbort = () => {
        clearTimeout(timer)
        call.status = 'cancelled'
        reject(cancelled())
      }
      if (signal) signal.addEventListener('abort', onAbort, { once: true })
      if (plan.hang) return // never answers
      timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort)
        if (plan.error) {
          call.status = 'error'
          return reject(new TypeError('fetch failed'))
        }
        const { status, body } = plan.status ? reply(plan.status, { error: { type: 'PRETEND' } }) : handle(call)
        call.status = status
        resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
      }, plan.latency ?? air.latency)
    })
  }
  return air
}

// ── Pretend edge cache ─────────────────────────────────────────────────────
// Honours max-age against the mocked clock, like caches.default.
function pretendCache() {
  const stored = new Map()
  const keyOf = (key) => (typeof key === 'string' ? key : key.url)
  const cache = {
    stored,
    // hide(key) → true makes a read miss, as if the entry had been written in
    // another data centre or had not spread yet. stall = true makes reads
    // never answer; delay = milliseconds makes them slow.
    hide: null,
    stall: false,
    delay: 0,
    async match(key) {
      if (cache.stall) return new Promise(() => {})
      if (cache.delay) await new Promise((resolve) => setTimeout(resolve, cache.delay))
      if (cache.hide && cache.hide(keyOf(key))) return undefined
      const entry = stored.get(keyOf(key))
      if (!entry) return undefined
      if (Date.now() >= entry.expires) {
        stored.delete(keyOf(key))
        return undefined
      }
      return new Response(entry.body, { headers: entry.headers })
    },
    async put(key, response) {
      const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') || '')
      const body = await response.arrayBuffer()
      stored.set(keyOf(key), {
        body,
        headers: [...response.headers],
        expires: Date.now() + (maxAge ? Number(maxAge[1]) : 0) * 1000,
      })
    },
    async delete(key) {
      return stored.delete(keyOf(key))
    },
  }
  return cache
}

// The smallest gap, in milliseconds, between consecutive calls in a list.
export function smallestGap(calls) {
  let gap = Infinity
  for (let i = 1; i < calls.length; i++) gap = Math.min(gap, calls[i].at - calls[i - 1].at)
  return gap
}
