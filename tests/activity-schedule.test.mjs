import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { centralCalendarDate, getActivityWeekdays, isDateOnly, parseWeeklySchedule } from '../src/activitySchedule.js'

test('weekday ranges match every day between the endpoints and retain the source wording', () => {
  const schedule = 'Training sessions are available Monday - Friday 7:30am - 2:30pm'
  const days = getActivityWeekdays({ Schedule: schedule, 'Days of Week': ['Monday', 'Friday'] })
  assert.deepEqual(new Set(days), new Set(['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday']))
  assert.equal(parseWeeklySchedule(schedule), null)
  assert.deepEqual(getActivityWeekdays({ Schedule: 'Fri through Mon 3 PM' }), ['Friday', 'Saturday', 'Sunday', 'Monday'])
})

test('noon keeps its own day and qualifiers keep their source context', () => {
  assert.deepEqual(parseWeeklySchedule('Monday: Noon; Tuesday: 3 PM'), [
    { day: 'Monday', times: ['Noon'] },
    { day: 'Tuesday', times: ['3 PM'] },
  ])
  assert.equal(parseWeeklySchedule('Mondays: 3 PM, registration required'), null)
  assert.equal(parseWeeklySchedule('First Monday of the month: 3 PM'), null)
  assert.deepEqual(
    getActivityWeekdays({ Schedule: 'Monday through Friday except Thursday', 'Days of Week': ['Monday', 'Tuesday'] }),
    ['Monday', 'Tuesday'],
  )
  assert.deepEqual(
    getActivityWeekdays({ Schedule: 'Monday at 3 PM; office hours Tuesday - Thursday', 'Days of Week': ['Monday'] }),
    ['Monday'],
  )
  assert.deepEqual(getActivityWeekdays({ Schedule: 'Mon, Wed and Fri' }), ['Monday', 'Wednesday', 'Friday'])
})

test('event dates override manual chips and weekday filters use remaining days', () => {
  const fields = {
    'Activity Type': ['Events'],
    'Days of Week': ['Wednesday'],
    'Start Date': '2026-11-20',
    'End Date': '2026-11-23',
  }
  assert.deepEqual(getActivityWeekdays(fields, '2026-11-21'), ['Saturday', 'Sunday', 'Monday'])
  assert.deepEqual(getActivityWeekdays(fields, '2026-11-24'), [])
  assert.deepEqual(getActivityWeekdays({ ...fields, 'Start Date': '' }, '2026-11-21'), [])
  assert.deepEqual(getActivityWeekdays({
    ...fields, 'Start Date': '2026-11-23', 'End Date': '',
  }, '2026-11-21'), ['Monday'])
})

test('event dates are real dates and the calendar rolls over in Central time', () => {
  assert.equal(isDateOnly('2028-02-29'), true)
  assert.equal(isDateOnly('2026-02-29'), false)
  assert.equal(isDateOnly('2026-11-31'), false)
  assert.equal(centralCalendarDate(new Date('2026-11-24T05:59:00Z')), '2026-11-23')
  assert.equal(centralCalendarDate(new Date('2026-11-24T06:00:00Z')), '2026-11-24')
})
