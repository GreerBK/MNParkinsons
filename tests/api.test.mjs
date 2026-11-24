// Tests for two fixes in the older API functions, both found by the
// November 2026 review of the QR feature. Run with:  npm test

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ENV, IPHONE, load, setup } from './harness.mjs'
import { APPROVED_FILTER_OPTIONS, SUBMISSIONS_TABLE_ID } from '../functions/_shared/activity-schema.js'

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

const ACTIVITY_ID = 'rec12345678901234'
const OTHER_ACTIVITY_ID = 'rec23456789012345'
const EVENT_ID = 'rec34567890123456'
const ACTIVITY_ENV = { ...ENV, AIRTABLE_TABLE_ID: 'tblActivities' }

test('public activity responses project fields and bypass the old raw-record caches', async (t) => {
  const { cache } = setup(t)
  const activities = await load('functions/api/activities.js')
  const detail = await load('functions/api/activity/[id].js')
  const row = {
    id: ACTIVITY_ID,
    createdTime: '2026-11-24T18:00:00.000Z',
    fields: {
      Status: 'Active',
      'Activity Name': 'Example class',
      'Activity Type': ['Boxing', 'Dance'],
      Intensity: ['Light', 'Moderate'],
      Schedule: 'Mondays at 9 AM',
      Reports: ['recPrivateReport'],
      'API Log': ['recPrivateLog'],
      'Internal notes': 'Private',
    },
  }
  const detailUrl = `https://mnparkinsons.org/api/activity/${ACTIVITY_ID}`
  const oldHeaders = { 'Cache-Control': 'public, max-age=300' }
  await cache.put(new Request(detailUrl), Response.json(row, { headers: oldHeaders }))
  await cache.put(
    new Request(`https://edge-cache.internal/airtable-active/${ACTIVITY_ENV.AIRTABLE_BASE_ID}/${ACTIVITY_ENV.AIRTABLE_TABLE_ID}`),
    Response.json([row], { headers: oldHeaders }),
  )
  const calls = []
  globalThis.fetch = async (input) => {
    const url = new URL(input)
    calls.push(url)
    if (url.searchParams.has('maxRecords')) {
      return Response.json({ records: [row] })
    }
    if (url.searchParams.get('offset')) {
      return Response.json({ records: [
        { id: OTHER_ACTIVITY_ID, fields: { Status: 'Active', 'Activity Type': ['Kickboxing'], Intensity: ['Highlights'] } },
        { id: EVENT_ID, fields: { Status: 'Active', 'Activity Type': ['Events'], 'Start Date': '2026-11-30' } },
      ] })
    }
    return Response.json({ records: [row], offset: 'next-page' })
  }
  const fetchList = async (query = '') => {
    const response = await activities.onRequestGet({
      request: new Request(`https://mnparkinsons.org/api/activities?${query}`),
      env: ACTIVITY_ENV,
    })
    assert.equal(response.status, 200)
    return (await response.json()).records
  }
  const catalog = await fetchList()
  assert.equal(catalog.length, 3)
  assert.equal(calls.length, 2, 'the old raw list cache is bypassed and offsets are followed')
  assert.equal(calls[1].searchParams.get('offset'), 'next-page')
  const selectedFields = calls[0].searchParams.getAll('fields[]')
  assert.ok(selectedFields.includes('Activity Name'))
  assert.ok(!selectedFields.includes('Reports') && !selectedFields.includes('API Log'))
  assert.deepEqual(Object.keys(catalog[0]).sort(), ['fields', 'id'])
  for (const field of ['Reports', 'API Log', 'Internal notes']) assert.ok(!(field in catalog[0].fields))

  assert.deepEqual(
    (await fetchList('type=BOXING&daysOfWeek=Monday&intensity=moderate')).map(record => record.id),
    [ACTIVITY_ID],
  )
  assert.deepEqual((await fetchList('intensity=High')).map(record => record.id), [])
  assert.deepEqual((await fetchList('type=Events&daysOfWeek=Monday')).map(record => record.id), [EVENT_ID])

  const response = await detail.onRequestGet({
    request: new Request(detailUrl), env: ACTIVITY_ENV, params: { id: ACTIVITY_ID },
  })
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), catalog[0])
  assert.equal(calls.length, 3, 'the raw detail cache key is bypassed')
  assert.ok(calls.at(-1).searchParams.get('filterByFormula').includes(`RECORD_ID() = '${ACTIVITY_ID}'`))
  const other = await detail.onRequestGet({ env: ACTIVITY_ENV, params: { id: OTHER_ACTIVITY_ID } })
  assert.equal(other.status, 404, 'only a matching Active Activity record can be returned')
})

