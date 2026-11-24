import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ENV, IPHONE, load, setup } from './harness.mjs'

test('API analytics keeps allowlisted filter labels and excludes visitor data', async t => {
  const { air, advance } = setup(t)
  const { onRequest } = await load('functions/api/_middleware.js')
  const url = new URL('https://example.test/api/activities')
  for (const [key, value] of Object.entries({
    q: 'private note from the visitor', zip: '55101', type: 'Yoga', cost: 'a new option',
  })) url.searchParams.set(key, value)
  const headers = { 'User-Agent': IPHONE, 'CF-Connecting-IP': '203.0.113.42', Referer: 'https://example.test/?src=campaign' }
  const request = new Request(url, { headers })
  request.cf = { city: 'Test city', region: 'Test region', country: 'US' }
  const malformed = new Request('https://example.test/api/activity/private-value', { headers })
  const background = []
  const context = { env: ENV, waitUntil: task => background.push(task) }
  await onRequest({ ...context, request, next: async () => Response.json({}) })
  await onRequest({ ...context, request: malformed, next: async () => new Response(null, { status: 404 }) })
  await advance(8000, 200)
  await Promise.all(background)

  const rows = air.other.map(row => row.fields)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0]['Filters used'], ['Keyword search', 'Type: Yoga'])
  assert.equal(rows[1].Path, '/api/activity/:id')
  for (const row of rows) {
    for (const banned of ['Query', 'Visitor', 'Referer', 'User agent', 'City', 'Country', 'Region']) {
      assert.equal(Object.hasOwn(row, banned), false, banned)
    }
    assert.doesNotMatch(JSON.stringify(row), /private|55101|campaign|Test city|203\.0\.113/)
  }
})
