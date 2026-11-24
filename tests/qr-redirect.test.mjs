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
import zlib from 'node:zlib'
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

test('a slow Airtable holds the visitor for at most five seconds, and the scan is still counted', async (t) => {
  const { air, advance } = setup(t, { latency: 6000 })
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })

  // Nothing is remembered about the code, so only Airtable knows where it leads.
  const visitor = visit(route, 'poster')
  await advance(4900)
  assert.equal(visitor.done, false, 'still waiting for Airtable at 4.9 s')
  await advance(300)
  assert.equal(visitor.done, true, 'sent on by 5.2 s')
  // The Destination was not known in time, so: the home page.
  assert.equal(await where(visitor), 'https://mnparkinsons.org/?src=poster')

  air.latency = 100
  await advance(8000)
  assert.equal(air.scansFor('poster').length, 1, 'counted once Airtable answered')
})

test('Airtable waking up slowly (four seconds) still gets a first scan to its Destination', async (t) => {
  const { air, advance } = setup(t, { latency: 4000 }) // its first answer after the base has sat idle
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })
  const visitor = visit(route, 'poster')
  await advance(4300)
  assert.equal(await where(visitor), 'https://mnparkinsons.org/?src=poster#/submit')
  air.latency = 100
  await advance(4000)
  assert.equal(air.scansFor('poster').length, 1)
})

test('a code scanned before waits one second for a slow Airtable, then uses what is remembered', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const row = air.addCode('poster', { destination: '#/submit' })
  visit(route, 'poster', { ip: ip(1) })
  await advance(3000)
  await advance(6 * 60000, 1000) // past the five minutes an answer is trusted

  // Airtable is waking up: four seconds for this answer.
  air.latency = 4000
  const slow = visit(route, 'poster', { ip: ip(2) })
  await advance(900)
  assert.equal(slow.done, false, 'Airtable gets a second to answer')
  await advance(300)
  assert.equal(slow.done, true, 'then the remembered Destination is used')
  assert.equal(await where(slow), 'https://mnparkinsons.org/?src=poster#/submit')
  await advance(12000) // the lookup takes four seconds, and so does the write
  assert.equal(air.scansFor('poster').length, 2, 'and the scan is counted once the answer is in')

  // With Airtable quick again, a changed Destination is picked up straight away.
  air.latency = 100
  row.fields.Destination = '#/finder'
  await advance(6 * 60000, 1000)
  const quick = visit(route, 'poster', { ip: ip(3) })
  await advance(400)
  assert.equal(await where(quick), 'https://mnparkinsons.org/?src=poster#/finder')
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
  await advance(1200)
  assert.equal(second.done, true)
  assert.equal(await where(second), 'https://mnparkinsons.org/?src=poster#/submit', 'the remembered Destination')
  await advance(12000)
  assert.equal(air.scansFor('poster').length, 2, 'and counted against the remembered row')

  const stranger = visit(route, 'never-seen', { ip: ip(3) })
  await advance(5200)
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
    // Another site has to be a full https:// address, or start with www.
    ['www.parkinson.org/walk', 'https://www.parkinson.org/walk'],
    ['WWW.Parkinson.org/walk?a=1', 'https://www.parkinson.org/walk?a=1'],
    ['www.parkinson.org:8443/walk', 'https://mnparkinsons.org/?src=CODE'],
    ['//www.parkinson.org/walk', 'https://mnparkinsons.org/?src=CODE'],
    ['zoom.us/j/1234567890', 'https://mnparkinsons.org/?src=CODE'],
    ['parkinson.org/walk', 'https://mnparkinsons.org/?src=CODE'],
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
    ['a page that frames the link in a hidden <iframe>', false, { ua: chrome, headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } }],
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
  // And however much there was to do, the calls were spread out: never more
  // than two in any second from one instance.
  assert.ok(smallestGap(calls) >= 500, `calls at least 500 ms apart, saw ${smallestGap(calls)}`)
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

