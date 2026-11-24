// Tests for functions/q/[code].js: the tracked-QR redirect.
// Run with:  npm test
//
// Each test is one scenario from real use or from the November 2026 code
// review: a slow Airtable, a room scanning at once, a script making up
// addresses, a typo in a Destination cell. See harness.mjs for the pretend
// Airtable and the controlled clock.

import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import qrcode from 'qrcode-generator'
import { ANDROID, CODES, ENV, IPHONE, SCANS, load, setup, smallestGap, visit } from './harness.mjs'

const Q = 'functions/q/[code].js'
const HOME = 'https://mnparkinsons.org/'
const where = async (visitor) => (await visitor.response).headers.get('location')
const ip = (n) => `198.51.${Math.floor(n / 250)}.${(n % 250) + 1}`
// Total of the "NOT RECORDED · about N scans" rows.
const noted = (air) => air.markers().reduce((sum, row) => sum + Number(/about (\d+) scan/.exec(row.fields.Scan)[1]), 0)

// ── The basics ─────────────────────────────────────────────────────────────

test('a scan redirects to the Destination with the code attached, and is stored once', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const row = air.addCode('udall-flyer', { destination: 'https://mnparkinsons.org/#/submit' })

  const visitor = visit(route, 'udall-flyer')
  await advance(300)
  const response = await visitor.response
  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), 'https://mnparkinsons.org/?src=udall-flyer#/submit')
  assert.equal(response.headers.get('cache-control'), 'no-store')

  await advance(3000)
  assert.equal(air.scans.length, 1)
  const fields = air.scans[0].fields
  assert.deepEqual(fields['QR Code'], [row.id])
  assert.equal(fields.City, 'Duluth')
  assert.equal(fields.Region, 'Minnesota')
  assert.equal(fields.Country, 'US')
  assert.match(fields.Visitor, /^[0-9a-f]{12}$/)
  assert.match(fields.Scan, /^udall-flyer · \d{4}-\d\d-\d\d$/)
  assert.equal(air.sent('GET', CODES)[0].auth, 'Bearer read-token')
  assert.equal(air.sent('POST', SCANS)[0].auth, 'Bearer write-token')
})

test('odd addresses never reach Airtable and always land on the home page', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  for (const bad of ["x'or'1", '-lead', 'a'.repeat(41), 'x.gif', 'a_b', 'a b', '']) {
    assert.equal(await where(visit(route, bad)), HOME, `code ${JSON.stringify(bad)}`)
  }
  assert.equal(air.calls.length, 0)

  const post = await visit(route, 'udall-flyer', { method: 'POST' }).response
  assert.equal(post.status, 405)
  assert.equal(post.headers.get('allow'), 'GET, HEAD')

  air.addCode('udall-flyer')
  const shouting = visit(route, 'UDALL-Flyer')
  await advance(300)
  assert.equal(await where(shouting), 'https://mnparkinsons.org/?src=udall-flyer')
})

test('without the tokens a scan still redirects, and nothing is written', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })

  const readOnly = visit(route, 'poster', { env: { AIRTABLE_PAT: 'read-token', AIRTABLE_BASE_ID: 'appTEST' } })
  await advance(300)
  assert.equal(await where(readOnly), 'https://mnparkinsons.org/?src=poster#/submit')
  const unknown = visit(route, 'brand-new', { env: { AIRTABLE_PAT: 'read-token', AIRTABLE_BASE_ID: 'appTEST' } })
  await advance(5000)
  assert.equal(await where(unknown), 'https://mnparkinsons.org/?src=brand-new')
  assert.equal(air.calls.filter((call) => call.method !== 'GET').length, 0)

  const bare = visit(route, 'poster', { env: {} })
  assert.equal(await where(bare), 'https://mnparkinsons.org/?src=poster')
})

// ── A slow or silent Airtable (review: "redirect waits with no time limit") ─

