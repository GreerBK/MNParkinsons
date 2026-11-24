// Tests for functions/q/[code].js: the tracked-QR redirect.
// Run with:  npm test
//
// Each test is one scenario from real use or from the November 2026 code
// reviews: a slow Airtable, a room scanning at once, a script making up
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
// Scan rows that are counted against a code (everything but the notes).
const stored = (air) => air.scans.filter((row) => row.fields['QR Code'])

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

// ── What the route remembers ───────────────────────────────────────────────

test('a changed Destination takes effect within five minutes', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const row = air.addCode('poster', { destination: '#/submit' })
  const first = visit(route, 'poster', { ip: ip(1) })
  await advance(300)
  assert.equal(await where(first), 'https://mnparkinsons.org/?src=poster#/submit')

  row.fields.Destination = '#/finder' // the owner edits the cell
  await advance(4 * 60000, 1000)
  const soon = visit(route, 'poster', { ip: ip(2) })
  await advance(300)
  assert.equal(await where(soon), 'https://mnparkinsons.org/?src=poster#/submit', 'still the remembered one at four minutes')

  await advance(2 * 60000, 1000)
  const later = visit(route, 'poster', { ip: ip(3) })
  await advance(300)
  assert.equal(await where(later), 'https://mnparkinsons.org/?src=poster#/finder', 'the new one after five')
})

test('a fresh server instance uses what the data centre already knows', async (t) => {
  const { air, advance } = setup(t)
  const one = await load(Q)
  const two = await load(Q)
  air.addCode('poster', { destination: '#/submit' })
  visit(one, 'poster', { ip: ip(1) })
  await advance(3000)
  assert.equal(air.count('GET', CODES), 1)

  const visitor = visit(two, 'poster', { ip: ip(2) })
  await advance(3000)
  assert.equal(await where(visitor), 'https://mnparkinsons.org/?src=poster#/submit')
  assert.equal(air.count('GET', CODES), 1, 'no second lookup: the edge cache answered')
  assert.equal(air.scansFor('poster').length, 2)
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

test('one stuck lookup does not hold up everyone else scanning that code', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })
  let stuck = 1
  air.respond = (call) => (call.method === 'GET' && stuck-- > 0 ? { hang: true } : null) // only the first call hangs

  const people = []
  for (let n = 0; n < 8; n++) {
    people.push(visit(route, 'poster', { ip: ip(n) }))
    await advance(1000)
  }
  await advance(15000)
  for (const [n, person] of people.entries()) {
    assert.equal(await where(person), 'https://mnparkinsons.org/?src=poster#/submit', `person ${n + 1}`)
  }
  assert.equal(air.count('GET', CODES), 2, 'the stuck call, and one more once it looked stuck')
  assert.equal(air.scansFor('poster').length, 8)
})

test('scans that cannot be counted are owned up to in a NOT RECORDED row', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  const healthyFrom = Date.now() + 20000
  air.respond = (call) => (Date.now() < healthyFrom ? { status: 500 } : null) // Airtable is down for 20 seconds

  for (let n = 0; n < 6; n++) {
    const person = visit(route, 'poster', { ip: ip(n) })
    await advance(3000)
    assert.equal(await where(person), 'https://mnparkinsons.org/?src=poster', 'still reaches the site')
  }
  assert.equal(air.scans.length, 0)

  await advance(22000)
  visit(route, 'poster', { ip: ip(9) })
  await advance(6000)
  assert.equal(air.scansFor('poster').length, 1)
  assert.equal(air.markers().length, 1)
  assert.equal(air.markers()[0].fields.Scan, 'NOT RECORDED · about 6 scans')
  assert.ok(!('QR Code' in air.markers()[0].fields), 'the note is not counted against any code')
  assert.ok(Date.parse(air.markers()[0].fields.Time) < healthyFrom, 'and is dated when the trouble began')
})

// ── Destinations typed by hand (review: "mistyped Destination is a dead link") ─