test('server instances in one data centre take turns registering a new code', async (t) => {
  const { air, advance } = setup(t)
  air.limiter = true // 5 requests a second, like the real base
  const instances = [await load(Q), await load(Q), await load(Q), await load(Q)]
  // A code nobody has scanned before goes up on a slide: 24 phones in three
  // seconds, served by four instances.
  const room = []
  for (let n = 0; n < 24; n++) {
    room.push(visit(instances[n % 4], 'on-the-slide', { ip: ip(n) }))
    await advance(125, 25)
  }
  await advance(12000)
  for (const visitor of room) assert.equal(await where(visitor), 'https://mnparkinsons.org/?src=on-the-slide')
  assert.equal(air.count('POST', CODES), 1, 'one instance registered it; the others waited for its row')
  assert.equal(air.rowsFor('on-the-slide').length, 1)
  assert.equal(air.scansFor('on-the-slide').length, 24, 'every scan counted against it')
  assert.ok(!air.calls.some((call) => call.status === 429), 'the base was never rate limited')
})

test('two server instances registering the same new code count against one row', async (t) => {
  const { air, cache, advance } = setup(t)
  // Neither sees the other's "registering" mark: the same instant, or two data centres.
  cache.hide = (key) => key.includes('/registering/')
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

test('an instance that saw only the spare twin row moves to the shared one within seconds', async (t) => {
  const { air, cache, advance } = setup(t)
  cache.hide = (key) => key.includes('/registering/') // as above: the race happens
  const [one, two, three] = [await load(Q), await load(Q), await load(Q)]
  // The row made first gets the id that sorts last, so the row made second is
  // the one every lookup settles on (both are made in the same second).
  air.codeIds.push('recCzzzzzzzzzzzzzz', 'recCaaaaaaaaaaaaaa')
  await advance(300)
  visit(one, 'table-tent', { ip: ip(1) })
  await advance(900)
  visit(two, 'table-tent', { ip: ip(2) }) // checks for the row just before the first instance's lands
  // The third instance asks between the two rows appearing: it sees only the
  // row that will end up the spare.
  while (air.rowsFor('table-tent').length === 0) await advance(50)
  assert.deepEqual(air.rowsFor('table-tent').map((row) => row.id), ['recCzzzzzzzzzzzzzz'], 'one row exists when the third instance looks')
  visit(three, 'table-tent', { ip: ip(3) })
  await advance(9000)
  const made = air.rowsFor('table-tent')
  assert.equal(made.length, 2, 'the race happened, and the third instance did not add a row of its own')
  assert.equal(Math.floor(made[0].created / 1000), Math.floor(made[1].created / 1000), 'both in the same second, so the id decides')

  // Scans on the third instance over the next minutes.
  for (const [n, wait] of [0, 5000, 25000, 90000, 120000].entries()) {
    await advance(wait, 500)
    visit(three, 'table-tent', { ip: ip(10 + n) })
    await advance(6000)
  }
  const perRow = (id) => air.scans.filter((scan) => (scan.fields['QR Code'] || [])[0] === id).length
  assert.ok(perRow('recCzzzzzzzzzzzzzz') <= 1, `the spare took at most the one scan that raced it, saw ${perRow('recCzzzzzzzzzzzzzz')}`)
  assert.equal(perRow('recCaaaaaaaaaaaaaa') + perRow('recCzzzzzzzzzzzzzz'), 8)
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
  await advance(25000)
  assert.equal(stored(air).length, 0)
  assert.equal(noted(air), 10, 'all ten are owned up to once the scans pause, with nobody coming by')
  assert.equal(air.markers().length, 1, 'in one note')
  assert.ok(air.count('GET', CODES) <= 2, `one lookup, and one more to check the row is still there; saw ${air.count('GET', CODES)}`)

  // And a later one, likewise.
  await advance(11 * 60000, 1000)
  visit(route, 'poster', { ip: ip(20) })
  await advance(30000)
  assert.equal(noted(air), 11, 'all eleven are owned up to')
})

// ── Found by the checks of the fix itself ──────────────────────────────────

test('a lone scan that cannot be counted is owned up to by its own request, with nobody coming by', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  for (let n = 0; n < 20; n++) air.addCode(`typed-in-${n}`) // the day's ceiling for new rows is already reached
  const person = visit(route, 'gala-table')
  await advance(300)
  assert.equal(await where(person), 'https://mnparkinsons.org/?src=gala-table', 'redirected as usual')
  await advance(9000)
  assert.equal(air.markers().length, 0, 'not yet: a note waits ten seconds for the rest of a burst')
  await advance(8000) // still inside the one request's own half minute
  assert.equal(air.rowsFor('gala-table').length, 0)
  assert.equal(air.markers().length, 1)
  assert.equal(air.markers()[0].fields.Scan, 'NOT RECORDED · about 1 scan')
})

test('a burst that cannot be counted gets one note for all of it, and the ceiling is asked about once', async (t) => {
  const lookedAtCeiling = (call) => /CREATED_TIME/.test(call.url.search)
  const { air, advance } = setup(t)
  const route = await load(Q)
  for (let n = 0; n < 20; n++) air.addCode(`typed-in-${n}`)
  for (let n = 0; n < 30; n++) {
    visit(route, 'gala-table', { ip: ip(n) })
    await advance(1300, 100)
  }
  await advance(30000) // nobody comes by afterwards
  assert.equal(air.markers().length, 1, 'one note')
  assert.equal(noted(air), 30, 'covering the whole burst')
  const reads = air.sent('GET', CODES)
  assert.equal(reads.filter(lookedAtCeiling).length, 1, 'one look at the ceiling, not one for every scan')
  // The code itself is looked up again every ten seconds, in case its row has been added by hand.
  assert.ok(reads.length <= 6, `a lookup every ten seconds at most, saw ${reads.length - 1}`)
  assert.equal(air.count('POST', CODES), 0)
})

test('the question to Airtable outlives a visitor who hangs up, and a stuck one is asked again', async (t) => {
  const { air, advance, settle } = setup(t)
  const route = await load(Q)
  air.addCode('slide', { destination: '#/register' })
  let stuck = 1
  air.respond = (call) => (call.method === 'GET' && stuck-- > 0 ? { hang: true } : null) // the first lookup never answers

  const first = visit(route, 'slide', { ip: ip(1) })
  await settle()
  assert.equal(first.done, false)
  assert.ok(first.background.length >= 1, 'the lookup is in the platform’s care before the visitor has an answer')

  // Three more scans inside the next second, and nobody after them.
  const others = []
  for (let n = 2; n <= 4; n++) {
    await advance(300)
    others.push(visit(route, 'slide', { ip: ip(n) }))
  }
  await advance(2500)
  assert.equal(air.count('GET', CODES), 1, 'not asked again yet: a base that is slow to wake looks the same')
  await advance(1100)
  for (const person of others) {
    assert.equal(person.done, true, 'released once the stuck question was asked again')
    assert.equal(await where(person), 'https://mnparkinsons.org/?src=slide#/register')
  }
  await advance(1000)
  assert.equal(await where(first), 'https://mnparkinsons.org/?src=slide#/register', 'even the one whose own call hung')
  await advance(15000)
  assert.equal(air.count('GET', CODES), 2)
  assert.equal(air.scansFor('slide').length, 4)
})

test('a stalled edge cache does not stop Airtable being asked', async (t) => {
  const { air, cache, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })
  cache.stall = true
  const person = visit(route, 'poster')
  await advance(500)
  assert.equal(person.done, true, 'not held up: Airtable was asked after a moment')
  assert.equal(await where(person), 'https://mnparkinsons.org/?src=poster#/submit')
  await advance(4000)
  assert.equal(air.scansFor('poster').length, 1)

  // Nor a picture being drawn (the SVG, which is drawn without any other waiting).
  const picture = visit(route, 'poster.svg')
  await advance(400)
  assert.equal(picture.done, true, 'the picture did not wait on the cache')
  assert.equal((await picture.response).status, 200)

  // Nor does it stop a new code being registered and counted.
  visit(route, 'brand-new', { ip: ip(2) })
  await advance(8000)
  assert.equal(air.rowsFor('brand-new').length, 1)
  assert.equal(air.scansFor('brand-new').length, 1)
})