test('a slow Airtable holds the visitor for at most 2.5 seconds, and the scan is still counted', async (t) => {
  const { air, advance } = setup(t, { latency: 6000 })
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })

  const visitor = visit(route, 'poster')
  await advance(2400)
  assert.equal(visitor.done, false, 'still waiting for Airtable at 2.4 s')
  await advance(200)
  assert.equal(visitor.done, true, 'sent on by 2.6 s')
  // The Destination was not known in time, so: the home page.
  assert.equal(await where(visitor), 'https://mnparkinsons.org/?src=poster')

  air.latency = 100
  await advance(8000)
  assert.equal(air.scansFor('poster').length, 1, 'counted once Airtable answered')
})

test('when Airtable does not answer at all, a code scanned before still goes to its Destination', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })
  const first = visit(route, 'poster')
  await advance(3000)
  assert.equal(await where(first), 'https://mnparkinsons.org/?src=poster#/submit')

  await advance(6 * 60000, 1000) // past the five minutes an answer is trusted
  air.respond = (call) => (call.method === 'GET' ? { hang: true } : null)

  const second = visit(route, 'poster', { ip: ip(2) })
  await advance(2600)
  assert.equal(second.done, true)
  assert.equal(await where(second), 'https://mnparkinsons.org/?src=poster#/submit', 'the remembered Destination')
  await advance(12000)
  assert.equal(air.scansFor('poster').length, 2, 'and counted against the remembered row')

  const stranger = visit(route, 'never-seen', { ip: ip(3) })
  await advance(2600)
  assert.equal(await where(stranger), 'https://mnparkinsons.org/?src=never-seen')
  await advance(12000)
  assert.equal(air.codes.length, 1, 'nothing is created when Airtable cannot be asked')
})

// ── Destinations typed by hand (review: "mistyped Destination is a dead link") ─

test('a Destination that is not a usable address falls back to the home page', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const cases = [
    ['', 'https://mnparkinsons.org/?src=CODE'],
    ['https://mnparkinsons.org/#/activity/recUajXmBFDuLg4TW', 'https://mnparkinsons.org/?src=CODE#/activity/recUajXmBFDuLg4TW'],
    ['mnparkinsons.org/#/submit', 'https://mnparkinsons.org/?src=CODE#/submit'],
    ['#/submit', 'https://mnparkinsons.org/?src=CODE#/submit'],
    ['  #/submit  ', 'https://mnparkinsons.org/?src=CODE#/submit'],
    ['https://www.parkinson.org/walk?a=1', 'https://www.parkinson.org/walk?a=1'],
    ['www.parkinson.org/walk', 'https://www.parkinson.org/walk'],
    // Typos that used to become hosts like https://submit/
    ['submit', 'https://mnparkinsons.org/?src=CODE'],
    ['activity/recUajXmBFDuLg4TW', 'https://mnparkinsons.org/?src=CODE'],
    ['https:/mnparkinsons.org/#/submit', 'https://mnparkinsons.org/?src=CODE'],
    ['the finder page', 'https://mnparkinsons.org/?src=CODE'],
    ['https://192.168.1.1/x', 'https://mnparkinsons.org/?src=CODE'],
    ['javascript:alert(1)', 'https://mnparkinsons.org/?src=CODE'],
    ['http://insecure.example/', 'https://mnparkinsons.org/?src=CODE'],
    // Our own site over http: same page over https
    ['http://mnparkinsons.org/#/submit', 'https://mnparkinsons.org/?src=CODE#/submit'],
    // No user names in the address
    ['info@mnparkinsons.org', 'https://mnparkinsons.org/?src=CODE'],
    ['https://user:pw@example.org/page', 'https://example.org/page'],
    // The site's other host names are still "our site": tagged, and never a loop
    ['https://www.mnparkinsons.org/#/submit', 'https://www.mnparkinsons.org/?src=CODE#/submit'],
    ['https://mnparkinsons.pages.dev/#/finder', 'https://mnparkinsons.pages.dev/?src=CODE#/finder'],
    ['https://mnparkinsons.org/q/other', 'https://mnparkinsons.org/?src=CODE'],
    ['https://www.mnparkinsons.org/q/other', 'https://mnparkinsons.org/?src=CODE'],
    ['https://mnparkinsons.org/%71/other', 'https://mnparkinsons.org/?src=CODE'],
  ]
  for (const [index, [destination, expected]] of cases.entries()) {
    const code = `dest-${index}`
    air.addCode(code, { destination })
    const visitor = visit(route, code, { ip: ip(index) })
    await advance(1200)
    assert.equal(await where(visitor), expected.replace('CODE', code), `Destination ${JSON.stringify(destination)}`)
  }
})

