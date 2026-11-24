// Tests for two fixes in the older API functions, both found by the
// November 2026 review of the QR feature. Run with:  npm test

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ENV, IPHONE, load, setup } from './harness.mjs'

test('the API log starts again after a burst met a rate limit (it used to stop for good)', async (t) => {
  const { air, advance } = setup(t)
  const middleware = await load('functions/api/_middleware.js')
  const apiRequest = () =>
    middleware.onRequest({
      request: new Request('https://mnparkinsons.org/api/activities', {
        headers: { 'user-agent': IPHONE, 'CF-Connecting-IP': '203.0.113.9' },
      }),
      env: ENV,
      next: async () => new Response('{}'),
      waitUntil: () => {},
    })

  // Airtable answers 429 for the first half minute, while 60 requests arrive:
  // the buffer fills to its limit and every waiting flusher gives up.
  const lockedUntil = Date.now() + 30000
  air.respond = (call) => (call.method === 'POST' && Date.now() < lockedUntil ? { status: 429 } : null)
  for (let n = 0; n < 60; n++) {
    await apiRequest()
    await advance(150, 50)
  }
  await advance(120000, 1000)
  assert.equal(air.other.length, 0, 'nothing could be written during the lockout')

  // Ordinary traffic afterwards must get the log going again.
  for (let n = 0; n < 10; n++) {
    await apiRequest()
    await advance(20000, 1000)
  }
  assert.ok(air.other.length >= 40, `the buffered rows were written, saw ${air.other.length}`)
  assert.ok(
    air.other.some((row) => String(row.fields.Request).startsWith('LOG GAP')),
    'and a LOG GAP row owns up to what was dropped'
  )
})

test('every API request ends up as a log row or inside a LOG GAP count, even when the marker’s own batch is lost', async (t) => {
  const { air, advance, settle } = setup(t)
  const middleware = await load('functions/api/_middleware.js')
  let sent = 0
  const apiRequest = async () => {
    const n = sent++
    await middleware.onRequest({
      request: new Request(`https://mnparkinsons.org/api/activities?n=${n}`, {
        headers: { 'user-agent': IPHONE, 'CF-Connecting-IP': `203.0.113.${(n % 200) + 1}` },
      }),
      env: ENV,
      next: async () => new Response('{}'),
      waitUntil: () => {},
    })
    await settle()
  }
  // The first three log writes are answered 429, 429, 500. The second 429
  // puts its batch back; the 500 then loses that batch for good.
  const answers = [429, 429, 500]
  air.respond = (call) => {
    if (call.method !== 'POST') return null
    const status = answers.shift()
    return status ? { status } : null
  }
  // Fifty requests inside a second: forty are buffered, ten are shed.
  for (let n = 0; n < 50; n++) {
    await apiRequest()
    await advance(20, 20)
  }
  await advance(200000, 500)
  for (let n = 0; n < 12; n++) {
    await apiRequest() // ordinary traffic afterwards writes whatever is left
    await advance(20000, 1000)
  }
  await advance(60000, 1000)

  const gaps = air.other.filter((row) => row.fields.Method === 'GAP')
  const inGaps = gaps.reduce((sum, row) => sum + Number(/about (\d+) request/.exec(row.fields.Request)[1]), 0)
  const rows = air.other.length - gaps.length
  assert.equal(rows + inGaps, sent, `${rows} rows and ${inGaps} in gap counts for ${sent} requests`)
})

test('the Submit form lets a room on one Wi-Fi address through, and typos do not use up the allowance', async (t) => {
  const { air, advance } = setup(t)
  const submit = await load('functions/api/submit.js')
  const form = (changes = {}) =>
    JSON.stringify({
      name: 'Chair yoga',
      activityTypes: ['Yoga'],
      description: 'A gentle seated class for all levels.',
      format: 'In-Person',
      zip: '55401',
      ...changes,
    })
  const send = async (address, body = form()) => {
    const pending = submit.onRequestPost({
      request: new Request('https://mnparkinsons.org/api/submit', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': address, 'content-type': 'application/json' },
        body,
      }),
      env: ENV,
      waitUntil: () => {},
    })
    await advance(300)
    return (await pending).status
  }

  // Thirty people at a meeting, all behind the venue's one address.
  for (let n = 0; n < 30; n++) assert.equal(await send('198.51.100.7'), 201, `submission ${n + 1}`)

  // Twenty attempts bounced for a bad zip code: they never reach Airtable and are not counted.
  for (let n = 0; n < 20; n++) assert.equal(await send('198.51.100.7', form({ zip: '5540' })), 400)

  // The allowance is 50 an hour per address.
  for (let n = 30; n < 50; n++) assert.equal(await send('198.51.100.7'), 201, `submission ${n + 1}`)
  assert.equal(await send('198.51.100.7'), 429, 'the 51st within the hour is refused')
  assert.equal(await send('198.51.100.8'), 201, 'another address is unaffected')
  assert.equal(air.other.length, 51)
})