test('after a 429 an instance comes back with one lookup and one new row in hand, not a full allowance', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  let limited = 1
  air.respond = () => (limited-- > 0 ? { status: 429 } : null)
  visit(route, 'made-up-0', { ip: ip(0) }) // its lookup is the call that gets the 429
  // Made-up addresses keep coming, from something that passes for a person,
  // through the silence and for ten seconds after it.
  for (let n = 1; n <= 164; n++) {
    await advance(250, 50)
    visit(route, `made-up-${n}`, { ip: ip(n) })
  }
  const back = air.calls.slice(1)
  assert.ok(back.length > 0 && back[0].at - air.calls[0].at >= 31000, 'silent for the half minute')
  const lookups = back.filter((call) => call.method === 'GET' && !/CREATED_TIME/.test(call.url.search))
  assert.ok(lookups.length <= 5, `one lookup in hand, then one every three seconds; saw ${lookups.length}`)
  assert.ok(air.count('POST', CODES) <= 2, `one new row in hand, then one every twelve seconds; saw ${air.count('POST', CODES)}`)
})

test('one request makes at most twenty write calls, however many of its tasks are writing', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  // 190 rows are left waiting by requests that have since ended...
  air.respond = (call) => (call.table === SCANS ? { status: 502 } : null)
  for (let n = 0; n < 190; n++) {
    visit(route, 'poster', { ip: ip(n) })
    await advance(100, 50)
  }
  await advance(40000, 500)
  // ...and from now on every row is refused and has to be sent alone.
  air.respond = null
  air.scanFields.delete('City')
  const before = air.count('POST', SCANS)
  visit(route, 'poster', { ip: ip(900) }) // the only request alive: every write from here is its own
  await advance(30000)
  const made = air.count('POST', SCANS) - before
  assert.ok(made >= 15 && made <= 20, `saw ${made}`)
})

