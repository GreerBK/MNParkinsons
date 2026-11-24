import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { AirtableGateway } from '../airtable-gateway/index.js'
import {
  airtableFetch,
  claimAirtableAction,
  publishAirtableQrObservation,
  readAirtableQrObservation,
} from '../functions/_shared/airtable.js'

const BASE_ID = 'appABCDEFGHIJKLMN'
const UPSTREAM = `https://api.airtable.com/v0/${BASE_ID}/tblABCDEFGHIJKLMN`
const INIT = { headers: { Authorization: 'Bearer test-token' } }
const tick = () => new Promise(resolve => setImmediate(resolve))

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1760000000000 })
  const database = new DatabaseSync(':memory:')
  t.after(() => database.close())
  const values = new Map()
  const storage = {
    kv: { get: key => values.get(key), put: (key, value) => values.set(key, value) },
    sql: { exec(sql, ...bindings) {
      const statement = database.prepare(sql)
      if (sql.startsWith('SELECT')) return statement.all(...bindings)
      statement.run(...bindings)
      return []
    } },
    transactionSync(run) {
      database.exec('BEGIN')
      try {
        const result = run()
        database.exec('COMMIT')
        return result
      } catch (error) {
        database.exec('ROLLBACK')
        throw error
      }
    },
  }
  const gateway = new AirtableGateway({ storage })
  const makeEnvironment = () => ({
    AIRTABLE_BASE_ID: BASE_ID,
    AIRTABLE_GATE: {
      idFromName: name => name,
      get(name) {
        assert.equal(name, BASE_ID)
        return { fetch: (url, init) => gateway.fetch(new Request(url, init)) }
      },
    },
  })
  return { makeEnvironment }
}

test('separate Pages instances share the same paced Airtable allowance', async t => {
  const { makeEnvironment } = setup(t)
  const sentAt = []
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(url.href, UPSTREAM)
    assert.equal(init.headers.get('Authorization'), 'Bearer test-token')
    sentAt.push(Date.now())
    return Response.json({ records: [] })
  })

  const requests = Array.from({ length: 6 }, () => airtableFetch(makeEnvironment(), UPSTREAM, INIT))
  const lowPriority = await airtableFetch(makeEnvironment(), UPSTREAM, INIT, { maxQueueMs: 300 })
  assert.equal(lowPriority.status, 503)
  assert.equal(lowPriority.headers.get('X-Airtable-Request-Sent'), 'false')
  for (let i = 0; i < 6; i++) {
    t.mock.timers.tick(260)
    await tick()
  }
  const responses = await Promise.all(requests)
  assert.deepEqual(responses.map(response => response.status), Array(6).fill(200))
  assert.deepEqual(responses.map(response => Number(response.headers.get('X-Airtable-Dispatch-Ms'))), sentAt)
  assert.deepEqual(sentAt.slice(1).map((at, index) => at - sentAt[index]), Array(5).fill(260))
})

test('an Airtable 429 pauses the entire base and signals unsent requests', async t => {
  const { makeEnvironment } = setup(t)
  const send = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 429 }))
  const initial = await airtableFetch(makeEnvironment(), UPSTREAM, INIT)
  assert.equal(initial.status, 429)
  const blocked = await airtableFetch(makeEnvironment(), UPSTREAM, INIT)
  assert.equal(blocked.status, 503)
  assert.equal(blocked.headers.get('Retry-After'), '31')
  assert.equal(blocked.headers.get('X-Airtable-Request-Sent'), 'false')
  assert.equal(send.mock.callCount(), 1)

  t.mock.timers.tick(31000)
  assert.equal((await airtableFetch(makeEnvironment(), UPSTREAM, INIT)).status, 429)
  assert.equal(send.mock.callCount(), 2)
})

test('registration and form claims are atomic between instances and expire', async t => {
  const { makeEnvironment } = setup(t)
  const lease = () => claimAirtableAction(makeEnvironment(), 'qr-creation', 'flyer', 30000)
  const form = () => claimAirtableAction(makeEnvironment(), 'report', 'hashed-address', 60000, 2)
  assert.equal((await Promise.all([lease(), lease(), lease()])).filter(Boolean).length, 1)
  assert.equal((await Promise.all([form(), form(), form()])).filter(Boolean).length, 2)
  t.mock.timers.tick(30000)
  assert.equal(await lease(), true)
  assert.equal(await form(), false)
  t.mock.timers.tick(30000)
  assert.equal(await form(), true)
})

test('a slower, older QR lookup cannot overwrite a newer shared observation', async t => {
  const { makeEnvironment } = setup(t)
  const now = Date.now()
  const observed = (entry, started) => ({ entry, at: Date.now(), life: 0, started })
  const latest = observed({ id: 'recABCDEFGHIJKLMN', destination: '#/submit' }, now)
  assert.deepEqual(await publishAirtableQrObservation(makeEnvironment(), 'poster', latest, 60), latest)
  t.mock.timers.tick(2000)
  const earlier = observed(null, now - 1500)
  assert.deepEqual(await publishAirtableQrObservation(makeEnvironment(), 'poster', earlier, 60), latest)
  assert.deepEqual(await readAirtableQrObservation(makeEnvironment(), 'poster'), latest)
  t.mock.timers.tick(58000)
  assert.equal(await readAirtableQrObservation(makeEnvironment(), 'poster'), undefined)
})

test('a missing required gateway fails closed', async () => {
  const env = { AIRTABLE_GATE_REQUIRED: 'true', AIRTABLE_BASE_ID: BASE_ID }
  assert.equal((await airtableFetch(env, UPSTREAM, INIT)).status, 503)
  assert.equal(await claimAirtableAction(env, 'report', 'hashed-address', 60000), undefined)
})