test('projection remains enforced if an older Airtable schema rejects the requested field list', async (t) => {
  setup(t)
  const detail = await load('functions/api/activity/[id].js')
  let requests = 0
  globalThis.fetch = async (input) => {
    requests++
    const url = new URL(input)
    if (url.searchParams.has('fields[]')) {
      return Response.json({ error: { type: 'UNKNOWN_FIELD_NAME' } }, { status: 422 })
    }
    return Response.json({ records: [{
      id: ACTIVITY_ID, fields: { Status: 'Active', 'Activity Name': 'Boxing', 'Internal notes': 'Private' },
    }] })
  }
  const response = await detail.onRequestGet({ env: ACTIVITY_ENV, params: { id: ACTIVITY_ID } })
  assert.equal(response.status, 200)
  assert.equal(requests, 2)
  assert.deepEqual(await response.json(), {
    id: ACTIVITY_ID, fields: { Status: 'Active', 'Activity Name': 'Boxing' },
  })
})

const validSubmission = {
  name: 'Chair yoga',
  activityTypes: ['Yoga'],
  description: 'A gentle seated class for all levels.',
  format: 'Virtual',
}

const formContext = (path, value, { ip, env = ACTIVITY_ENV } = {}) => ({
  request: new Request(`https://mnparkinsons.org/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(ip ? { 'CF-Connecting-IP': ip } : {}) },
    body: JSON.stringify(value),
  }),
  env,
})

test('submissions require real event dates and store every selected approved type with strict Airtable writes', async (t) => {
  setup(t)
  const submit = await load('functions/api/submit.js')
  const writes = []
  globalThis.fetch = async (_url, init) => {
    writes.push(JSON.parse(init.body))
    return Response.json({ records: [] })
  }
  const post = changes => submit.onRequestPost(formContext('submit', { ...validSubmission, ...changes }, { env: ENV }))
  assert.equal((await post({ activityTypes: ['Events'] })).status, 400)
  assert.equal((await post({ startDate: '2026-02-30' })).status, 400)
  assert.equal((await post({ activityTypes: ['Yoga', 'Unknown Activity Type'] })).status, 400)
  assert.equal((await post({ website: 'example' })).status, 400)
  assert.deepEqual(writes, [])

  const registrationLink = 'https://signup.example.org/form?replyTo=team@example.org'
  assert.equal((await post({
    activityTypes: APPROVED_FILTER_OPTIONS.activityType,
    startDate: '2028-02-29',
    registrationLink,
    address: 'Old physical address',
    zip: '55101',
  })).status, 201)
  assert.equal(writes.length, 1)
  assert.ok(!writes[0].typecast)
  const { fields } = writes[0].records[0]
  assert.deepEqual(fields['Activity Type'], APPROVED_FILTER_OPTIONS.activityType)
  assert.equal(fields['Registration Link'], registrationLink)
  assert.equal(fields['Activity Zip Code'], 'Virtual')
  assert.ok(!('Address' in fields))
})

test('the submit and filter endpoints share live choices and exclude submission-only choices from public options', async (t) => {
  setup(t)
  const submit = await load('functions/api/submit.js')
  const filters = await load('functions/api/filter-options.js')
  const env = { ...ACTIVITY_ENV, AIRTABLE_BASE_ID: 'appSchema' }
  const choiceTable = (id, choices) => ({
    id,
    fields: [{ name: 'Activity Type', type: 'multipleSelects', options: { choices: choices.map(name => ({ name })) } }],
  })
  let schemaReads = 0
  let writes = 0
  globalThis.fetch = async (url, init) => {
    if (new URL(url).pathname.includes('/meta/')) {
      schemaReads++
      return Response.json({ tables: [
        choiceTable(env.AIRTABLE_TABLE_ID, ['New Movement Class', 'Activities only']),
        choiceTable(SUBMISSIONS_TABLE_ID, ['New Movement Class', 'Submissions only']),
      ] })
    }
    writes++
    assert.deepEqual(JSON.parse(init.body).records[0].fields['Activity Type'], ['New Movement Class'])
    return Response.json({ records: [] })
  }
  const options = await filters.onRequestGet({ env })
  assert.deepEqual((await options.json()).activityType, ['New Movement Class', 'Activities only'])
  const formOptions = await filters.onRequestGet({
    env, request: new Request('https://mnparkinsons.org/api/filter-options?purpose=submit'),
  })
  assert.deepEqual(await formOptions.json(), { activityType: ['New Movement Class'] })
  const post = activityType => submit.onRequestPost(formContext(
    'submit', { ...validSubmission, activityTypes: [activityType] }, { env },
  ))
  assert.equal((await post('New Movement Class')).status, 201)
  assert.equal((await post('Submissions only')).status, 400)
  assert.equal((await post('Activities only')).status, 400)
  assert.equal(schemaReads, 1)
  assert.equal(writes, 1)
})

test('reports reject invalid JSON and rate-limit before making the Airtable lookup', async (t) => {
  setup(t)
  const report = await load('functions/api/report.js')
  let calls = 0
  globalThis.fetch = async (input, init) => {
    calls++
    if (init.method === 'POST') return Response.json({ records: [] })
    assert.deepEqual(new URL(input).searchParams.getAll('fields[]'), ['Activity Name', 'Status'])
    return Response.json({ records: [{ id: ACTIVITY_ID, fields: { Status: 'Active', 'Activity Name': 'Example' } }] })
  }
  const send = data => report.onRequestPost(formContext('report', data, { ip: '198.51.100.93' }))
  assert.equal((await send(null)).status, 400)
  assert.equal((await send({ activityId: ACTIVITY_ID, message: '🧪'.repeat(2600) })).status, 413)
  assert.equal(calls, 0)
  const statuses = await Promise.all(Array.from({ length: 12 }, async () =>
    (await send({ activityId: ACTIVITY_ID, message: 'The meeting time has changed.' })).status
  ))
  assert.equal(statuses.filter(status => status === 201).length, 10)
  assert.equal(statuses.filter(status => status === 429).length, 2)
  assert.equal(calls, 20)
})

test('the form routes surface Airtable quota responses as retryable service busy responses', async (t) => {
  setup(t)
  const report = await load('functions/api/report.js')
  const submit = await load('functions/api/submit.js')
  globalThis.fetch = async () => Response.json({}, { status: 429, headers: { 'Retry-After': '31' } })
  const reportResponse = await report.onRequestPost(formContext('report', {
    activityId: ACTIVITY_ID, message: 'The meeting time has changed.',
  }))
  const submitResponse = await submit.onRequestPost(formContext('submit', validSubmission, { env: ENV }))
  for (const response of [reportResponse, submitResponse]) {
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('Retry-After'), '31')
  }
})

test('an unavailable required gateway returns service busy instead of an address-quota error', async (t) => {
  const { air } = setup(t)
  const report = await load('functions/api/report.js')
  const submit = await load('functions/api/submit.js')
  const ip = '198.51.100.153'
  const env = { ...ACTIVITY_ENV, AIRTABLE_GATE_REQUIRED: 'true' }
  const responses = await Promise.all([
    report.onRequestPost(formContext('report', {
      activityId: ACTIVITY_ID, message: 'The meeting time has changed.',
    }, { ip, env })),
    submit.onRequestPost(formContext('submit', validSubmission, { ip, env })),
  ])
  for (const response of responses) {
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('Retry-After'), '5')
  }
  assert.equal(air.calls.length, 0)
})