test('on a day with more than a hundred new rows, a row added by hand is still found', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  for (let n = 0; n < 125; n++) air.addCode(`import-a-${n}`)
  visit(route, 'gala-table', { ua: 'curl/8.4.0', accept: '*/*' }) // something looks the code up before it exists
  await advance(5000)
  air.addCode('gala-table', { destination: '#/submit' }) // the owner adds the row by hand
  for (let n = 0; n < 125; n++) air.addCode(`import-b-${n}`)

  const person = visit(route, 'gala-table', { ip: ip(1) }) // "no such code" is still remembered
  await advance(6000)
  await person.response
  assert.equal(air.rowsFor('gala-table').length, 1, 'no second row')
  assert.equal(air.scansFor('gala-table').length, 1, 'and the scan is counted against the hand-made one')
})

test('a note that got no clear answer is not repeated for ten minutes, and the next one says what it may repeat', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  for (let n = 0; n < 20; n++) air.addCode(`typed-in-${n}`)
  let unheard = 1
  air.respond = (call) => (call.table === SCANS && unheard-- > 0 ? { status: 503 } : null)
  for (let n = 0; n < 3; n++) visit(route, 'gala-table', { ip: ip(n) })
  await advance(30000)
  assert.equal(air.count('POST', SCANS), 1, 'the note was tried once')
  assert.equal(air.markers().length, 0)

  for (let minute = 1; minute <= 9; minute++) {
    await advance(60000, 1000)
    visit(route, 'typed-in-0', { ip: ip(10 + minute) }) // ordinary scans keep arriving
    await advance(3000)
  }
  assert.equal(air.markers().length, 0, 'not tried again inside ten minutes')

  await advance(60000, 1000)
  for (let n = 0; n < 2; n++) visit(route, 'gala-table', { ip: ip(30 + n) }) // two more that cannot be counted
  await advance(30000)
  assert.equal(air.markers()[0].fields.Scan, 'NOT RECORDED · about 3 scans (3 of them may repeat an earlier note)')
  assert.equal(noted(air), 5, 'and the two later ones are owned up to as well')
})

// ── Found by the review of the third pass ──────────────────────────────────