// ── Person or robot (review: "link previews count as people") ──────────────

test('only a person opening the link is counted', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  const warm = visit(route, 'poster', { ip: ip(0) })
  await advance(3000)
  await warm.response

  const chrome =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
  const clients = [
    // People
    ['iPhone Safari', true, {}],
    ['Android Chrome', true, { ua: ANDROID }],
    ['desktop Chrome navigating', true, { ua: chrome, headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } }],
    ['a CUBOT-brand phone', true, { ua: 'Mozilla/5.0 (Linux; Android 11; CUBOT NOTE 20 PRO) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/96.0.4664.45 Mobile Safari/537.36' }],
    ['a QR reader app that tags its browser', true, { ua: 'Mozilla/5.0 (Linux; Android 13; SM-A536U Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36 QRScanner/3.2' }],
    // Not people
    ['WhatsApp link preview', false, { ua: 'WhatsApp/2.23.20.0 A', accept: null }],
    ['Signal link preview', false, { ua: 'WhatsApp/2', accept: null }],
    ['Facebook crawler', false, { ua: 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)', accept: '*/*' }],
    ['iMessage link preview', false, { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0' }],
    ['Googlebot smartphone', false, { ua: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }],
    ['headless Chrome', false, { ua: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/119.0.0.0 Safari/537.36' }],
    ['curl', false, { ua: 'curl/8.4.0', accept: '*/*' }],
    ['a script wearing a browser name', false, { ua: chrome, accept: '*/*' }],
    ['okhttp', false, { ua: 'okhttp/4.12.0', accept: null }],
    ['python-requests', false, { ua: 'python-requests/2.31.0', accept: '*/*' }],
    ['no user agent', false, { ua: null }],
    ['an <img> or fetch() pointing at the link', false, { ua: chrome, headers: { 'sec-fetch-mode': 'no-cors' } }],
    ['a browser prefetching ahead of the user', false, { ua: chrome, headers: { 'sec-fetch-mode': 'navigate', 'sec-purpose': 'prefetch;prerender' } }],
    ['a HEAD link check', false, { method: 'HEAD' }],
    ['a Cloudflare-verified crawler', false, { cf: { verifiedBotCategory: 'Search Engine Crawler' } }],
  ]
  for (const [index, [name, person, options]] of clients.entries()) {
    const before = air.scans.length
    const visitor = visit(route, 'poster', { ip: ip(index + 1), ...options })
    await advance(4000)
    assert.equal((await visitor.response).status, 302, `${name} is still redirected`)
    assert.equal(air.scans.length - before, person ? 1 : 0, `${name} ${person ? 'is' : 'is not'} counted`)
  }
})

// ── Made-up addresses (review: "uncached lookups", "minting rows") ─────────

test('made-up addresses cannot spend the Airtable budget or mint rows freely', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)

  // Eight different made-up codes at the same instant, from a script.
  const scripted = Array.from({ length: 8 }, (_, n) => visit(route, `junk-${n}`, { ua: 'curl/8.4.0', accept: '*/*', ip: ip(n) }))
  await advance(3000)
  for (const visitor of scripted) assert.equal(await where(visitor), HOME)
  assert.ok(air.count('GET', CODES) <= 1, `robots share one lookup, saw ${air.count('GET', CODES)}`)
  assert.equal(air.codes.length, 0, 'robots never create rows')

  // The same from something that passes for a person.
  const before = air.calls.length
  const people = Array.from({ length: 8 }, (_, n) => visit(route, `typo-${n}`, { ip: ip(100 + n) }))
  await advance(30000)
  for (const [n, visitor] of people.entries()) assert.equal(await where(visitor), `https://mnparkinsons.org/?src=typo-${n}`)
  assert.ok(air.codes.length <= 3, `only as many rows as the lookup ration let through, saw ${air.codes.length}`)
  assert.ok(air.codes.length >= 1)
  // And however much there was to do, the calls were spread out.
  assert.ok(smallestGap(air.calls.slice(before)) >= 350, `calls at least 350 ms apart, saw ${smallestGap(air.calls.slice(before))}`)
})

