// Airtable Run a script action. Pass recordId from either an Activities
// record-created trigger or a trigger watching Schedule, Activity Type,
// Start Date and End Date. Only this record is updated.

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
const DAY = 'monday|tuesday|wednesday|thursday|friday|saturday|sunday|tues|thurs|thur|mon|tue|wed|thu|fri|sat|sun'
const DAY_WORD = `\\b(?:${DAY})s?\\b`
const DAY_LIST = `${DAY_WORD}(?:\\s*(?:,|&|\\band\\b)\\s*${DAY_WORD})*`
const SEPARATOR = String.raw`(?:\s*[:,]\s*|\s+)(?:at\s+)?`
const TIME = String.raw`(?:noon|midnight|(?:[01]?\d|2[0-3])(?::[0-5]\d)?\s*(?:[ap]\.?m\.?)?)`
const SESSION = new RegExp(`^${TIME}(?:\\s*(?:to|[-–—])\\s*${TIME})?$`, 'i')
const DAY_GROUP = new RegExp(`^(${DAY_LIST})${SEPARATOR}(.+)$`, 'i')
const BARE_DAYS = new RegExp(`^${DAY_LIST}$`, 'i')
const AVAILABILITY = String.raw`(?:(?:classes?|(?:training )?sessions?)\s+(?:are (?:available|offered|held)|meet|run)\s+)?`
const RANGE = new RegExp(`^${AVAILABILITY}(${DAY_WORD})\\.?\\s*(?:to|through|thru|[-–—])\\s*(${DAY_WORD})\\.?(?:${SEPARATOR}(.+))?$`, 'i')
const QUALIFIED = /\b(?:[1-5](?:st|nd|rd|th)|first|second|third|fourth|fifth|last|bi-?weekly|months?|monthly|every other|except|excluding)\b/i
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/

function dayIndex(day) {
  return DAYS.findIndex(name => name.slice(0, 3).toLowerCase() === day.slice(0, 3).toLowerCase())
}

function scheduleDays(schedule) {
  const text = schedule.trim()
  if (!text || QUALIFIED.test(text)) return []
  const days = new Set()
  const addDays = names => {
    for (const name of names.match(new RegExp(DAY_WORD, 'gi')) || []) days.add(dayIndex(name))
  }
  const range = text.match(RANGE)
  if (BARE_DAYS.test(text)) {
    addDays(text)
  } else if (range && (!range[3] || SESSION.test(range[3]))) {
    const first = dayIndex(range[1])
    const last = dayIndex(range[2])
    for (let i = 0; i <= (last - first + 7) % 7; i++) days.add((first + i) % 7)
  } else {
    for (const chunk of text.split(/[;\n]+/).map(part => part.trim()).filter(Boolean)) {
      const entry = chunk.match(DAY_GROUP)
      const times = (entry ? entry[2] : chunk).split(',').map(part => part.trim())
      if (!times.every(part => SESSION.test(part) && /:|[ap]\.?m\.?|noon|midnight/i.test(part))) return []
      if (entry) addDays(entry[1])
      else if (!days.size) return []
    }
  }
  return DAYS.filter((_, i) => days.has(i))
}

function parseDate(value) {
  if (typeof value !== 'string' || !DATE_ONLY.test(value)) return null
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null
}

function eventDays(start, end) {
  const first = parseDate(start)
  if (!first) return []
  const last = parseDate(end)
  const count = last && last >= first ? Math.min(7, (last - first) / 86400000 + 1) : 1
  const startIndex = (first.getUTCDay() + 6) % 7
  return DAYS.filter((_, index) => (index - startIndex + 7) % 7 < count)
}

async function syncDays(table, recordId) {
  if (!recordId) return
  const fields = ['Schedule', 'Days of Week', 'Activity Type', 'Start Date', 'End Date']
  const row = await table.selectRecordAsync(recordId, { fields })
  if (!row) return
  const types = row.getCellValue('Activity Type') || []
  const days = types.some(option => option.name === 'Events')
    ? eventDays(row.getCellValue('Start Date'), row.getCellValue('End Date'))
    : scheduleDays(row.getCellValueAsString('Schedule'))
  // Preserve manually selected weekdays when the schedule is ambiguous.
  if (!days.length) return
  const current = (row.getCellValue('Days of Week') || []).map(option => option.name)
  if (days.length === current.length && days.every(day => current.includes(day))) return
  await table.updateRecordAsync(recordId, { 'Days of Week': days.map(name => ({ name })) })
}

const { recordId } = input.config()
await syncDays(base.getTable('Activities'), recordId)