test('a base that is slow to wake costs one lookup per code, and leaves turns for the next code', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  for (const code of ['a', 'b', 'c', 'd']) air.addCode(code, { destination: `#/${code}` })
  // Airtable's first answers after sitting idle: three and a half seconds each.
  air.respond = (call) => (call.table === CODES ? { latency: 3500 } : null)
  const people = []
  for (const code of ['a', 'b', 'c']) for (let n = 0; n < 3; n++) people.push([code, visit(route, code, { ip: ip(people.length) })])
  await advance(2000)
  people.push(['d', visit(route, 'd', { ip: ip(99) })]) // a fourth code, two seconds in
  await advance(8000)
  for (const [code, person] of people) {
    assert.equal(await where(person), `https://mnparkinsons.org/?src=${code}#/${code}`, `a scan of ${code}`)
  }
  assert.equal(air.count('GET', CODES), 4, 'nobody asked twice while the base was waking')
  await advance(8000)
  assert.equal(stored(air).length, 10)
})

test('several new codes first scanned together cost one lookup each', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  // Five table tents, three people each, in the same instant. The lookups
  // take turns at the gate half a second apart and each takes two and a half
  // seconds, so the last answer comes 4.5 s after it was asked for but only
  // 2.5 s after it left: waiting for a turn is not being stuck.
  let slow = 5
  air.respond = (call) => (call.table === CODES && call.method === 'GET' && slow-- > 0 ? { latency: 2500 } : null)
  for (let code = 0; code < 5; code++) for (let n = 0; n < 3; n++) visit(route, `table-${code}`, { ip: ip(code * 10 + n) })
  await advance(30000)
  const asked = air.sent('GET', CODES).filter((call) => !/CREATED_TIME/.test(call.url.search))
  assert.equal(asked.length, 10, `one lookup and one check for a twin per code, saw ${asked.length}`)
  assert.equal(air.codes.length, 5)
  assert.equal(stored(air).length, 15)
})

test('a row that fails inside another request’s write is retried by the request that brought it', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  // A steady stream keeps the first request writing for the whole of its
  // life; each write takes two seconds. The stream stops, and the last write
  // that old request can start comes back 502.
  const from = Date.now() + 17400
  let failures = 1
  air.respond = (call) => {
    if (call.table !== SCANS) return null
    return Date.now() >= from && failures-- > 0 ? { status: 502, latency: 2000 } : { latency: 2000 }
  }
  for (let n = 0; n < 20; n++) {
    visit(route, 'poster', { ip: ip(n) })
    await advance(900, 100)
  }
  await advance(30000) // nobody comes by afterwards
  assert.ok(air.sent('POST', SCANS).some((call) => call.status === 502), 'the failure happened')
  assert.equal(air.scansFor('poster').length, 20, 'every row was written inside the lives of the requests that brought them')
})

test('an instance does not wait on its own “registering” mark after its own attempt failed', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  let failures = 1
  // The first scan's look at the table before creating the row fails.
  air.respond = (call) => (/CREATED_TIME/.test(call.url.search) && failures-- > 0 ? { status: 500 } : null)
  visit(route, 'slide', { ip: ip(1) })
  await advance(1000)
  assert.equal(air.rowsFor('slide').length, 0)
  visit(route, 'slide', { ip: ip(2) })
  await advance(2500)
  assert.equal(air.rowsFor('slide').length, 1, 'the second scan registers it straight away')
  await advance(8000)
  assert.equal(air.scansFor('slide').length, 1)
})

test('with the day’s limit reached, a row added by hand is picked up within seconds', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  for (let n = 0; n < 20; n++) air.addCode(`typed-in-${n}`)
  const first = visit(route, 'gala-table', { ip: ip(1) })
  await advance(12000)
  assert.equal(await where(first), 'https://mnparkinsons.org/?src=gala-table')
  const again = visit(route, 'gala-table', { ip: ip(2) }) // refused a second time, the limit now being remembered
  await advance(5000)
  assert.equal(await where(again), 'https://mnparkinsons.org/?src=gala-table')
  air.addCode('gala-table', { destination: '#/submit' }) // the owner adds the row by hand
  await advance(6000) // eleven seconds after that second refusal
  const third = visit(route, 'gala-table', { ip: ip(3) })
  await advance(6000)
  assert.equal(await where(third), 'https://mnparkinsons.org/?src=gala-table#/submit')
  assert.equal(air.scansFor('gala-table').length, 1)
  assert.equal(air.rowsFor('gala-table').length, 1)
})

