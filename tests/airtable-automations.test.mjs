import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const load = async name => new AsyncFunction('base', 'input', 'fetch', await readFile(
  new URL(`../airtable-automation/${name}.js`, import.meta.url), 'utf8'
))

function activities(initial) {
  const fields = { ...initial }
  const writes = []
  return {
    fields,
    writes,
    base: { getTable: () => ({
      async selectRecordAsync() {
        const current = { ...fields }
        return {
          getCellValue: name => current[name] ?? null,
          getCellValueAsString: name => String(current[name] ?? ''),
        }
      },
      async updateRecordAsync(id, patch) {
        writes.push({ id, patch })
        Object.assign(fields, patch)
      },
    }) },
    input: { config: () => ({ recordId: 'activity', refresh: 'yes' }) },
  }
}

test('the Airtable weekday automation expands ranges and uses Event dates', async () => {
  const run = await load('activity-weekdays')
  const week = activities({ Schedule: 'Training sessions are available Monday - Friday 7:30am - 2:30pm' })
  await run(week.base, week.input)
  assert.deepEqual(week.fields['Days of Week'].map(day => day.name), ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'])

  const event = activities({ Schedule: '1 to 3 PM', 'Activity Type': [{ name: 'Events' }], 'Start Date': '2026-11-28', 'End Date': '2026-11-30' })
  await run(event.base, event.input)
  assert.deepEqual(event.fields['Days of Week'].map(day => day.name), ['Monday', 'Saturday', 'Sunday'])

  const manual = activities({ Schedule: 'First Saturday and third Tuesday', 'Days of Week': [{ name: 'Tuesday' }] })
  await run(manual.base, manual.input)
  assert.deepEqual(manual.writes, [])
  manual.fields.Schedule = 'Monday at 3 PM; office hours Tuesday - Thursday'
  await run(manual.base, manual.input)
  assert.deepEqual(manual.writes, [])
})

test('the geocoding automation drops stale answers and replaces obsolete pins', async () => {
  const run = await load('geocode')
  const activity = activities({ Address: 'Original address', Status: 'Active', Latitude: 45, Longitude: -93 })
  const match = () => Response.json({ result: { addressMatches: [{ coordinates: { x: -91, y: 44 } }] } })
  await run(activity.base, activity.input, async () => {
    activity.fields.Address = 'New address'
    return match()
  })
  assert.deepEqual(activity.writes, [])
  await run(activity.base, activity.input, async () => match())
  assert.equal(activity.fields.Latitude, 44)
  assert.equal(activity.fields.Longitude, -91)
  assert.ok(activity.fields['Geocoded At'])

  activity.fields.Address = 'Virtual'
  await run(activity.base, activity.input, async () => assert.fail('online activities need no address lookup'))
  assert.equal(activity.fields.Latitude, null)
  assert.equal(activity.fields.Longitude, null)
})