test('new codes are capped at twenty a day across the whole table', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const people = []
  for (let n = 0; n < 25; n++) {
    people.push(visit(route, `new-${n}`, { ip: ip(n) }))
    await advance(15000, 250)
  }
  await advance(10000, 250)
  for (const [n, visitor] of people.entries()) assert.equal(await where(visitor), `https://mnparkinsons.org/?src=new-${n}`)
  assert.equal(air.codes.length, 20)
  assert.equal(air.scans.length, 20, 'scans of codes that were not registered are not stored')

  // A day later the window has moved on.
  await advance(24 * 3600000, 600000)
  const later = visit(route, 'tomorrow', { ip: ip(99) })
  await advance(10000, 250)
  await later.response
  assert.equal(air.rowsFor('tomorrow').length, 1)
})

// ── A new code's first scans (review: "duplicate rows", "burst trips limit") ─

test('the first scan of a new code creates its row and is counted', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const visitor = visit(route, 'spring-walk')
  await advance(300)
  assert.equal(await where(visitor), 'https://mnparkinsons.org/?src=spring-walk')
  await advance(6000)
  assert.equal(air.codes.length, 1)
  assert.equal(air.codes[0].fields.Code, 'spring-walk')
  assert.equal(air.codes[0].fields.Name, 'spring-walk')
  assert.match(air.codes[0].fields.Notes, /^Added automatically the first time this code was scanned \(\d{4}-\d\d-\d\d\)\.$/)
  assert.equal(air.scansFor('spring-walk').length, 1)
})

test('a room scanning a brand-new code at once makes one row and a handful of calls', async (t) => {
  const { air, advance } = setup(t)
  air.limiter = true // 5 requests a second, like the real base
  const route = await load(Q)
  const room = Array.from({ length: 30 }, (_, n) => visit(route, 'on-the-slide', { ip: ip(n) }))
  await advance(10000)
  for (const visitor of room) assert.equal(await where(visitor), 'https://mnparkinsons.org/?src=on-the-slide')
  assert.equal(air.rowsFor('on-the-slide').length, 1)
  assert.equal(air.scansFor('on-the-slide').length, 30)
  assert.equal(air.count('POST', CODES), 1)
  assert.equal(air.count('GET', CODES), 3, 'one lookup, one check before creating, one check for a twin')
  assert.ok(!air.calls.some((call) => call.status === 429), 'the base was never rate limited')
})

test('two server instances creating the same new code settle on one row', async (t) => {
  const { air, advance } = setup(t)
  const one = await load(Q)
  const two = await load(Q)
  const a = visit(one, 'table-tent', { ip: ip(1) })
  await advance(100)
  const b = visit(two, 'table-tent', { ip: ip(2) })
  await advance(10000)
  await Promise.all([a.response, b.response])
  assert.equal(air.count('POST', CODES), 2, 'both instances did create a row (the race happened)')
  assert.equal(air.rowsFor('table-tent').length, 1, 'and the younger one was withdrawn')
  assert.equal(air.scansFor('table-tent').length, 2, 'both scans count against the row that stayed')
})

test('a renamed or deleted Name or Notes column does not stop new codes registering', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.codeFields.delete('Notes')
  const visitor = visit(route, 'new-poster')
  await advance(8000)
  await visitor.response
  assert.equal(air.rowsFor('new-poster').length, 1)
  assert.deepEqual(Object.keys(air.rowsFor('new-poster')[0].fields), ['Code'])
  assert.equal(air.scansFor('new-poster').length, 1)
})