test('after a 429 that found the lookup ration spent, the first scan after the silence is still looked up', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  let calls = 0
  air.respond = () => (++calls === 3 ? { status: 429 } : null) // the third call is refused
  for (let n = 0; n < 8; n++) visit(route, `first-${n}`, { ip: ip(n) }) // eight codes at once: the whole lookup ration
  await advance(34000)
  const before = air.calls.length
  visit(route, 'afterwards', { ip: ip(50) })
  await advance(1000)
  assert.equal(air.calls.length - before >= 1, true, 'looked up at once, not three seconds later')
})

test('a code with many rows is settled on the same row by every instance', async (t) => {
  const { air, cache, advance } = setup(t)
  cache.hide = () => true // two data centres: each instance asks Airtable itself
  const one = await load(Q)
  const two = await load(Q)
  // Eight rows for one code, made in the same second. Airtable lists them in
  // no fixed order, so the route must see all of them to pick the same one.
  const rows = Array.from({ length: 8 }, () => air.addCode('poster'))
  rows.forEach((row, n) => (row.id = `recC5${n}`))
  rows[0].id = 'recC00'
  rows[7].id = 'recC01'
  visit(one, 'poster', { ip: ip(1) })
  await advance(4000)
  visit(two, 'poster', { ip: ip(2) })
  await advance(4000)
  assert.deepEqual(air.scans.map((scan) => scan.fields['QR Code'][0]), ['recC00', 'recC00'])
})

test('when Airtable cannot say, a slow edge cache is still waited for', async (t) => {
  const { air, cache, advance } = setup(t)
  const one = await load(Q)
  const two = await load(Q)
  air.addCode('poster', { destination: '#/submit' })
  visit(one, 'poster', { ip: ip(1) })
  await advance(4000) // the data centre's cache now knows the code
  air.respond = (call) => (call.table === CODES ? { status: 500 } : null)
  cache.delay = 600
  const person = visit(two, 'poster', { ip: ip(2) }) // a fresh instance: only the cache can tell it
  await advance(1200)
  assert.equal(await where(person), 'https://mnparkinsons.org/?src=poster#/submit')
  await advance(5000)
  assert.equal(air.scansFor('poster').length, 2)
})

// ── Found by the check of the fourth pass ──────────────────────────────────

// At both speeds: an answer that takes 200 ms lands between two of a waiting
// scan's looks, which is where a scan used to give up on it.
for (const latency of [100, 200]) {
  test(`once Airtable is well again, nobody scanning a code that was stuck lands on the home page (answers take ${latency} ms)`, async (t) => {
    const { air, advance } = setup(t, { latency })
    const route = await load(Q)
    air.addCode('poster', { destination: '#/submit' })
    // One code, someone every quarter of a second for 14 seconds. Lookups sent
    // in the first four and a half seconds are lost; after that Airtable is
    // well. Nothing else is going on, so nothing but a fresh lookup can tell.
    const wellFrom = Date.now() + 4500
    air.respond = (call) => (call.table === CODES && Date.now() < wellFrom ? { hang: true } : null)
    const people = []
    for (let n = 0; n < 57; n++) {
      people.push({ at: Date.now(), visitor: visit(route, 'poster', { ip: ip(n) }) })
      await advance(250, 50)
    }
    await advance(30000)
    const lookups = air.sent('GET', CODES).map((call) => call.at - air.calls[0].at)
    assert.ok(lookups.length >= 3 && lookups[2] <= 8100, `asked again every four seconds while it was stuck: ${lookups}`)
    for (const person of people.filter((p) => p.at >= wellFrom)) {
      assert.equal(await where(person.visitor), 'https://mnparkinsons.org/?src=poster#/submit', `a scan ${person.at - people[0].at} ms in`)
    }
    assert.ok(air.scansFor('poster').length >= 55, `the scans are stored, saw ${air.scansFor('poster').length} of 57`)
  })
}