test('a Destination that is plainly not an address falls back to the home page', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const cases = [
    ['', 'https://mnparkinsons.org/?src=CODE'],
    ['https://mnparkinsons.org/#/activity/recUajXmBFDuLg4TW', 'https://mnparkinsons.org/?src=CODE#/activity/recUajXmBFDuLg4TW'],
    ['mnparkinsons.org/#/submit', 'https://mnparkinsons.org/?src=CODE#/submit'],
    ['#/submit', 'https://mnparkinsons.org/?src=CODE#/submit'],
    ['  #/submit  ', 'https://mnparkinsons.org/?src=CODE#/submit'],
    ['/#/finder?type=Yoga', 'https://mnparkinsons.org/?src=CODE#/finder?type=Yoga'],
    ['https://www.parkinson.org/walk?a=1', 'https://www.parkinson.org/walk?a=1'],
    ['https://example.org:8443/page', 'https://example.org:8443/page'],
    // Slips that used to become hosts like https://submit/
    ['submit', 'https://mnparkinsons.org/?src=CODE'],
    ['activity/recUajXmBFDuLg4TW', 'https://mnparkinsons.org/?src=CODE'],
    ['submit.html', 'https://mnparkinsons.org/?src=CODE'],
    ['serene.mp4', 'https://mnparkinsons.org/?src=CODE'],
    ['www.mnparkinsons', 'https://mnparkinsons.org/?src=CODE'],
    ['mnparkinsons.ogr/#/submit', 'https://mnparkinsons.org/?src=CODE'],
    ['https:/mnparkinsons.org/#/submit', 'https://mnparkinsons.org/?src=CODE'],
    ['the finder page', 'https://mnparkinsons.org/?src=CODE'],
    ['https://192.168.1.1/x', 'https://mnparkinsons.org/?src=CODE'],
    ['https://localhost/x', 'https://mnparkinsons.org/?src=CODE'],
    ['javascript:alert(1)', 'https://mnparkinsons.org/?src=CODE'],
    ['http://insecure.example/', 'https://mnparkinsons.org/?src=CODE'],
    // Another site has to be a full https:// address
    ['www.parkinson.org/walk', 'https://mnparkinsons.org/?src=CODE'],
    ['//www.parkinson.org/walk', 'https://mnparkinsons.org/?src=CODE'],
    // Our own site over http: same page over https; but never on a port
    ['http://mnparkinsons.org/#/submit', 'https://mnparkinsons.org/?src=CODE#/submit'],
    ['mnparkinsons.org:80/#/submit', 'https://mnparkinsons.org/?src=CODE'],
    ['http://mnparkinsons.org:8080/#/submit', 'https://mnparkinsons.org/?src=CODE'],
    // An email address is not a page
    ['info@mnparkinsons.org', 'https://mnparkinsons.org/?src=CODE'],
    ['someone@gmail.com', 'https://mnparkinsons.org/?src=CODE'],
    ['mailto:someone@gmail.com', 'https://mnparkinsons.org/?src=CODE'],
    ['https://user:pw@example.org/page', 'https://mnparkinsons.org/?src=CODE'],
    // The site's other host names are still "our site": tagged, and never a loop
    ['https://www.mnparkinsons.org/#/submit', 'https://www.mnparkinsons.org/?src=CODE#/submit'],
    ['https://mnparkinsons.pages.dev/#/finder', 'https://mnparkinsons.pages.dev/?src=CODE#/finder'],
    ['https://some-branch.mnparkinsons.pages.dev/#/finder', 'https://some-branch.mnparkinsons.pages.dev/?src=CODE#/finder'],
    ['https://mnparkinsons.org/q/other', 'https://mnparkinsons.org/?src=CODE'],
    ['https://www.mnparkinsons.org/q/other', 'https://mnparkinsons.org/?src=CODE'],
    ['https://some-branch.mnparkinsons.pages.dev/q/other', 'https://mnparkinsons.org/?src=CODE'],
    ['https://mnparkinsons.org/%71/other', 'https://mnparkinsons.org/?src=CODE'],
    ['https://mnparkinsons.org//q/other', 'https://mnparkinsons.org/?src=CODE'],
    // What cannot be caught: a misspelling that still looks like an address
    ['https://mnparkinsons.ogr/#/submit', 'https://mnparkinsons.ogr/#/submit'],
  ]
  for (const [index, [destination, expected]] of cases.entries()) {
    const code = `dest-${index}`
    air.addCode(code, { destination })
    const visitor = visit(route, code, { ip: ip(index) })
    await advance(3200) // slower than the lookup ration refills
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
    ['a click in Word or PowerPoint (Office fetches the link itself)', true, { ua: 'Mozilla/4.0 (compatible; ms-office; MSOffice 16)', accept: '*/*' }],
    ['a click in newer Office', true, { ua: 'Microsoft Office/16.0 (Windows NT 10.0; Microsoft Word 16.0.17328; Pro)', accept: null }],
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
    ['a page preview marked the old way', false, { headers: { 'x-purpose': 'preview' } }],
    ['Opera Mini in extreme data-saving mode (a known gap)', false, { ua: 'Opera/9.80 (Android; Opera Mini/8.0.1807/36.1609; U; en) Presto/2.12.423 Version/12.16' }],
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

test('a browser loading the link ahead of the person is told to come back when they really open it', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  const guess = await visit(route, 'poster', { headers: { 'sec-fetch-mode': 'navigate', 'sec-purpose': 'prefetch;prerender' } }).response
  assert.equal(guess.status, 503, 'declined: the browser drops its speculative copy')
  assert.equal(air.calls.length, 0)

  const real = visit(route, 'poster', { headers: { 'sec-fetch-mode': 'navigate' } })
  await advance(4000)
  assert.equal((await real.response).status, 302)
  assert.equal(air.scansFor('poster').length, 1, 'the real opening is the one that counts')
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

  // The same from something that passes for a person, twenty of them.
  const before = air.calls.length
  const people = Array.from({ length: 20 }, (_, n) => visit(route, `typo-${n}`, { ip: ip(100 + n) }))
  await advance(40000)
  for (const [n, visitor] of people.entries()) assert.equal(await where(visitor), `https://mnparkinsons.org/?src=typo-${n}`)
  const calls = air.calls.slice(before)
  const lookups = calls.filter((call) => call.method === 'GET' && !/CREATED_TIME/.test(call.url.search))
  assert.ok(lookups.length <= 13, `lookups are rationed (8 at once, then one every 3 seconds), saw ${lookups.length}`)
  assert.ok(air.codes.length >= 1 && air.codes.length <= 5, `rows are rationed too, saw ${air.codes.length}`)
  // And however much there was to do, the calls were spread out.
  assert.ok(smallestGap(calls) >= 350, `calls at least 350 ms apart, saw ${smallestGap(calls)}`)
})

test('new codes are capped at about twenty a day across the whole table', async (t) => {
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
  assert.equal(stored(air).length, 20, 'scans of codes that were not registered are not stored')

  // A day later the window has moved on, and the five that missed out are owned up to.
  await advance(24 * 3600000, 600000)
  const later = visit(route, 'tomorrow', { ip: ip(99) })
  await advance(10000, 250)
  await later.response
  assert.equal(air.rowsFor('tomorrow').length, 1)
  assert.equal(noted(air), 5)
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

test('two server instances registering the same new code count against one row', async (t) => {
  const { air, advance } = setup(t)
  const one = await load(Q)
  const two = await load(Q)
  const a = visit(one, 'table-tent', { ip: ip(1) })
  await advance(100)
  const b = visit(two, 'table-tent', { ip: ip(2) })
  await advance(10000)
  await Promise.all([a.response, b.response])
  assert.equal(air.count('POST', CODES), 2, 'both instances did create a row (the race happened)')
  // Nothing is deleted (a row may already be in use elsewhere): one row gets
  // every scan and the other is left as a spare with none.
  assert.equal(air.count('DELETE', CODES), 0)
  const used = new Set(air.scansFor('table-tent').map((scan) => scan.fields['QR Code'][0]))
  assert.equal(air.scansFor('table-tent').length, 2)
  assert.equal(used.size, 1, 'both scans count against the same row')

  // And every later scan, from either instance, lands on that same row.
  visit(one, 'table-tent', { ip: ip(3) })
  visit(two, 'table-tent', { ip: ip(4) })
  await advance(6000)
  assert.equal(new Set(air.scansFor('table-tent').map((scan) => scan.fields['QR Code'][0])).size, 1)
  assert.equal(air.scansFor('table-tent').length, 4)
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

test('one address repeating a scan is rationed whatever browser it claims, and every scan is stored or noted', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  for (let n = 0; n < 400; n++) {
    // One address, once a second, changing its browser name every time.
    visit(route, 'poster', { ua: `Mozilla/5.0 (Windows NT 10.0; rv:${n}.0) Gecko/20100101 Firefox/${n}.0` })
    await advance(1000, 250)
  }
  await advance(20000, 250)
  // 300 at once, then one every two minutes: three more in those 400 seconds.
  assert.equal(air.scansFor('poster').length, 303)
  assert.ok(air.markers().length >= 1, 'a note says scans went unrecorded')

  await advance(10 * 60000, 1000)
  for (let n = 0; n < 5; n++) {
    visit(route, 'poster')
    await advance(1000, 250)
  }
  await advance(20000, 250)
  assert.equal(air.scansFor('poster').length, 308, 'five more allowances came back in ten minutes')
  // Notes are at least ten minutes apart, each covering what was lost since
  // the one before. Between them they account for every scan not stored.
  assert.equal(air.scansFor('poster').length + noted(air), 405)
  assert.ok(air.markers().length <= 2)
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

test('a hall of 300 phones behind one venue Wi-Fi address is stored in full', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('keynote')
  for (let n = 0; n < 300; n++) {
    visit(route, 'keynote') // every phone behind the one address
    await advance(400, 100)
  }
  await advance(40000, 250)
  assert.equal(air.scansFor('keynote').length, 300)
  assert.equal(air.markers().length, 0)
})

test('one server instance stores 600 scans at once and then 600 an hour, whoever asks', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  for (let n = 0; n < 900; n++) {
    visit(route, 'poster', { ip: ip(n) }) // every request a "different visitor"
    await advance(330, 110)
  }
  await advance(60000, 500)
  const kept = air.scansFor('poster').length
  assert.ok(kept >= 600 && kept <= 660, `600 plus what trickled back in five minutes, saw ${kept}`)
  assert.ok(air.markers().length >= 1)

  // The rest are owned up to once the next note is due.
  await advance(11 * 60000, 1000)
  visit(route, 'poster', { ip: ip(990) })
  await advance(20000, 500)
  assert.equal(air.scansFor('poster').length + noted(air), 901)
})

// ── When a write goes wrong (review: "never retried", "wedged", "stuck") ───

test('a write refused with the gateway error Airtable calls safe to retry is tried again', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  let failures = 1
  air.respond = (call) => (call.table === SCANS && failures-- > 0 ? { status: 502 } : null)
  visit(route, 'poster')
  await advance(12000)
  assert.equal(air.count('POST', SCANS), 2)
  assert.equal(air.scansFor('poster').length, 1)
})

for (const [name, failure] of [
  ['answers 503 (which can come after the rows were saved)', { status: 503 }],
  ['drops the connection', { error: true }],
  ['never answers', { hang: true }],
]) {
  test(`a write that ${name} is not sent twice; it is noted instead`, async (t) => {
    const { air, advance } = setup(t)
    const route = await load(Q)
    air.addCode('poster')
    let failures = 1
    air.respond = (call) => (call.table === SCANS && failures-- > 0 ? failure : null)
    visit(route, 'poster', { ip: ip(1) })
    await advance(30000)
    assert.equal(air.count('POST', SCANS), 1, 'one attempt only')
    assert.equal(air.scans.length, 0)

    visit(route, 'poster', { ip: ip(2) }) // the next scan brings the note with it
    await advance(6000)
    assert.equal(air.scansFor('poster').length, 1)
    assert.equal(noted(air), 1)
  })
}

test('a slow Airtable does not make the NOT RECORDED note repeat', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  // Every write takes longer than the route will wait for it.
  air.respond = (call) => (call.table === SCANS ? { hang: true } : null)
  for (let n = 0; n < 12; n++) {
    visit(route, 'poster', { ip: ip(n) })
    await advance(20000, 500)
  }
  air.respond = null
  for (let n = 0; n < 3; n++) {
    visit(route, 'poster', { ip: ip(50 + n) })
    await advance(20000, 500)
  }
  // Five minutes in all: at most one note was attempted in that time.
  const attempts = air
    .sent('POST', SCANS)
    .filter((call) => call.body.records.some((record) => String(record.fields.Scan).startsWith('NOT RECORDED')))
  assert.ok(attempts.length <= 1, `notes attempted: ${attempts.length}`)
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
  assert.equal(noted(air), 1, 'and the scan of the code that could not be looked up is owned up to')
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

test('a burst that meets a 429 and fills the buffer recovers, gently, once the lockout ends', async (t) => {
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
  // The requests still alive when the lockout ended started on the backlog themselves...
  assert.ok(air.scansFor('poster').length >= 40, `part of the backlog, saw ${air.scansFor('poster').length}`)
  // ...at the gentle pace: no rush back the moment the lockout lifts.
  assert.ok(smallestGap(air.sent('POST', SCANS).slice(1)) >= 1000)

  // And the instance is not wedged: the next scans are written, along with
  // whatever was still waiting. Fifty arrived while the buffer was full.
  for (let n = 0; n < 5; n++) visit(route, 'poster', { ip: ip(500 + n) })
  await advance(25000)
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
  await advance(30000)
  visit(route, 'poster', { ip: ip(4) })
  await advance(6000)
  assert.equal(air.scansFor('poster').length, 3)
  assert.equal(noted(air), 1, 'the row the cut-off run was holding is owned up to')
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

test('a scan table that refuses rows for another reason does not cost a lookup on every scan', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  air.scanFields.delete('City') // someone renamed a QR Scans column: every row is refused
  for (let n = 0; n < 10; n++) {
    visit(route, 'poster', { ip: ip(n) })
    await advance(5000)
  }
  assert.equal(stored(air).length, 0)
  assert.ok(noted(air) >= 1, 'the first few are owned up to straight away')
  assert.ok(air.count('GET', CODES) <= 2, `one lookup, and one more to check the row is still there; saw ${air.count('GET', CODES)}`)

  // The rest follow in the next note, ten minutes on.
  await advance(11 * 60000, 1000)
  visit(route, 'poster', { ip: ip(20) })
  await advance(10000)
  assert.equal(noted(air), 11, 'all eleven are owned up to')
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
