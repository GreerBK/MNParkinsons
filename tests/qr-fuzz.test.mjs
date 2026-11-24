// Randomized check of functions/q/[code].js. Run with:  npm test
//
// The scenario tests in qr-redirect.test.mjs each pin down one behaviour. This
// one throws random trouble at the route instead: scans in bursts and
// trickles while Airtable fails in random ways (errors, dropped connections,
// hangs, rate limits, refused rows, writes cut off half-way). Whatever
// happens, two things must hold once Airtable has recovered and a little
// later traffic has come by: every person's scan is stored exactly once or
// counted in a NOT RECORDED row, and the run finishes (nothing spins or
// hangs). Each seed is a different, repeatable run.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CODES, SCANS, load, setup, visit } from './harness.mjs'

const Q = 'functions/q/[code].js'
const SEEDS = Number(process.env.FUZZ_SEEDS || 10)
const FIRST = Number(process.env.FUZZ_FIRST || 1)

// A small seeded generator, so a failing seed can be run again.
function generator(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const ip = (n) => `198.${51 + Math.floor(n / 62500)}.${Math.floor(n / 250) % 250}.${(n % 250) + 1}`

for (let seed = FIRST; seed < FIRST + SEEDS; seed++) {
  test(`random trouble, seed ${seed}: every scan is stored once or counted`, async (t) => {
    const random = generator(seed)
    const { air, advance } = setup(t)
    // The route's own random delays get real variety too (the harness pins them to zero).
    t.mock.method(Math, 'random', () => random())
    const route = await load(Q)
    air.addCode('poster', { destination: '#/submit' })
    const codes = ['poster']
    if (random() < 0.5) codes.push('brand-new') // sometimes a code that has to be registered first

    // How Airtable misbehaves in this run.
    const writesFailing = random() < 0.3 ? 0 : random() * 0.5
    const readsFailing = random() < 0.5 ? 0 : random() * 0.3
    const kinds = ['502', '503', 'dropped', 'hang', '429', '422', 'cut off'].filter(() => random() < 0.6)
    if (!kinds.length) kinds.push('503')
    let trouble = true
    let lockouts = 0
    air.respond = (call) => {
      if (!trouble) return null
      const share = call.table === SCANS ? writesFailing : call.table === CODES ? readsFailing : 0
      if (random() >= share) return null
      const kind = kinds[Math.floor(random() * kinds.length)]
      if (kind === '429') return ++lockouts <= 2 ? { status: 429 } : null
      if (kind === '502') return { status: 502 }
      if (kind === '503') return { status: 503 }
      if (kind === '422') return call.table === SCANS ? { status: 422 } : null
      if (kind === 'dropped') return { error: true }
      // A call that never settles and cannot be cancelled is what a request
      // looks like once Cloudflare has stopped running it. On a write, that
      // is the writer being cut off, and the next writer must own up to its
      // rows. On a lookup it would mean the visitor's own request is gone,
      // which loses that one scan by nature, so lookups just hang.
      if (kind === 'cut off') return call.table === SCANS ? { hang: true, deaf: true } : { hang: true }
      return { hang: true }
    }

    let people = 0
    const scan = (code) => {
      const n = people++
      visit(route, code, { ip: ip(seed * 1000 + n), cf: { city: `scan-${n}`, region: 'Minnesota', country: 'US' } })
    }

    // Three minutes of scans at a random pace, in bursts and trickles.
    const pace = 150 + Math.floor(random() * 2500)
    for (let clock = 0; clock < 180000 && people < 450; ) {
      const burst = random() < 0.1 ? 1 + Math.floor(random() * 25) : 1
      for (let i = 0; i < burst; i++) scan(codes[Math.floor(random() * codes.length)])
      const gap = Math.max(50, Math.floor(pace * (0.2 + random() * 1.6)))
      await advance(gap, Math.min(gap, 100))
      clock += gap
    }

    // Airtable recovers. Light traffic for 35 minutes writes what is waiting and owed.
    trouble = false
    for (let i = 0; i < 70; i++) {
      scan('poster')
      await advance(30000, 500)
    }
    await advance(60000, 500)

    const rows = air.scans.filter((row) => row.fields['QR Code'])
    const tags = rows.map((row) => row.fields.City)
    assert.equal(new Set(tags).size, tags.length, 'no scan is stored twice')
    const noted = air.markers().reduce((sum, row) => sum + Number(/about (\d+) scan/.exec(row.fields.Scan)[1]), 0)
    assert.equal(
      rows.length + noted,
      people,
      `stored ${rows.length} + noted ${noted} of ${people} scans; notes: ${air.markers().map((row) => row.fields.Scan).join(' | ')}`
    )
    assert.equal(air.rowsFor('poster').length, 1)
    assert.ok(air.rowsFor('brand-new').length <= 1, 'a new code gets one row')
  })
}