for (const offset of [99, 100, 101, 102, 103]) {
  test(`the second scanner of a brand-new code is counted whatever the timing (${offset} ms behind the first)`, async (t) => {
    const { air, cache, advance } = setup(t)
    const route = await load(Q)
    cache.delay = 5 // the edge cache takes five milliseconds
    let first = true
    // The first lookup is answered after 603 ms: just as the second scan's
    // half-second look at it ends.
    air.respond = () => (first ? ((first = false), { latency: 598 }) : null)
    visit(route, 'gala', { ip: ip(1) })
    await advance(offset, 1)
    visit(route, 'gala', { ip: ip(2) })
    await advance(700 - offset, 1)
    await advance(32000, 20)
    assert.equal(air.rowsFor('gala').length, 1)
    assert.equal(air.scansFor('gala').length, 2, 'both scans stored against the new row')
    assert.equal(air.markers().length, 0)
  })
}

test('a scan of a remembered code is written by its own request even when the fresh answer never comes', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })
  visit(route, 'poster', { ip: ip(0) })
  await advance(4000)
  await advance(6 * 60000, 1000) // remembered, but no longer fresh
  air.respond = (call) => (call.table === CODES ? { hang: true } : null) // every lookup hangs; writes work
  // Five people in a row. Each waits its turn to ask again, so the last of
  // them is still waiting for an answer late in its own request.
  for (let n = 1; n <= 5; n++) {
    visit(route, 'poster', { ip: ip(n) })
    await advance(300, 50)
  }
  await advance(32000) // the whole life of those requests, and nobody afterwards
  assert.equal(air.scansFor('poster').length, 6, 'all five, with no later visitor to write them')
})

// ── Found by the check of the fifth pass ───────────────────────────────────

test('in a long Airtable silence, every scan whose request is still alive when the answer comes is stored', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  air.addCode('poster', { destination: '#/submit' })
  // One code, someone every half second for 41 seconds. Every lookup sent in
  // the first 31 seconds is lost; after that Airtable is well. A request
  // lives 27 seconds, so by then the oldest waiting scans are nearly out of
  // time: one of those must not be the one that asks again, or its call is
  // cut short with it and everybody waiting on it gives up too.
  const wellFrom = Date.now() + 31000
  air.respond = (call) => (call.table === CODES && Date.now() < wellFrom ? { hang: true } : null)
  const people = []
  for (let n = 0; n < 82; n++) {
    const cf = { city: `v${n}`, region: 'Minnesota', country: 'US' }
    people.push({ at: Date.now(), tag: cf.city, visitor: visit(route, 'poster', { ip: ip(n), cf }) })
    await advance(500, 25)
  }
  await advance(70000, 250)
  const answered = air.sent('GET', CODES).find((call) => call.at >= wellFrom).at + air.latency
  const counted = stored(air).map((row) => row.fields.City)
  // Still alive when the answer came, with half a second in hand.
  const alive = people.filter((p) => p.at < wellFrom && p.at > answered - 26500)
  assert.ok(alive.length >= 40, `enough people were waiting, saw ${alive.length}`)
  const missed = alive.filter((p) => !counted.includes(p.tag))
  assert.equal(missed.length, 0, `scans not stored, from requests that began ${missed.map((p) => answered - p.at)} ms before the answer`)
  for (const person of people.filter((p) => p.at >= wellFrom)) {
    assert.equal(await where(person.visitor), 'https://mnparkinsons.org/?src=poster#/submit')
  }
  // Nothing twice, and the scans that ran out of time first are owned up to.
  assert.equal(new Set(counted).size, counted.length)
  assert.equal(counted.length + noted(air), people.length)
})