// ── Many scans (review: "unbounded rows", "full buffer", "stranded rows") ──

test('a busy code costs one lookup, and a burst is written in full, ten rows a call, a second apart', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  for (let n = 0; n < 45; n++) {
    visit(route, 'poster', { ip: ip(n) })
    await advance(110, 10)
  }
  await advance(20000)
  assert.equal(air.count('GET', CODES), 1)
  assert.equal(air.scansFor('poster').length, 45, 'nothing left behind, with no later request to rescue it')
  const writes = air.sent('POST', SCANS)
  assert.ok(writes.every((call) => call.body.records.length <= 10))
  assert.ok(smallestGap(writes) >= 1000, `writes at least a second apart, saw ${smallestGap(writes)}`)
})

test('a steady stream is batched, not one write per scan', async (t) => {
  const { air, advance } = setup(t, { latency: 60 })
  const route = await load(Q)
  air.addCode('poster')
  for (let n = 0; n < 54; n++) {
    visit(route, 'poster', { ip: ip(n) })
    await advance(226, 113)
  }
  await advance(10000)
  assert.equal(air.scansFor('poster').length, 54)
  const writes = air.sent('POST', SCANS)
  assert.ok(writes.length <= 16, `about one write a second, saw ${writes.length}`)
  assert.ok(smallestGap(writes) >= 1000)
})

test('one visitor repeating a scan is rationed, and the shortfall is noted', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  for (let n = 0; n < 200; n++) {
    visit(route, 'poster') // same address, same browser, once a second
    await advance(1000, 250)
  }
  await advance(20000, 250)
  assert.equal(air.scansFor('poster').length, 150)
  assert.ok(air.markers().length >= 1, 'a note says scans went unrecorded')
  assert.match(air.markers()[0].fields.Scan, /^NOT RECORDED · about \d+ scans?$/)
  assert.ok(!('QR Code' in air.markers()[0].fields), 'the note is not counted against any code')

  // The allowance comes back slowly: one every five minutes.
  await advance(10 * 60000, 1000)
  for (let n = 0; n < 5; n++) {
    visit(route, 'poster')
    await advance(1000, 250)
  }
  await advance(20000, 250)
  const stored = air.scansFor('poster').length
  assert.ok(stored >= 152 && stored <= 153, `two or three more after ten minutes, saw ${stored - 150}`)
  // Notes are at least ten minutes apart, each covering what was lost since
  // the one before. Once the last one is out, stored + noted = scanned.
  await advance(11 * 60000, 1000)
  visit(route, 'poster')
  await advance(20000, 250)
  assert.equal(air.scansFor('poster').length + noted(air), 206)
  assert.ok(air.markers().length <= 3)
})

test('a hall full of different people is stored in full', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('keynote')
  for (let n = 0; n < 300; n++) {
    visit(route, 'keynote', { ip: ip(n), ua: n % 2 ? IPHONE : ANDROID })
    await advance(200, 50)
  }
  await advance(40000, 250)
  assert.equal(air.scansFor('keynote').length, 300)
  assert.equal(air.markers().length, 0)
})

test('even on one shared Wi-Fi address, 150 identical phones are stored', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('keynote')
  for (let n = 0; n < 150; n++) {
    visit(route, 'keynote') // all behind one address with one browser version
    await advance(400, 100)
  }
  await advance(40000, 250)
  assert.equal(air.scansFor('keynote').length, 150)
})

test('no server instance writes more than its hourly ceiling, whoever asks', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  for (let n = 0; n < 900; n++) {
    visit(route, 'poster', { ip: ip(n) }) // every request a "different visitor"
    await advance(330, 110)
  }
  await advance(60000, 500)
  const stored = air.scansFor('poster').length
  assert.ok(stored >= 600 && stored <= 660, `600 plus what trickled back in five minutes, saw ${stored}`)
  assert.ok(air.markers().length >= 1)
})

// ── When a write goes wrong (review: "never retried", "wedged", "stuck") ───