test('a remembered code whose row was replaced: scans sent on with the old page are counted against the new row', async (t) => {
  const { air, advance } = setup(t)
  const route = await load(Q)
  const old = air.addCode('poster', { destination: '#/old' })
  visit(route, 'poster', { ip: ip(0) })
  await advance(4000)
  await advance(6 * 60000, 1000) // remembered, but no longer fresh
  // The row is deleted and a new one made for the same code, and Airtable
  // loses every lookup for the next eight seconds.
  air.codes = air.codes.filter((row) => row !== old)
  const fresh = air.addCode('poster', { destination: '#/new' })
  const wellFrom = Date.now() + 8000
  air.respond = (call) => (call.table === CODES && Date.now() < wellFrom ? { hang: true } : null)
  const people = []
  for (let n = 1; n <= 5; n++) {
    people.push(visit(route, 'poster', { ip: ip(n) }))
    await advance(300, 50)
  }
  await advance(1000)
  for (const person of people) {
    assert.equal(await where(person), 'https://mnparkinsons.org/?src=poster#/old', 'sent on after a second with what was remembered')
  }
  // The answer arrives long after they have gone, while their requests can
  // still write. A scan whose own lookup was lost waits on the newer one.
  await advance(33000)
  const onNewRow = air.scans.filter((row) => (row.fields['QR Code'] || [])[0] === fresh.id)
  assert.equal(onNewRow.length, 5, 'all five counted against the row that exists now')
  assert.equal(air.markers().length, 0)
  const later = visit(route, 'poster', { ip: ip(9) })
  await advance(1000)
  assert.equal(await where(later), 'https://mnparkinsons.org/?src=poster#/new')
})

test('a writer with no time left for another write lets go at once', async (t) => {
  const { air, advance, settle } = setup(t)
  const route = await load(Q)
  air.addCode('poster')
  // The code's first answer takes six and a half seconds, and the scan's row
  // is then refused (as when the code's row has just been deleted). So the
  // scan is lost eight seconds into its request and its note falls due at
  // eighteen, with under a second of writing time left after it.
  let lookups = 0
  let writes = 0
  air.respond = (call) =>
    call.table === CODES
      ? lookups++ === 0
        ? { latency: 6500 }
        : null
      : call.table === SCANS && writes++ === 0
        ? { status: 422 }
        : null
  const visitor = visit(route, 'poster', { ip: ip(7) })
  await advance(18900, 50)
  assert.equal(air.markers().length, 1, 'the note is written by the request that lost the scan')
  let finished = false
  Promise.all(visitor.background).then(() => (finished = true))
  await settle()
  assert.ok(finished, 'the request is not kept alive for a pace wait it could not use')
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
  // The first picture is asked for on a preview host, so the copy that gets
  // cached for everyone is made by the host most likely to get it wrong.
  const svg = await (await picture('udall-flyer.svg', 'some-branch.mnparkinsons.pages.dev')).text()
  for (const host of ['mnparkinsons.org', 'www.mnparkinsons.org', 'localhost:8788']) {
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

  // The PNG: unpack it and compare it with the same symbol, module by module.
  const png = new Uint8Array(await (await picture('udall-flyer.png', 'some-branch.mnparkinsons.pages.dev')).arrayBuffer())
  assert.deepEqual([...png.slice(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const view = new DataView(png.buffer)
  const width = view.getUint32(16)
  assert.equal(view.getUint32(20), width, 'square')
  assert.deepEqual([png[24], png[25]], [1, 0], 'one bit per pixel, greyscale')
  const idatLength = view.getUint32(33)
  assert.equal(String.fromCharCode(...png.slice(37, 41)), 'IDAT')
  const pixels = zlib.inflateSync(png.slice(41, 41 + idatLength))
  const scale = width / size
  assert.ok(Number.isInteger(scale) && scale >= 4, `whole pixels per module, saw ${scale}`)
  const rowBytes = Math.ceil(width / 8) + 1
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      // The middle pixel of each module; a 0 bit is black.
      const x = col * scale + (scale >> 1)
      const y = row * scale + (scale >> 1)
      const black = (pixels[y * rowBytes + 1 + (x >> 3)] & (0x80 >> (x & 7))) === 0
      assert.equal(black, drawn[row][col], `PNG module ${row},${col}`)
    }
  }
  const other = new Uint8Array(await (await picture('udall-flyer.png', 'mnparkinsons.org')).arrayBuffer())
  assert.deepEqual([...other], [...png])
  assert.equal(air.calls.length, 0, 'pictures never touch Airtable')
})