test('a write that fails with a server error is tried again by the same request', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  let failures = 1
  air.respond = (call) => (call.table === SCANS && failures-- > 0 ? { status: 503 } : null)
  visit(route, 'poster')
  await advance(12000)
  assert.equal(air.count('POST', SCANS), 2)
  assert.equal(air.scansFor('poster').length, 1)
})

test('a write cut short by a network error is tried again too', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  let failures = 1
  air.respond = (call) => (call.table === SCANS && failures-- > 0 ? { error: true } : null)
  visit(route, 'poster')
  await advance(12000)
  assert.equal(air.scansFor('poster').length, 1)
})

test('a write that never answers is not sent twice; the gap is noted instead', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  let silent = 1
  air.respond = (call) => (call.table === SCANS && silent-- > 0 ? { hang: true } : null)
  visit(route, 'poster')
  await advance(20000)
  assert.equal(air.scansFor('poster').length, 0, 'it may or may not have been saved, so it is not re-sent')
  assert.equal(air.markers().length, 1)
  assert.match(air.markers()[0].fields.Scan, /^NOT RECORDED · about 1 scan$/)
})

test('after a 429 this route stays silent for half a minute, then the next scan writes everything', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  let limited = 1
  air.respond = (call) => (call.table === SCANS && limited-- > 0 ? { status: 429 } : null)

  visit(route, 'poster', { ip: ip(1) })
  await advance(2000)
  const afterLimit = air.calls.length
  assert.equal(air.calls.at(-1).status, 429)

  // During the lockout: a remembered code still redirects; nothing calls Airtable.
  const remembered = visit(route, 'poster', { ip: ip(2) })
  const unknown = visit(route, 'something-else', { ip: ip(3) })
  await advance(20000)
  assert.equal(await where(remembered), 'https://mnparkinsons.org/?src=poster')
  assert.equal(await where(unknown), 'https://mnparkinsons.org/?src=something-else')
  assert.equal(air.calls.length, afterLimit, 'not one call during the lockout')

  await advance(15000)
  visit(route, 'poster', { ip: ip(4) })
  await advance(5000)
  assert.equal(air.scansFor('poster').length, 3, 'the two held rows and the new one')
})

test('rows held back by a 429 are written on the next ordinary page load, without another scan', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const here = path.dirname(fileURLToPath(import.meta.url))
  // The very copy of the API middleware that the route imported.
  const middleware = await import(pathToFileURL(path.resolve(here, '../functions/api/_middleware.js')).href)
  air.addCode('poster')
  let limited = 1
  air.respond = (call) => (call.table === SCANS && limited-- > 0 ? { status: 429 } : null)
  visit(route, 'poster')
  await advance(40000)
  assert.equal(air.scansFor('poster').length, 0)

  await middleware.onRequest({
    request: new Request('https://mnparkinsons.org/api/activities', { headers: { 'user-agent': IPHONE } }),
    env: ENV,
    next: async () => new Response('{}'),
    waitUntil: () => {},
  })
  await advance(5000)
  assert.equal(air.scansFor('poster').length, 1)
})

test('a burst that meets a 429 and fills the buffer recovers once the lockout ends', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  let limited = 1
  air.respond = (call) => (call.table === SCANS && limited-- > 0 ? { status: 429 } : null)
  for (let n = 0; n < 250; n++) {
    visit(route, 'poster', { ip: ip(n) })
    await advance(80, 20)
  }
  await advance(60000, 250)
  // The requests still alive when the lockout ended started on the backlog themselves.
  assert.ok(air.scansFor('poster').length >= 50, `a good part of the backlog, saw ${air.scansFor('poster').length}`)

  // And the instance is not wedged: the next scans are written, along with
  // whatever was still waiting. Fifty arrived while the buffer was full.
  for (let n = 0; n < 5; n++) visit(route, 'poster', { ip: ip(500 + n) })
  await advance(15000)
  assert.equal(air.scansFor('poster').length, 205)
  assert.equal(noted(air), 50)
})

test('a write run that is cut off does not stop later scans being written', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  let cutOff = 1
  // The first write never settles and cannot be cancelled: what a request
  // looks like after Cloudflare has stopped running its background work.
  air.respond = (call) => (call.table === SCANS && cutOff-- > 0 ? { hang: true, deaf: true } : null)
  visit(route, 'poster', { ip: ip(1) })
  await advance(5000)
  visit(route, 'poster', { ip: ip(2) })
  await advance(25000)
  assert.equal(air.scansFor('poster').length, 1, 'the second scan took over inside its own time')
  visit(route, 'poster', { ip: ip(3) })
  await advance(5000)
  assert.equal(air.scansFor('poster').length, 2)
})

test('a create that is cut off does not stop the code registering later', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  let cutOff = 1
  air.respond = (call) => (call.table === CODES && call.method === 'POST' && cutOff-- > 0 ? { hang: true, deaf: true } : null)
  visit(route, 'new-flyer', { ip: ip(1) })
  await advance(30000)
  assert.equal(air.rowsFor('new-flyer').length, 0)
  visit(route, 'new-flyer', { ip: ip(2) })
  await advance(10000)
  assert.equal(air.rowsFor('new-flyer').length, 1)
  assert.equal(air.scansFor('new-flyer').length, 1)
})

test('a scan pointing at a deleted row is dropped alone, and the code starts afresh', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('old-flyer')
  air.addCode('poster')
  visit(route, 'old-flyer', { ip: ip(1) })
  visit(route, 'poster', { ip: ip(2) })
  await advance(4000)
  assert.equal(air.scans.length, 2)

  air.codes = air.codes.filter((row) => row.fields.Code !== 'old-flyer') // the owner deletes the row
  visit(route, 'old-flyer', { ip: ip(3) }) // still remembered for a few minutes
  visit(route, 'poster', { ip: ip(4) })
  await advance(8000)
  assert.equal(air.scansFor('poster').length, 2, 'the good row in the same batch still got in')

  visit(route, 'old-flyer', { ip: ip(5) }) // no longer remembered: registers again
  await advance(8000)
  assert.equal(air.rowsFor('old-flyer').length, 1)
  assert.equal(air.scansFor('old-flyer').length, 1)
})

// ── QR pictures (review: "picture encodes the request host") ───────────────

test('the QR picture always encodes the production address, whatever host served it', async (t) => {
  const { air } = setup(t)
  const route = await load(Q)
  const picture = async (name, host) => {
    const response = await visit(route, name, { host }).response
    assert.equal(response.status, 200)
    return response
  }
  const svg = await (await picture('udall-flyer.svg', 'mnparkinsons.org')).text()
  for (const host of ['www.mnparkinsons.org', 'some-branch.mnparkinsons.pages.dev', 'localhost:8788']) {
    assert.equal(await (await picture('udall-flyer.svg', host)).text(), svg, `same picture from ${host}`)
  }

  // Rebuild the module grid from the SVG and compare it with the QR symbol
  // for the address a printed code must point at.
  const size = Number(/viewBox="0 0 (\d+) /.exec(svg)[1])
  const drawn = Array.from({ length: size }, () => Array(size).fill(false))
  for (const [, x, y, run] of svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(run); i++) drawn[Number(y)][Number(x) + i] = true
  }
  const qr = qrcode(0, 'Q')
  qr.addData('https://mnparkinsons.org/q/udall-flyer')
  qr.make()
  const count = qr.getModuleCount()
  assert.equal(size, count + 8, 'four quiet modules on every side')
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const inside = row >= 4 && col >= 4 && row < count + 4 && col < count + 4
      assert.equal(drawn[row][col], inside ? qr.isDark(row - 4, col - 4) : false, `module ${row},${col}`)
    }
  }

  const png = new Uint8Array(await (await picture('udall-flyer.png', 'mnparkinsons.org')).arrayBuffer())
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const other = new Uint8Array(await (await picture('udall-flyer.png', 'some-branch.mnparkinsons.pages.dev')).arrayBuffer())
  assert.deepEqual([...other], [...png])
  assert.equal(air.calls.length, 0, 'pictures never touch Airtable')
})
